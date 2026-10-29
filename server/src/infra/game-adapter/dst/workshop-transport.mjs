import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import StdLib from '@doctormckay/stdlib'
import SteamCrypto from '@doctormckay/steam-crypto'
import Compression from 'steam-user/components/cdn_compression.js'
import Manifest from 'steam-user/components/content_manifest.js'
import Schema from 'steam-user/protobufs/generated/_load.js'
import { atomicCacheWrite, DownloadSlots, sha1 } from './workshop-cache.mjs'
import { abortable } from '../../../shared/abort.ts'

const agents = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 8 }), 'https:': new https.Agent({ keepAlive: true, maxSockets: 8 }) }
const addresses = new Map()

/** Retry only transient control-plane failures, preserving permanent SDK errors. */
export async function retrySteamOperation(action, signal) {
  for (let attempt = 0; ; attempt++) {
    try { return await abortable(action(), signal) }
    catch (error) {
      signal.throwIfAborted()
      if (attempt >= 2 || !(/timed?\s*out|timeout|ECONNRESET|EAI_AGAIN|ETIMEDOUT/i.test(error.message) ||
        ['ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH'].includes(error.code))) throw error
      await delay((attempt + 1) * 1000, undefined, { signal })
    }
  }
}

/** The SDK decompressors trust archive size fields; bound them before allocation. */
export async function unpackSteamContent(bytes, maxBytes) {
  const header = bytes.subarray(0, 4).toString('binary')
  let size
  if (header === 'VSZa' && bytes.length >= 15) size = bytes.readUInt32LE(bytes.length - 11)
  else if (header.startsWith('VZa') && bytes.length >= 10) size = bytes.readUInt32LE(bytes.length - 6)
  else if (header === 'PK\x03\x04') {
    for (let end = bytes.length - 22; end >= Math.max(0, bytes.length - 65557); end--) {
      if (bytes.readUInt32LE(end) !== 0x06054b50) continue
      const central = bytes.readUInt32LE(end + 16)
      if (central + 46 <= bytes.length && bytes.readUInt32LE(central) === 0x02014b50) size = bytes.readUInt32LE(central + 24)
      break
    }
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) throw new Error('Steam decompressed content exceeds manifest limit')
  const result = await Compression.unzip(bytes)
  if (result.length !== size || result.length > maxBytes) throw new Error('Steam decompressed size mismatch')
  return result
}

function lookup(host, options, callback) {
  const run = async () => {
    let cached = addresses.get(host)
    if (!cached || cached.expires < Date.now()) {
      cached = { values: await dns.lookup(host, { all: true }), index: 0, expires: Date.now() + 300_000 }
      addresses.set(host, cached)
    }
    const ordered = [...cached.values].sort((a, b) => Number(b.address === cached.preferred) - Number(a.address === cached.preferred))
    const selected = ordered[cached.index % ordered.length]
    if (!selected) throw new Error('Steam DNS returned no addresses')
    if (options.all) callback(null, [...ordered.slice(cached.index % ordered.length), ...ordered.slice(0, cached.index % ordered.length)])
    else callback(null, selected.address, selected.family)
  }
  void run().catch(callback)
}

/** Request-scoped address selection retains hostname/SNI and never changes hosts. */
export function requestSteamBytes(url, { signal, proxy, host, maxBytes = 16 * 1024 ** 2, onBytes = () => {}, lookupAddress = lookup,
  connectTimeoutMs = 5000, firstByteTimeoutMs = 10_000, idleTimeoutMs = 15_000, range, output, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return reject(new Error('Invalid Steam content URL'))
    if (signal?.aborted) return reject(signal.reason)
    let connected
    let headers
    let response
    let settled = false
    const started = performance.now()
    let firstByteMs = 0
    let received = 0
    const buffers = []
    const agent = proxy ? StdLib.HTTP.getProxyAgent(target.protocol === 'https:', proxy) : agents[target.protocol]
    const request = (target.protocol === 'https:' ? https : http).request(target, {
      agent, lookup: proxy ? undefined : lookupAddress, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250,
      headers: { Host: host || target.host, 'Accept-Encoding': 'identity', 'User-Agent': 'Valve/Steam HTTP Client 1.0',
        ...(range ? { Range: `bytes=${range.start}-${range.end - 1}` } : {}) },
    })
    const cleanup = () => { clearTimeout(connected); clearTimeout(headers); signal?.removeEventListener('abort', abort) }
    const finish = error => {
      if (settled) return
      settled = true
      cleanup()
      request.destroy()
      response?.destroy()
      if (!proxy && addresses.has(target.hostname)) addresses.get(target.hostname).index++
      reject(error)
    }
    const abort = () => finish(signal.reason)
    signal?.addEventListener('abort', abort, { once: true })
    connected = setTimeout(() => finish(new Error('Steam connection timed out')), connectTimeoutMs)
    const onConnected = () => {
      clearTimeout(connected)
      if (!settled) headers = setTimeout(() => finish(new Error('Steam first byte timed out')), firstByteTimeoutMs)
    }
    request.once('socket', socket => {
      if (socket.connecting) socket.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', onConnected)
      else onConnected()
    })
    request.setTimeout(idleTimeoutMs, () => finish(new Error('Steam response stalled')))
    request.once('response', res => {
      response = res
      clearTimeout(connected)
      clearTimeout(headers)
      firstByteMs = performance.now() - started
      if (range && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        settled = true
        cleanup()
        res.destroy()
        request.destroy()
        void requestSteamBytes(new URL(res.headers.location, target).href, { signal, proxy, maxBytes, onBytes, lookupAddress,
          connectTimeoutMs, firstByteTimeoutMs, idleTimeoutMs, range, output, redirects: redirects + 1 }).then(resolve, reject)
        return
      }
      if (res.statusCode !== (range ? 206 : 200) || (range && res.headers['content-range'] !== `bytes ${range.start}-${range.end - 1}/${range.totalSize}`)) {
        const error = Object.assign(new Error(`Steam CDN HTTP ${res.statusCode}`), { status: res.statusCode,
          retryAfterMs: Math.min(30_000, Math.max(1000, Number(res.headers['retry-after']) * 1000 || 1000)) })
        finish(error)
        return
      }
      const count = bytes => {
        received += bytes.length
        if (received > maxBytes) throw new Error('Steam response size exceeds manifest limit')
        onBytes(bytes.length)
      }
      const complete = () => {
        if (settled) return
        if (range && received !== range.end - range.start) { finish(new Error('Legacy range length mismatch')); return }
        settled = true
        cleanup()
        if (!proxy && addresses.has(target.hostname)) {
          addresses.get(target.hostname).preferred = request.socket?.remoteAddress
          addresses.get(target.hostname).index = 0
        }
        resolve({ bytes: Buffer.concat(buffers), receivedBytes: received, firstByteMs, elapsedMs: performance.now() - started, address: request.socket?.remoteAddress })
      }
      res.once('error', finish)
      res.once('aborted', () => finish(new Error('Steam response interrupted')))
      if (output) {
        const counter = new Transform({ transform(bytes, _encoding, callback) {
          try { count(bytes); callback(null, bytes) } catch (error) { callback(error) }
        } })
        void pipeline(res, counter, output).then(complete, finish)
      }
      else {
        res.on('data', bytes => { try { count(bytes); buffers.push(bytes) } catch (error) { finish(error) } })
        res.once('end', complete)
      }
    })
    request.once('error', finish)
    request.end()
  })
}

export function steamContentRpc(client, method, input, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const abort = () => finish(signal.reason)
    const timer = setTimeout(() => finish(new Error(`Steam ${method} timed out`)), 10_000)
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value)
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      client._send({ msg: 151, proto: { target_job_name: `ContentServerDirectory.${method}#1` } },
        Schema[`CContentServerDirectory_${method}_Request`].encode(input).finish(), (data, header) => {
          try {
            if (header.proto.eresult !== 1) return finish(new Error(`Steam ${method} result ${header.proto.eresult}`))
            finish(null, Schema[`CContentServerDirectory_${method}_Response`].decode(data.toBuffer ? data.toBuffer() : data))
          }
          catch (error) { finish(error) }
        })
    }
    catch (error) { finish(error) }
  })
}

function contentServer(server) {
  if (!['CDN', 'SteamCache'].includes(server.type) || (server.allowed_app_ids?.length && !server.allowed_app_ids.includes(322330))) return null
  if (!/^[a-z0-9.-]+$/i.test(server.host || '') || !/^[a-z0-9.-]+$/i.test(server.vhost || server.host)) return null
  if (!['mandatory', 'optional', 'unavailable'].includes(server.https_support)) return null
  return { ...server, Host: server.host }
}

export class WorkshopTransport {
  constructor(client, { cacheRoot, httpProxy, noProxy = [], request = requestSteamBytes } = {}) {
    this.client = client
    this.cacheRoot = cacheRoot
    this.proxy = httpProxy
    this.noProxy = noProxy
    this.request = request
    this.slots = new DownloadSlots(8)
    this.servers = []
    this.health = new Map()
    this.tokens = new Map()
    this.serverSlots = new Map()
    try {
      const values = JSON.parse(fs.readFileSync(path.join(cacheRoot, 'nodes.json'), 'utf8'))
      for (const [host, value] of Object.entries(values).slice(0, 200)) {
        if (/^[a-z0-9.-]+$/i.test(host) && Date.now() - value.updated < 1800_000) this.health.set(host, value)
      }
    }
    catch { /* Node history is optional and can always be rediscovered. */ }
  }
  async directory(signal, alternate = false) {
    if (this.servers.length && !alternate && Date.now() - this.directoryAt < 1800_000) return this.servers
    if (this.directoryPromise) return abortable(this.directoryPromise, signal)
    this.directoryPromise = (async () => {
      const cells = alternate || this.alternate ? [this.client.cellID || 0, 5] : [this.client.cellID || 0]
      const found = []
      let lastError
      for (const cell of new Set(cells)) {
        try {
          const body = await steamContentRpc(this.client, 'GetServersForSteamPipe', { cell_id: cell, max_servers: 40 })
          found.push(...body.servers.map(contentServer).filter(Boolean))
        }
        catch (error) { lastError = error }
      }
      if (!found.length && !cells.includes(5)) {
        const body = await steamContentRpc(this.client, 'GetServersForSteamPipe', { cell_id: 5, max_servers: 40 })
        found.push(...body.servers.map(contentServer).filter(Boolean))
        this.alternate = true
      }
      if (!found.length && lastError) throw lastError
      this.servers = [...new Map(found.map(server => [server.host, server])).values()]
      this.directoryAt = Date.now()
      this.alternate ||= alternate
      return this.servers
    })().finally(() => { this.directoryPromise = null })
    return abortable(this.directoryPromise, signal)
  }
  async token(server, signal) {
    const value = this.tokens.get(server.host)
    if (value?.expires > Date.now() + 30_000) return value.token
    const body = await steamContentRpc(this.client, 'GetCDNAuthToken', { app_id: 322330, depot_id: 322330, host_name: server.vhost || server.host }, signal)
    this.tokens.set(server.host, { token: body.token, expires: Number(body.expiration_time) * 1000 })
    return body.token || ''
  }
  score(server) {
    const value = this.health.get(server.host)
    if (value?.cooldown > Date.now()) return 1e12 + value.cooldown
    if (value?.bytesPerMs) return 1000 / value.bytesPerMs + (this.serverSlots.get(server.host)?.active || 0) * 100
    return 500 + (Number(server.weighted_load) || 0) + (this.serverSlots.get(server.host)?.active || 0) * 100
  }
  async fetch(resource, signal, { manifest = false, maxBytes, onBytes, validate = bytes => bytes } = {}) {
    let lastError
    const used = new Set()
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted()
      await this.directory(signal, attempt > 0)
      let servers = this.servers.filter(server => !manifest || server.https_support !== 'unavailable')
      if (!servers.length && !this.alternate) {
        await this.directory(signal, true)
        servers = this.servers.filter(server => !manifest || server.https_support !== 'unavailable')
      }
      const healthy = servers.filter(server => !(this.health.get(server.host)?.cooldown > Date.now()))
      if (healthy.length) servers = healthy
      const unused = servers.filter(server => !used.has(server.host))
      const candidates = unused.length ? unused : servers
      const idle = candidates.filter(server => (this.serverSlots.get(server.host)?.active || 0) < 2)
      const server = (idle.length ? idle : candidates).sort((a, b) => this.score(a) - this.score(b))[0]
      if (!server) throw new Error(manifest ? 'No HTTPS Steam manifest servers available' : 'No Steam CDN servers available')
      used.add(server.host)
      if (!this.serverSlots.has(server.host)) this.serverSlots.set(server.host, new DownloadSlots(2))
      try {
        return await this.serverSlots.get(server.host).run(signal, () => this.slots.run(signal, async () => {
          for (let authenticated = 0; authenticated < 2; authenticated++) {
            const secure = server.https_support !== 'unavailable'
            const suffix = authenticated ? await this.token(server, signal) : (this.tokens.get(server.host)?.expires > Date.now() ? this.tokens.get(server.host).token : '')
            const proxy = this.noProxy.some(value => server.host === value || server.host.endsWith(`.${value}`)) ? undefined : this.proxy
            try {
              const response = await this.request(`${secure ? 'https' : 'http'}://${server.host}${resource}${suffix}`, {
                signal, host: server.vhost || server.host, proxy, maxBytes, onBytes,
              })
              const result = await validate(response.bytes)
              this.health.set(server.host, { updated: Date.now(), bytesPerMs: response.receivedBytes / Math.max(1, response.elapsedMs), firstByteMs: response.firstByteMs })
              this.slots.limit = this.recoverAt > Date.now() ? 4 : 8
              this.lastNode = { host: server.host, address: response.address, protocol: secure ? 'https' : 'http', firstByteMs: response.firstByteMs }
              return result
            }
            catch (error) {
              if (![401, 403].includes(error.status) || authenticated) throw error
              this.tokens.delete(server.host)
            }
          }
        }))
      }
      catch (error) {
        signal.throwIfAborted()
        lastError = error
        this.health.set(server.host, { updated: Date.now(), cooldown: Date.now() + 300_000 })
        if (error.status === 429 || /timed out|stalled/.test(error.message)) { this.slots.limit = 4; this.recoverAt = Date.now() + 30_000 }
        if (error.status === 429) await delay(error.retryAfterMs || 1000, undefined, { signal })
      }
    }
    throw lastError
  }
  async manifest(id, signal) {
    const { requestCode } = await retrySteamOperation(() => this.client.getManifestRequestCode(322330, 322330, id, 'public'), signal)
    return this.fetch(`/depot/322330/manifest/${id}/5/${requestCode}`, signal, { manifest: true, maxBytes: 32 * 1024 ** 2, validate: async bytes => {
      const manifest = Manifest.parse(await unpackSteamContent(bytes, 32 * 1024 ** 2))
      if (manifest.gid_manifest !== id || Number(manifest.depot_id) !== 322330) throw new Error('Downloaded manifest identity mismatch')
      if (manifest.filenames_encrypted) Manifest.decryptFilenames(manifest, (await abortable(this.key(), signal)).key)
      return manifest
    } })
  }
  key() { return this.keyPromise ||= this.client.getDepotDecryptionKey(322330, 322330).catch(error => { this.keyPromise = null; throw error }) }
  async chunk(chunk, signal, onBytes) {
    const { key } = await abortable(this.key(), signal)
    return this.fetch(`/depot/322330/chunk/${chunk.sha}`, signal, { maxBytes: chunk.compressedSize + 1024, onBytes, validate: async bytes => {
      const result = await unpackSteamContent(SteamCrypto.symmetricDecrypt(bytes, key), chunk.size)
      if (result.length !== chunk.size || sha1(result) !== chunk.sha) throw new Error('Steam chunk checksum mismatch')
      return result
    } })
  }
  range(url, range, signal, output, onBytes) {
    const host = new URL(url).hostname
    const proxy = this.noProxy.some(value => host === value || host.endsWith(`.${value}`)) ? undefined : this.proxy
    return this.slots.run(signal, () => this.request(url, { signal, proxy, range, output, onBytes, maxBytes: range.end - range.start }))
  }
  save() {
    try { atomicCacheWrite(path.join(this.cacheRoot, 'nodes.json'), JSON.stringify(Object.fromEntries(this.health))) }
    catch { /* A read-only cache must not invalidate downloaded content. */ }
  }
}
