import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, it } from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { requestSteamBytes, WorkshopTransport, unpackSteamContent } from './workshop-transport.mjs'
const Schema = createRequire(import.meta.url)('steam-user/protobufs/generated/_load.js')
const SteamCrypto = createRequire(import.meta.url)('@doctormckay/steam-crypto')

const directories: string[] = []
afterEach(() => { for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function root() { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-cdn-nodes-')); directories.push(value); return value }
function directoryClient(servers: any[]) {
  const calls: string[] = []
  const client = { cellID: 1, _send(header: any, _request: unknown, callback: Function) {
    const method = header.proto.target_job_name.split('.')[1].split('#')[0]
    calls.push(method)
    const body = method === 'GetServersForSteamPipe' ? { servers } : { token: '?auth=fixture', expiration_time: Math.floor(Date.now() / 1000) + 3600 }
    callback(Schema[`CContentServerDirectory_${method}_Response`].encode(body).finish(), { proto: { eresult: 1 } })
  } }
  return { client, calls }
}
const node = (host: string, https_support = 'mandatory') => ({ host, vhost: host, type: 'CDN', https_support })
const response = () => ({ bytes: Buffer.from('valid'), receivedBytes: 5, firstByteMs: 1, elapsedMs: 2 })

it('fails over nodes, retains the TLS hostname and refreshes CDN auth once after rejection', async () => {
  const { client, calls } = directoryClient([node('bad.steam.test'), node('good.steam.test')])
  const urls: string[] = []
  const transport = new WorkshopTransport(client, { cacheRoot: root(), request: async (url: string, options: any) => {
    urls.push(url)
    assert.equal(options.host, new URL(url).hostname)
    if (url.includes('bad.steam')) throw new Error('fixture connection timed out')
    if (!url.endsWith('?auth=fixture')) throw Object.assign(new Error('HTTP 403'), { status: 403 })
    return response()
  } })
  const result = await transport.fetch('/depot/322330/chunk/test', new AbortController().signal)
  assert.equal(result.toString(), 'valid')
  assert.equal(urls.length, 3)
  assert.equal(calls.filter(value => value === 'GetCDNAuthToken').length, 1)
  assert.equal(transport.health.get('bad.steam.test')!.cooldown! > Date.now(), true)
})

it('uses HTTP official nodes for validated chunks but never fetches a manifest through them', async () => {
  const { client } = directoryClient([node('local.steam.test', 'unavailable')])
  const urls: string[] = []
  const transport = new WorkshopTransport(client, { cacheRoot: root(), request: async (url: string) => { urls.push(url); return response() } })
  const signal = new AbortController().signal
  await transport.fetch('/chunk', signal)
  assert.equal(urls[0], 'http://local.steam.test/chunk')
  await assert.rejects(transport.fetch('/manifest', signal, { manifest: true }), /No HTTPS/)
  assert.equal(urls.length, 1)
})

it('keeps per-node concurrency at two and retries checksum failures on another node', async () => {
  const { client } = directoryClient([node('one.steam.test'), node('two.steam.test')])
  const active = new Map<string, number>()
  let max = 0
  let corrupt = true
  const transport = new WorkshopTransport(client, { cacheRoot: root(), request: async (url: string) => {
    const host = new URL(url).host
    active.set(host, (active.get(host) || 0) + 1)
    max = Math.max(max, active.get(host)!)
    await new Promise(resolve => setTimeout(resolve, 5))
    active.set(host, active.get(host)! - 1)
    return response()
  } })
  await Promise.all(Array.from({ length: 12 }, () => transport.fetch('/chunk', new AbortController().signal)))
  assert(max <= 2)
  let attempts = 0
  await transport.fetch('/chunk', new AbortController().signal, { validate: (bytes: Buffer) => {
    attempts++
    if (corrupt) { corrupt = false; throw new Error('fixture checksum mismatch') }
    return bytes
  } })
  assert.equal(attempts, 2)
})

it('fills the shared request budget instead of queuing every chunk behind a preferred saturated node', async () => {
  const { client } = directoryClient(Array.from({ length: 5 }, (_, index) => node(`cache${index}.steam.test`)))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered = 0
  const transport = new WorkshopTransport(client, { cacheRoot: root(), request: async () => {
    entered++
    await gate
    return response()
  } })
  transport.health.set('cache0.steam.test', { updated: Date.now(), bytesPerMs: 1000 })
  const requests = Array.from({ length: 8 }, () => transport.fetch('/chunk', new AbortController().signal))
  await new Promise(resolve => setTimeout(resolve, 30))
  const simultaneous = entered
  release()
  await Promise.all(requests)
  assert.equal(simultaneous, 8)
})

it('aborts actual HTTP requests and bounds stalled responses and declared decompressed sizes', async t => {
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.host, 'content.steam.test')
    response.writeHead(200)
    response.write('x')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/chunk`
  const controller = new AbortController()
  const requested = requestSteamBytes(url, { host: 'content.steam.test', signal: controller.signal,
    onBytes: () => controller.abort(new Error('fixture abort')) })
  await assert.rejects(requested, /fixture abort/)
  await assert.rejects(requestSteamBytes(url, { host: 'content.steam.test', idleTimeoutMs: 30 }), /stalled/)
  const zip = Buffer.from(zipSync({ file: strToU8('too much') }))
  await assert.rejects(unpackSteamContent(zip, 2), /exceeds manifest limit/)
  assert.equal((await unpackSteamContent(zip, 8)).toString(), 'too much')
})

it('decodes Steam protobuf manifests and decrypts encrypted CDN chunks through the production transport', async () => {
  const { client } = directoryClient([node('content.steam.test')])
  const bytes = Buffer.from('name="encrypted fixture"')
  const digest = createHash('sha1').update(bytes).digest()
  const key = Buffer.alloc(32, 7)
  const chunk = { sha: digest.toString('hex'), size: bytes.length, compressedSize: 1024 }
  const section = (magic: number, body: Buffer) => {
    const header = Buffer.alloc(8)
    header.writeUInt32LE(magic)
    header.writeUInt32LE(body.length, 4)
    return Buffer.concat([header, body])
  }
  const payload = Schema.ContentManifestPayload.encode({ mappings: [{ filename: 'modinfo.lua', size: bytes.length, sha_content: digest,
    chunks: [{ sha: digest, offset: 0, cb_original: bytes.length, cb_compressed: 1024 }] }] }).finish()
  const metadata = Schema.ContentManifestMetadata.encode({ depot_id: 322330, gid_manifest: '12345', filenames_encrypted: false }).finish()
  const end = Buffer.alloc(4)
  end.writeUInt32LE(0x32C415AB)
  const manifest = Buffer.concat([section(0x71F617D0, payload), section(0x1F4812BE, metadata), end])
  const fullClient = { ...client, async getManifestRequestCode() { return { requestCode: '999' } }, async getDepotDecryptionKey() { return { key } } }
  const transport = new WorkshopTransport(fullClient, { cacheRoot: root(), request: async (url: string) => {
    const body = url.includes('/manifest/') ? Buffer.from(zipSync({ manifest }))
      : SteamCrypto.symmetricEncrypt(Buffer.from(zipSync({ data: bytes })), key)
    return { ...response(), bytes: body, receivedBytes: body.length }
  } })
  const signal = new AbortController().signal
  const parsed = await transport.manifest('12345', signal)
  assert.equal(parsed.gid_manifest, '12345')
  assert.equal(parsed.files[0].chunks[0].sha, chunk.sha)
  assert.equal((await transport.chunk(chunk, signal)).toString(), bytes.toString())
})
