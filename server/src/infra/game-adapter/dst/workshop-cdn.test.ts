import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { zipSync, strToU8 } from 'fflate'
import { downloadWorkshopContent } from './workshop-cdn.mjs'
import { DownloadSlots, sha1, WorkshopChunkCache, pruneWorkshopCache } from './workshop-cache.mjs'

const directories: string[] = []
afterEach(() => { for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-chunk-download-'))
  directories.push(root)
  const cacheRoot = path.join(root, 'cache')
  const existingRoot = path.join(root, 'installed')
  fs.mkdirSync(cacheRoot)
  const blobs = new Map<string, Buffer>()
  const downloads: string[] = []
  const events: any[] = []
  const file = (filename: string, parts: string[]) => {
    let offset = 0
    const chunks = parts.map(text => {
      const bytes = Buffer.from(text)
      const hash = sha1(bytes)
      blobs.set(hash, bytes)
      const chunk = { sha: hash, offset: String(offset), cb_original: bytes.length, cb_compressed: bytes.length }
      offset += bytes.length
      return chunk
    })
    return { filename, size: String(offset), sha_content: sha1(Buffer.from(parts.join(''))), flags: 0, chunks }
  }
  const metadata: any = { result: 1, consumer_appid: 322330, hcontent_file: '100', time_updated: 1_700_000_000 }
  let manifest: any = { gid_manifest: '100', files: [file('modinfo.lua', ['name="fixture"']), file('assets/data', ['aaa', 'bbb', 'ccc'])] }
  const session: any = {
    ready: Promise.resolve(), slots: new DownloadSlots(8),
    client: { async getPublishedFileDetails() { return { files: { '1': { ...metadata } } } } },
    transport: {
      async manifest() { return manifest },
      async chunk(chunk: any, signal: AbortSignal, onBytes: (size: number) => void) {
        downloads.push(chunk.sha)
        await delay(1, undefined, { signal })
        const bytes = blobs.get(chunk.sha)!
        onBytes(bytes.length)
        return bytes
      },
    },
  }
  const run = (extra: Record<string, unknown> = {}) => downloadWorkshopContent({ ids: ['1'], cacheRoot, existingRoot, session,
    onEvent: (event: any) => events.push(event), ...extra })
  const version = (id: string, files: any[]) => { metadata.hcontent_file = id; manifest = { gid_manifest: id, files } }
  return { root, cacheRoot, existingRoot, blobs, downloads, events, file, metadata, session, run, version }
}

it('downloads bounded chunks across files, verifies full content and reuses the same version without traffic', async () => {
  const f = fixture()
  const first = await f.run()
  assert.equal(first[0].ok, true)
  assert.equal(f.downloads.length, 4)
  assert.equal(fs.readFileSync(path.join(first[0].sourceDir!, 'assets/data'), 'utf8'), 'aaabbbccc')
  const progress = f.events.filter(value => value.progress).map(value => value.progress)
  assert(progress.every((value, index) => index === 0 || value.downloadedBytes >= progress[index - 1].downloadedBytes))
  assert(progress.every(value => value.downloadedBytes <= value.totalBytes))
  const again = await f.run()
  assert.equal(again[0].ok, true)
  assert.equal(f.downloads.length, 4)
  assert.equal(again[0].totalBytes, 0)
})

it('recovers a transient metadata timeout and keeps permanent metadata failures classified', async () => {
  const f = fixture()
  const metadata = f.session.client.getPublishedFileDetails
  let calls = 0
  f.session.client.getPublishedFileDetails = async () => {
    if (++calls === 1) throw new Error('Request timed out')
    return metadata()
  }
  assert.equal((await f.run())[0].ok, true)
  assert.equal(calls, 2)
  f.session.client.getPublishedFileDetails = async () => { throw new Error('Access denied') }
  await assert.rejects(f.run(), (error: any) => error.message === 'Access denied' && error.failureStage === 'metadata')
})

it('reuses moved chunks from a previous manifest and downloads only the new block', async () => {
  const f = fixture()
  const first = (await f.run())[0]
  const installed = path.join(f.existingRoot, '1')
  fs.cpSync(first.sourceDir!, installed, { recursive: true })
  fs.writeFileSync(path.join(installed, '.bsp-workshop-download.json'), JSON.stringify({ manifestId: '100' }))
  fs.rmSync(path.join(f.cacheRoot, 'chunks'), { recursive: true })
  fs.rmSync(first.sourceDir!, { recursive: true })
  f.downloads.length = 0
  f.version('101', [f.file('modinfo.lua', ['name="fixture"']), f.file('assets/data', ['new!', 'ccc', 'aaa', 'bbb'])])
  const result = (await f.run())[0]
  assert.equal(result.ok, true)
  assert.deepEqual(f.downloads, [sha1(Buffer.from('new!'))])
  assert.equal(result.totalBytes, 4)
  assert.equal(fs.readFileSync(path.join(result.sourceDir!, 'assets/data'), 'utf8'), 'new!cccaaabbb')
  assert.equal(fs.readFileSync(path.join(installed, 'assets/data'), 'utf8'), 'aaabbbccc')
})

it('keeps completed chunks on cancellation and resumes without fetching those chunks again', async () => {
  const f = fixture()
  f.session.slots = new DownloadSlots(1)
  const controller = new AbortController()
  await assert.rejects(f.run({ signal: controller.signal, onEvent: (event: any) => {
    if (event.phase === 'downloading' && event.progress.downloadedBytes > 0) controller.abort(new Error('fixture cancellation'))
  } }), /fixture cancellation/)
  const firstHash = f.downloads[0]!
  const result = (await f.run())[0]
  assert.equal(result.ok, true)
  assert.equal(f.downloads.filter(hash => hash === firstHash).length, 1)
})

it('rejects corrupted bytes and repairs corrupted cached content without changing installed files', async () => {
  const f = fixture()
  const original = f.session.transport.chunk
  f.session.transport.chunk = async () => Buffer.from('corruption')
  const failed = (await f.run())[0]
  assert.equal(failed.ok, false)
  assert.match(failed.error!, /checksum mismatch/)
  assert.equal(f.events.some(value => value.phase === 'verified'), false)
  f.session.transport.chunk = original
  const result = (await f.run())[0]
  const firstChunk = f.file('assets/data', ['aaa']).chunks[0]!
  const cache = new WorkshopChunkCache(f.cacheRoot)
  const key = { sha: firstChunk.sha, size: 3 }
  fs.writeFileSync(cache.filename(key), 'bad')
  fs.writeFileSync(path.join(result.sourceDir!, 'assets/data'), 'badbadbad')
  const count = f.downloads.length
  assert.equal((await f.run())[0].ok, true)
  assert.equal(f.downloads.length, count + 1)
})

it('rejects unsafe manifest paths and overlapping chunk layouts before downloading', async () => {
  const f = fixture()
  f.version('200', [f.file('../escape', ['invalid'])])
  assert.equal((await f.run())[0].ok, false)
  assert.equal(f.downloads.length, 0)
  const invalid = f.file('modinfo.lua', ['aaa', 'bbb'])
  invalid.chunks[1]!.offset = '1'
  f.version('201', [invalid])
  assert.match((await f.run())[0].error!, /chunk layout/)
  assert.equal(f.downloads.length, 0)
})

it('removes stale files from a cached version before it can be installed', async () => {
  const f = fixture()
  const result = (await f.run())[0]
  fs.writeFileSync(path.join(result.sourceDir!, 'stale.lua'), 'old')
  assert.equal((await f.run())[0].ok, true)
  assert.equal(fs.existsSync(path.join(result.sourceDir!, 'stale.lua')), false)
})

it('retains legacy ZIP range and CRC verification', async () => {
  const f = fixture()
  const archive = Buffer.from(zipSync({ 'modinfo.lua': strToU8('name="legacy"') }))
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  archive.writeUInt32LE((archive.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16)
  f.metadata.file_url = 'http://fixture.invalid/archive'
  f.metadata.file_size = String(archive.length)
  f.session.transport.range = async (_url: string, range: { start: number, end: number }, _signal: AbortSignal, output: any, onBytes: (size: number) => void) => {
    const bytes = archive.subarray(range.start, range.end)
    onBytes(bytes.length)
    if (output) output.end(bytes)
    return { bytes }
  }
  const result = (await f.run())[0]
  assert.equal(result.ok, false)
  assert.match(result.error!, /checksum mismatch/)
  assert.equal(f.events.some(value => value.phase === 'verified'), false)
})

it('evicts idle cache files to its configured budget without following symlinks', () => {
  const f = fixture()
  fs.writeFileSync(path.join(f.cacheRoot, 'old'), Buffer.alloc(16))
  fs.writeFileSync(path.join(f.cacheRoot, 'new'), Buffer.alloc(16))
  fs.utimesSync(path.join(f.cacheRoot, 'old'), new Date(0), new Date(0))
  assert.equal(pruneWorkshopCache(f.cacheRoot, 16), 16)
  assert.equal(fs.existsSync(path.join(f.cacheRoot, 'old')), false)
})
