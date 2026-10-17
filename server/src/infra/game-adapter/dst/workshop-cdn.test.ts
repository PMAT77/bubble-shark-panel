import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { build } from 'esbuild'
import { zipSync, strToU8 } from 'fflate'

it('verifies real content bytes, ignores duplicate callbacks and rejects corrupted downloads', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-cdn-content-'))
  const context = globalThis as typeof globalThis & { __bspCdnFixture?: unknown }
  const content = Buffer.from('name="fixture"\n')
  const metadata = { result: 1, consumer_appid: 322330, hcontent_file: '777', time_updated: 1700000000 }
  const events: Array<{ phase?: string, progress?: { downloadedBytes: number, totalBytes: number } }> = []
  let downloads = 0
  const fixture = {
    metadata,
    manifest: { gid_manifest: '777', files: [{ filename: 'modinfo.lua', size: String(content.length), flags: 0,
      sha_content: createHash('sha1').update(content).digest('hex') }] },
    download: async (_app: number, _depot: number, _file: unknown, output: string, callback: Function) => {
      downloads++
      for (const bytes of [5, 5, 3, content.length]) callback(null, { type: 'progress', bytesDownloaded: bytes })
      fs.writeFileSync(output, content)
    },
  }
  context.__bspCdnFixture = fixture
  try {
    const output = path.join(root, 'candidate.mjs')
    const bundle = await build({ entryPoints: [path.resolve('server/src/infra/game-adapter/dst/workshop-cdn.mjs')], outfile: output, write: false,
      bundle: true, format: 'esm', platform: 'node', banner: { js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);' }, plugins: [{ name: 'sdk-fixture', setup(builder) {
        builder.onResolve({ filter: /^steam-user$/ }, () => ({ path: 'sdk', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
          import {EventEmitter} from 'node:events';
          export default class Client extends EventEmitter {
            static EConnectionProtocol = {WebSocket: 1};
            logOn(){queueMicrotask(()=>this.emit('loggedOn'))} logOff(){}
            async getPublishedFileDetails(ids){return {files:Object.fromEntries(ids.map(id=>[id,globalThis.__bspCdnFixture.metadata]))}}
            async getManifest(){return {manifest:globalThis.__bspCdnFixture.manifest}}
            downloadFile(...args){return globalThis.__bspCdnFixture.download(...args)}
          }` }))
      } }] })
    fs.writeFileSync(output, bundle.outputFiles[0]!.contents)
    const { downloadWorkshopContent } = await import(pathToFileURL(output).href)
    const cacheRoot = path.join(root, 'cache')
    const run = (cache = cacheRoot, existingRoot?: string) => downloadWorkshopContent({ ids: ['1'], cacheRoot: cache, existingRoot, onEvent: (event: typeof events[number]) => events.push(event) })
    assert.equal((await run())[0].ok, true)
    assert.deepEqual(events.filter(event => event.progress).slice(0, 5).map(event => event.progress!.downloadedBytes), [0, 5, 5, 5, content.length])
    assert(events.every(event => !event.progress || event.progress.downloadedBytes <= event.progress.totalBytes))
    assert.equal(downloads, 1)
    events.length = 0
    assert.equal((await run())[0].ok, true)
    assert.equal(downloads, 1)
    assert(events.some(event => event.progress?.totalBytes === 0))

    fixture.download = async (_app, _depot, _file, output, callback) => {
      callback(null, { type: 'progress', bytesDownloaded: content.length })
      fs.writeFileSync(output, Buffer.alloc(content.length))
    }
    const existing = path.join(root, 'old', '1')
    fs.mkdirSync(existing, { recursive: true })
    fs.writeFileSync(path.join(existing, 'modinfo.lua'), 'old content')
    events.length = 0
    const failed = await run(path.join(root, 'corrupt'), path.dirname(existing))
    assert.equal(failed[0].ok, false)
    assert.match(failed[0].error, /checksum mismatch/)
    assert.equal(fs.readFileSync(path.join(existing, 'modinfo.lua'), 'utf8'), 'old content')
    assert.equal(events.some(event => event.phase === 'verified'), false)

    const archive = Buffer.from(zipSync({ 'modinfo.lua': strToU8('name="legacy"') }))
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    archive.writeUInt32LE((archive.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16)
    fixture.metadata = { ...metadata, file_url: 'http://fixture.invalid/content', file_size: String(archive.length) } as typeof metadata
    t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
      const headers = options?.headers as Record<string, string> | undefined
      const range = String(headers?.Range ?? '').match(/bytes=(\d+)-(\d+)/)!
      const start = Number(range[1]), end = Number(range[2])
      return new Response(archive.subarray(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${archive.length}` } })
    })
    events.length = 0
    const legacy = await run(path.join(root, 'bad-legacy'))
    assert.equal(legacy[0].ok, false)
    assert.match(legacy[0].error, /checksum mismatch/)
    assert(events.every(event => !event.progress || event.progress.downloadedBytes === 0))
  }
  finally { delete context.__bspCdnFixture; fs.rmSync(root, { recursive: true, force: true }) }
})
