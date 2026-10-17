import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { PassThrough, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import yauzl from 'yauzl'
import { crc32 } from 'node:zlib'
import SteamUser from 'steam-user'
import Schema from 'steam-user/protobufs/generated/_load.js'
import { ArchiveEntries } from '../../backup/archive-entries.ts'

const limits = { maxEntries: 100_000, maxTotalUncompressedBytes: 4 * 1024 ** 3 }
const hashFile = async (file, algorithm = 'sha1') => {
  const hash = createHash(algorithm)
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
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
  constructor(url, totalSize, signal) { super(); this.url = url; this.totalSize = totalSize; this.signal = signal; this.ranges = []; this.cacheBytes = 0 }
  _readStreamForRange(start, end) {
    const stream = new PassThrough()
    const cached = this.ranges.find(range => range.start <= start && range.end >= end)
    if (cached) { queueMicrotask(() => stream.end(cached.data.subarray(start - cached.start, end - cached.start))); return stream }
    const controller = new AbortController()
    const signal = AbortSignal.any([this.signal, controller.signal, AbortSignal.timeout(30_000)])
    stream.once('close', () => controller.abort())
    void fetch(this.url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal }).then(async response => {
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end - 1}/${this.totalSize}`) {
        await response.body?.cancel()
        throw new Error('Legacy CDN did not return the requested byte range')
      }
      if (end - start <= 65557 && this.cacheBytes + end - start <= 1024 * 1024) {
        const data = Buffer.from(await response.arrayBuffer())
        if (data.length !== end - start) throw new Error('Legacy range length mismatch')
        this.ranges.push({ start, end, data })
        this.cacheBytes += data.length
        stream.end(data)
        return
      }
      await pipeline(response.body, stream)
    }).catch(error => stream.destroy(error))
    return stream
  }
}

export async function downloadWorkshopContent({ ids, cacheRoot, existingRoot, signal = new AbortController().signal, onEvent = () => {}, httpProxy }) {
  const client = new SteamUser({ dataDirectory: null, autoRelogin: false, enablePicsCache: false,
    protocol: SteamUser.EConnectionProtocol.WebSocket, ...(httpProxy ? { httpProxy } : {}) })
  const fatal = new Promise((_, reject) => client.on('error', reject))
  let serverCache
  const directory = cell => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDN directory timed out')), 10_000)
    client._send({ msg: 151, proto: { target_job_name: 'ContentServerDirectory.GetServersForSteamPipe#1' } },
      Schema.CContentServerDirectory_GetServersForSteamPipe_Request.encode({ cell_id: cell, max_servers: 40 }).finish(), (data, header) => {
        clearTimeout(timer)
        if (header.proto.eresult !== 1) return reject(new Error(`CDN directory result ${header.proto.eresult}`))
        const body = Schema.CContentServerDirectory_GetServersForSteamPipe_Response.decode(data.toBuffer ? data.toBuffer() : data)
        resolve(body.servers.filter(server => ['CDN', 'SteamCache'].includes(server.type))
          .filter(server => !server.allowed_app_ids?.length || server.allowed_app_ids.includes(322330))
          .filter(server => ['mandatory', 'optional'].includes(server.https_support))
          .map(server => ({ ...server, Host: server.host, https_support: 'mandatory' })))
      })
  })
  client.getContentServers = async () => {
    if (!serverCache) {
      serverCache = await directory(client.cellID || 0)
      // The regional directory can contain only unavailable HTTP caches. Ask the
      // same Steam directory for an alternate cell, retaining verified HTTPS.
      if (!serverCache.length) serverCache = await directory(5)
      if (!serverCache.length) throw new Error('No HTTPS Steam CDN servers available')
    }
    const servers = serverCache.map(server => ({ ...server }))
    while (servers.length < 4) servers.push({ ...servers[0] })
    return { servers }
  }
  const aborted = new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const results = []
  const run = async () => {
    const loggedOn = once(client, 'loggedOn')
    client.logOn({ anonymous: true })
    await loggedOn
    const { files: metadata } = await client.getPublishedFileDetails(ids)
    for (const id of ids) {
      signal.throwIfAborted()
      try {
        onEvent({ workshopId: id, phase: 'preparing_download', progress: null })
        const item = metadata[id]
        if (item?.result !== 1 || item.consumer_appid !== 322330 || !/^\d+$/.test(item.hcontent_file)) throw new Error('Invalid DST workshop metadata')
        const root = path.join(cacheRoot, id, item.hcontent_file, 'content')
        const partialRoot = path.join(cacheRoot, id, item.hcontent_file, 'partial')
        fs.mkdirSync(root, { recursive: true })
        const validator = new ArchiveEntries(root, limits)
        let zip
        let files
        try {
          if (item.file_url) {
            const size = Number(item.file_size)
            if (!Number.isSafeInteger(size) || size <= 0 || size > limits.maxTotalUncompressedBytes) throw new Error('Invalid legacy archive size')
            const url = new URL(item.file_url)
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid legacy archive URL')
            zip = await yauzl.fromRandomAccessReaderPromise(new RemoteZipReader(url.href, size, signal), size, { autoClose: false, strictFileNames: false })
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
            let manifest
            for (let attempt = 0; attempt < 3; attempt++) {
              try { ({ manifest } = await client.getManifest(322330, 322330, item.hcontent_file, 'public')); break }
              catch (error) { if (attempt === 2) throw error }
            }
            if (manifest.gid_manifest !== item.hcontent_file) throw new Error('Downloaded manifest identity mismatch')
            files = manifest.files.map(file => {
              const directory = Boolean(file.flags & 64)
              if ((file.flags & 512) || file.linktarget) throw new Error('Manifest symlinks are not supported')
              const filename = file.filename.replace(/\\/g, '/')
              const target = validator.accept(filename, directory, Number(file.size))
              if (directory) { fs.mkdirSync(target, { recursive: true }); return null }
              return { ...file, filename, size: Number(file.size), target }
            }).filter(Boolean)
          }
          const check = async (file, filename) => {
            if (!sizeMatches(filename, file.size)) return false
            if (file.entry) {
              let crc = 0
              for await (const chunk of fs.createReadStream(filename)) crc = crc32(chunk, crc)
              return crc === file.entry.crc32
            }
            return file.size === 0 || await hashFile(filename) === file.sha_content
          }
          const pending = []
          let reusedBytes = 0
          for (const file of files) {
            if (await check(file, file.target)) { reusedBytes += file.size; continue }
            const existing = existingRoot && path.join(existingRoot, id, ...file.filename.split('/'))
            if (existing && await check(file, existing)) {
              fs.mkdirSync(path.dirname(file.target), { recursive: true })
              fs.copyFileSync(existing, file.target)
              reusedBytes += file.size
              continue
            }
            pending.push(file)
          }
          const totalBytes = pending.reduce((sum, file) => sum + file.size, 0)
          let completed = 0
          const emit = (phase, current = 0) => onEvent({ workshopId: id, phase, reusedBytes,
            progress: { downloadedBytes: completed + current, totalBytes, percent: totalBytes ? Math.min(100, (completed + current) * 100 / totalBytes) : 100 } })
          emit('downloading')
          for (const file of pending) {
            signal.throwIfAborted()
            fs.mkdirSync(path.dirname(file.target), { recursive: true })
            // Valid files are reusable; interrupted files stay separate and never
            // count as verified cache or as bytes of a later attempt.
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
              await pipeline(await zip.openReadStreamPromise(file.entry), checkStream, fs.createWriteStream(partial), { signal })
              if (received !== file.size || crc !== file.entry.crc32) throw new Error('Legacy file checksum mismatch')
            }
            else {
              let received = 0
              await client.downloadFile(322330, 322330, file, partial, (error, event) => {
                if (signal.aborted || error || event?.type !== 'progress') return
                received = Math.max(received, Math.min(file.size, event.bytesDownloaded))
                emit('downloading', received)
              })
              if (!await check(file, partial)) throw new Error('Downloaded file checksum mismatch')
            }
            signal.throwIfAborted()
            fs.renameSync(partial, file.target)
            completed += file.size
            emit('downloading')
            onEvent({ workshopId: id, phase: 'checkpoint', completed, totalBytes })
          }
          emit('verifying')
          for (const file of files) if (!await check(file, file.target)) throw new Error('Final content verification failed')
          if (!sizeMatches(path.join(root, 'modinfo.lua'), files.find(file => file.filename === 'modinfo.lua')?.size ?? -1)) throw new Error('Missing modinfo.lua')
          const result = { workshopId: id, ok: true, sourceDir: root, manifestId: item.hcontent_file,
            updatedAt: new Date(Number(item.time_updated) * 1000).toISOString(), reusedBytes, totalBytes }
          results.push(result)
          onEvent({ ...result, phase: 'verified' })
        }
        finally { zip?.close() }
      }
      catch (error) {
        signal.throwIfAborted()
        const result = { workshopId: id, ok: false, error: String(error.message).replace(/https?:\/\/\S+/g, '[URL]') }
        results.push(result)
        onEvent(result)
      }
    }
    return results
  }
  try { return await Promise.race([run(), fatal, aborted]) }
  finally { client.logOff() }
}
