import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { PassThrough, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import yauzl from 'yauzl'
import { crc32 } from 'node:zlib'
import SteamUser from 'steam-user'
import { ArchiveEntries } from '../../backup/archive-entries.ts'
import { atomicCacheWrite, fileMatches, WorkshopChunkCache, DownloadSlots } from './workshop-cache.mjs'
import { WorkshopTransport, retrySteamOperation } from './workshop-transport.mjs'
import { abortable } from '../../../shared/abort.ts'
import { assertFreeSpace } from './mod-content.ts'

const limits = { maxEntries: 100_000, maxTotalUncompressedBytes: 4 * 1024 ** 3 }
const sizeMatches = (file, size) => {
  try { const stat = fs.lstatSync(file); return stat.isFile() && stat.size === size }
  catch { return false }
}
const nextEntry = zip => new Promise((resolve, reject) => {
  const clean = () => zip.off('entry', entry).off('end', end).off('error', error)
  const entry = value => { clean(); resolve(value) }
  const end = () => { clean(); resolve(null) }
  const error = value => { clean(); reject(value) }
  zip.once('entry', entry).once('end', end).once('error', error)
  zip.readEntry()
})

// Range metadata gives the uncompressed total before transferring ZIP entries.
class RemoteZipReader extends yauzl.RandomAccessReader {
  constructor(url, totalSize, signal, transport, onBytes) { super(); this.url = url; this.totalSize = totalSize; this.signal = signal; this.ranges = []; this.cacheBytes = 0; this.transport = transport; this.onBytes = onBytes }
  _readStreamForRange(start, end) {
    const stream = new PassThrough()
    const cached = this.ranges.find(range => range.start <= start && range.end >= end)
    if (cached) { queueMicrotask(() => stream.end(cached.data.subarray(start - cached.start, end - cached.start))); return stream }
    const controller = new AbortController()
    const signal = AbortSignal.any([this.signal, controller.signal, AbortSignal.timeout(30_000)])
    stream.once('close', () => controller.abort())
    void (async () => {
      if (end - start <= 65557 && this.cacheBytes + end - start <= 1024 * 1024) {
        const { bytes: data } = await this.transport.range(this.url, { start, end, totalSize: this.totalSize }, signal, undefined, this.onBytes)
        if (data.length !== end - start) throw new Error('Legacy range length mismatch')
        this.ranges.push({ start, end, data })
        this.cacheBytes += data.length
        stream.end(data)
        return
      }
      await this.transport.range(this.url, { start, end, totalSize: this.totalSize }, signal, stream, this.onBytes)
    })().catch(error => stream.destroy(error))
    return stream
  }
}

export function createWorkshopSession(options) {
  const client = new SteamUser({ dataDirectory: null, autoRelogin: false, enablePicsCache: false,
    protocol: SteamUser.EConnectionProtocol.WebSocket, ...(options.httpProxy ? { httpProxy: options.httpProxy } : {}) })
  const controller = new AbortController()
  client.on('error', error => controller.abort(error))
  const ready = once(client, 'loggedOn').then(() => undefined)
  void ready.catch(() => {})
  client.logOn({ anonymous: true })
  const transport = new WorkshopTransport(client, options)
  return { client, transport, ready, signal: controller.signal, slots: new DownloadSlots(8), reservedBytes: 0,
    close() { controller.abort(new Error('Steam session closed')); transport.save(); client.logOff() } }
}

function validateChunks(file) {
  let end = 0
  const chunks = (file.chunks || []).map(value => ({ ...value, offset: Number(value.offset), size: Number(value.cb_original), compressedSize: Number(value.cb_compressed) }))
    .sort((a, b) => a.offset - b.offset)
  for (const chunk of chunks) {
    if (!/^[a-f0-9]{40}$/.test(chunk.sha) || !Number.isSafeInteger(chunk.offset) || chunk.offset !== end ||
      !Number.isSafeInteger(chunk.size) || chunk.size <= 0 || chunk.size > 64 * 1024 ** 2 ||
      !Number.isSafeInteger(chunk.compressedSize) || chunk.compressedSize <= 0 || chunk.compressedSize > 64 * 1024 ** 2) throw new Error('Invalid Steam chunk layout')
    end += chunk.size
  }
  if (end !== file.size || !/^[a-f0-9]{40}$/.test(file.sha_content)) throw new Error('Invalid Steam file manifest')
  return chunks
}

function previousChunks(cacheRoot, id, existingRoot) {
  const sources = new Map()
  let installedManifest
  try { installedManifest = JSON.parse(fs.readFileSync(path.join(existingRoot, id, '.bsp-workshop-download.json'), 'utf8')).manifestId }
  catch { /* Older installations have no saved manifest. */ }
  const directory = path.join(cacheRoot, 'manifests', id)
  let records = []
  try { records = fs.readdirSync(directory).filter(name => /^\d+\.json$/.test(name)).map(name => ({ name, used: fs.statSync(path.join(directory, name)).mtimeMs })).sort((a, b) => b.used - a.used).slice(0, 3) }
  catch { /* First download. */ }
  for (const { name } of records) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
      for (const file of manifest.files) {
        if (file.flags & 64 || file.linktarget) continue
        const filename = file.filename.replace(/\\/g, '/')
        if (filename.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(filename) || /^[A-Za-z]:/.test(filename)) continue
        for (const chunk of file.chunks || []) {
          const key = `${chunk.sha}-${chunk.cb_original}`
          const values = sources.get(key) || []
          const offset = Number(chunk.offset)
          if (!Number.isSafeInteger(offset) || offset < 0) continue
          values.push({ file: path.join(cacheRoot, id, name.slice(0, -5), 'content', filename), offset })
          if (existingRoot && name === `${installedManifest}.json`) values.push({ file: path.join(existingRoot, id, filename), offset })
          sources.set(key, values)
        }
      }
    }
    catch { /* Cached metadata is advisory; the target hash remains authoritative. */ }
  }
  return sources
}

export async function downloadWorkshopContent({ ids, cacheRoot, existingRoot, legacyCacheRoot, signal = new AbortController().signal,
  onEvent = () => {}, httpProxy, noProxy, session: provided }) {
  const session = provided || createWorkshopSession({ cacheRoot, httpProxy, noProxy })
  const combined = session.signal ? AbortSignal.any([signal, session.signal]) : signal
  const results = []
  let preparationStage = 'connection'
  try {
    const connectionStarted = performance.now()
    combined.throwIfAborted()
    await abortable(session.ready, combined)
    const connectionMs = performance.now() - connectionStarted
    preparationStage = 'metadata'
    const metadataStarted = performance.now()
    const { files: metadata } = await retrySteamOperation(() => session.client.getPublishedFileDetails(ids), combined)
    const metadataMs = performance.now() - metadataStarted
    preparationStage = 'content'
    for (const id of ids) {
      let zip
      let phase = 'metadata'
      const started = performance.now()
      let receivedBytes = 0
      let totalBytes = 0
      let downloadedBytes = 0
      let reusedBytes = 0
      let reservation = 0
      const timings = { connectionMs, metadataMs }
      const emit = value => onEvent({ workshopId: id, phase: value, reusedBytes,
        progress: { downloadedBytes, totalBytes, percent: totalBytes ? Math.min(100, downloadedBytes * 100 / totalBytes) : 100 } })
      try {
        combined.throwIfAborted()
        if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error('Invalid Workshop ID')
        onEvent({ workshopId: id, phase: 'preparing_download', progress: null })
        const item = metadata[id]
        if (item?.result !== 1 || item.consumer_appid !== 322330 || !/^\d+$/.test(item.hcontent_file) || !Number.isFinite(Number(item.time_updated))) throw new Error('Invalid DST workshop metadata')
        const root = path.join(cacheRoot, id, item.hcontent_file, 'content')
        const partialRoot = path.join(cacheRoot, id, item.hcontent_file, 'partial')
        fs.mkdirSync(root, { recursive: true })
        const validator = new ArchiveEntries(root, limits)
        let manifest
        let files
        phase = 'manifest'
        if (item.file_url) {
          const size = Number(item.file_size)
          if (!Number.isSafeInteger(size) || size <= 0 || size > limits.maxTotalUncompressedBytes) throw new Error('Invalid legacy archive size')
          const url = new URL(item.file_url)
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid legacy archive URL')
          zip = await yauzl.fromRandomAccessReaderPromise(new RemoteZipReader(url.href, size, combined, session.transport, count => {
            receivedBytes += count
            onEvent({ workshopId: id, phase: 'activity' })
          }), size, { autoClose: false, strictFileNames: false })
          files = []
          let entry
          while ((entry = await nextEntry(zip))) {
            const directory = entry.fileName.endsWith('/')
            const kind = (entry.externalFileAttributes >>> 16) & 0xf000
            if ((kind && kind !== (directory ? 0x4000 : 0x8000)) || (entry.generalPurposeBitFlag & 1)) throw new Error('Unsupported ZIP entry type')
            const target = validator.accept(entry.fileName, directory, entry.uncompressedSize)
            if (directory) { fs.mkdirSync(target, { recursive: true }); continue }
            files.push({ filename: entry.fileName, size: entry.uncompressedSize, target, entry })
          }
        }
        else {
          manifest = await session.transport.manifest(item.hcontent_file, combined)
          if (manifest.gid_manifest !== item.hcontent_file) throw new Error('Downloaded manifest identity mismatch')
          files = manifest.files.map(file => {
            const directory = Boolean(file.flags & 64)
            if ((file.flags & 512) || file.linktarget) throw new Error('Manifest symlinks are not supported')
            const filename = file.filename.replace(/\\/g, '/')
            const target = validator.accept(filename, directory, Number(file.size))
            if (directory) { fs.mkdirSync(target, { recursive: true }); return null }
            const value = { ...file, filename, size: Number(file.size), target }
            return { ...value, chunks: validateChunks(value) }
          }).filter(Boolean)
        }
        timings.manifestMs = performance.now() - started
        const check = async (file, filename) => {
          if (!sizeMatches(filename, file.size)) return false
          if (!file.entry) return fileMatches(filename, file.size, file.sha_content, combined)
          let crc = 0
          for await (const chunk of fs.createReadStream(filename, { signal: combined })) crc = crc32(chunk, crc)
          return crc === file.entry.crc32
        }
        phase = 'content'
        const cache = new WorkshopChunkCache(cacheRoot)
        const oldChunks = manifest ? previousChunks(cacheRoot, id, existingRoot) : new Map()
        const pending = []
        const missing = new Map()
        for (const file of files) {
          combined.throwIfAborted()
          if (await check(file, file.target)) { reusedBytes += file.size; continue }
          const candidates = [existingRoot && path.join(existingRoot, id, file.filename), legacyCacheRoot && path.join(legacyCacheRoot, id, item.hcontent_file, 'content', file.filename)].filter(Boolean)
          let copied = false
          for (const candidate of candidates) if (await check(file, candidate)) {
            fs.mkdirSync(path.dirname(file.target), { recursive: true })
            fs.copyFileSync(candidate, file.target)
            reusedBytes += file.size
            copied = true
            break
          }
          if (copied) continue
          pending.push(file)
          if (file.entry) { totalBytes += file.size; continue }
          for (const chunk of file.chunks) {
            const key = `${chunk.sha}-${chunk.size}`
            if (missing.has(key)) continue
            let present = await cache.has(chunk, combined)
            if (!present) for (const source of [...(oldChunks.get(key) || []), ...candidates.map(file => ({ file, offset: chunk.offset }))]) {
              if (await cache.seed(chunk, source.file, source.offset, combined)) { present = true; break }
            }
            if (present) reusedBytes += chunk.size
            else missing.set(key, chunk)
          }
        }
        totalBytes += [...missing.values()].reduce((sum, chunk) => sum + chunk.size, 0)
        const required = pending.reduce((sum, file) => sum + file.size, 0) + totalBytes
        assertFreeSpace(cacheRoot, required + (session.reservedBytes || 0))
        reservation = required
        session.reservedBytes = (session.reservedBytes || 0) + reservation
        emit('downloading')
        const transferStarted = performance.now()
        const slots = session.slots || new DownloadSlots(8)
        const chunkList = [...missing.values()]
        let next = 0
        let transferError
        const chunkWorker = async () => {
          while (next < chunkList.length && !transferError) {
            const chunk = chunkList[next++]
            try { await slots.run(combined, async () => {
              const bytes = await session.transport.chunk(chunk, combined, count => { receivedBytes += count; onEvent({ workshopId: id, phase: 'activity' }) })
              combined.throwIfAborted()
              cache.put(chunk, bytes)
              downloadedBytes += chunk.size
              emit('downloading')
            }) }
            catch (error) { transferError ||= error; throw error }
          }
        }
        const largestChunk = chunkList.reduce((max, chunk) => Math.max(max, chunk.size), 1)
        const parallelism = Math.min(8, Math.max(1, Math.floor(16 * 1024 ** 2 / largestChunk)))
        const transfers = await Promise.allSettled(Array.from({ length: Math.min(parallelism, chunkList.length) }, chunkWorker))
        const failed = transfers.find(value => value.status === 'rejected')
        if (failed) throw failed.reason
        for (const file of pending) {
          combined.throwIfAborted()
          fs.mkdirSync(path.dirname(file.target), { recursive: true })
          fs.mkdirSync(partialRoot, { recursive: true })
          const partial = path.join(partialRoot, createHash('sha256').update(file.filename).digest('hex'))
          if (file.entry) {
            let crc = 0
            let received = 0
            const checkStream = new Transform({ transform(chunk, _encoding, callback) {
              received += chunk.length
              if (received > file.size) return callback(new Error('ZIP size overflow'))
              crc = crc32(chunk, crc)
              callback(null, chunk)
            } })
            await pipeline(await zip.openReadStreamPromise(file.entry), checkStream, fs.createWriteStream(partial), { signal: combined })
            if (received !== file.size || crc !== file.entry.crc32) throw new Error('Legacy file checksum mismatch')
            downloadedBytes += received
            emit('downloading')
          }
          else {
            const output = await fs.promises.open(partial, 'w')
            try {
              for (const chunk of file.chunks) {
                combined.throwIfAborted()
                const bytes = await fs.promises.readFile(cache.filename(chunk))
                await output.writeFile(bytes)
              }
            }
            finally { await output.close() }
            if (!await check(file, partial)) throw new Error('Downloaded file checksum mismatch')
          }
          combined.throwIfAborted()
          fs.renameSync(partial, file.target)
        }
        timings.transferMs = performance.now() - transferStarted
        phase = 'verify'
        emit('verifying')
        const verifyStarted = performance.now()
        for (const file of files) if (!await check(file, file.target)) throw new Error('Final content verification failed')
        if (!files.some(file => file.filename === 'modinfo.lua' && file.size > 0)) throw new Error('Missing modinfo.lua')
        // A restarted attempt must not install files absent from the pinned manifest.
        const names = new Set(files.map(file => file.filename))
        const clean = directory => {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name)
            if (entry.isDirectory()) clean(target)
            else if (!entry.isFile() || !names.has(path.relative(root, target).split(path.sep).join('/'))) fs.rmSync(target, { force: true })
          }
        }
        clean(root)
        if (manifest) atomicCacheWrite(path.join(cacheRoot, 'manifests', id, `${item.hcontent_file}.json`), JSON.stringify(manifest))
        timings.verifyMs = performance.now() - verifyStarted
        const result = { workshopId: id, ok: true, sourceDir: root, manifestId: item.hcontent_file,
          updatedAt: new Date(Number(item.time_updated) * 1000).toISOString(), reusedBytes, totalBytes,
          diagnostics: { ...timings, elapsedMs: performance.now() - started, receivedBytes, node: session.transport.lastNode } }
        results.push(result)
        onEvent({ ...result, phase: 'verified' })
      }
      catch (error) {
        combined.throwIfAborted()
        const result = { workshopId: id, ok: false, error: String(error.message).replace(/https?:\/\/\S+/g, '[URL]'),
          failureStage: phase, errorCode: error.code || 'WORKSHOP_DOWNLOAD_FAILED',
          diagnostics: { ...timings, elapsedMs: performance.now() - started, receivedBytes } }
        results.push(result)
        onEvent(result)
      }
      finally { session.reservedBytes = Math.max(0, (session.reservedBytes || 0) - reservation); zip?.close() }
    }
    return results
  }
  catch (error) { error.failureStage ||= preparationStage; throw error }
  finally { if (!provided) session.close() }
}
