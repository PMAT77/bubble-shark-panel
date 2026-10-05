import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, it } from 'node:test'
import type { AddressInfo } from 'node:net'
import {
  describeSteamProxy,
  isSteamWorkshopFetchError,
  resolveSteamProxyConfig,
  SteamWorkshopFetchError,
  steamHttpRequest,
} from './steam-http.ts'

const PROXY_KEYS = [
  'BSP_STEAM_HTTPS_PROXY',
  'BSP_STEAM_HTTP_PROXY',
  'BSP_STEAM_NO_PROXY',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
]

const savedEnv = new Map<string, string | undefined>()
for (const key of PROXY_KEYS) {
  savedEnv.set(key, process.env[key])
}

function clearProxyEnv() {
  for (const key of PROXY_KEYS) {
    delete process.env[key]
  }
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key]
    }
    else {
      process.env[key] = value
    }
  }
})

describe('resolveSteamProxyConfig', () => {
  it('returns null when nothing is configured', () => {
    clearProxyEnv()
    assert.equal(resolveSteamProxyConfig(process.env), null)
  })

  it('prefers the project-specific variables over the generic ones', () => {
    const config = resolveSteamProxyConfig({
      BSP_STEAM_HTTPS_PROXY: 'http://panel-proxy:7890',
      HTTPS_PROXY: 'http://generic-proxy:8080',
    })
    assert.ok(config)
    assert.equal(config.source, 'BSP_STEAM_HTTPS_PROXY')
    assert.equal(new URL(config.url).host, 'panel-proxy:7890')
  })

  it('falls back to HTTPS_PROXY when the project variable is absent', () => {
    const config = resolveSteamProxyConfig({ HTTPS_PROXY: 'http://generic-proxy:8080' })
    assert.ok(config)
    assert.equal(config.source, 'HTTPS_PROXY')
  })

  it('accepts a bare host:port and assumes http', () => {
    const config = resolveSteamProxyConfig({ BSP_STEAM_HTTPS_PROXY: '127.0.0.1:7890' })
    assert.ok(config)
    assert.equal(config.url, 'http://127.0.0.1:7890/')
  })

  it('skips an unusable value and keeps looking', () => {
    const config = resolveSteamProxyConfig({
      BSP_STEAM_HTTPS_PROXY: 'socks5://127.0.0.1:1080',
      BSP_STEAM_HTTP_PROXY: 'http://fallback:7890',
    })
    assert.ok(config)
    assert.equal(config.source, 'BSP_STEAM_HTTP_PROXY')
  })

  it('always bypasses loopback and the docker host alias', () => {
    const config = resolveSteamProxyConfig({ BSP_STEAM_HTTPS_PROXY: 'http://proxy:7890' })
    assert.ok(config)
    assert.ok(config.bypass.includes('127.0.0.1'))
    assert.ok(config.bypass.includes('localhost'))
    assert.ok(config.bypass.includes('host.docker.internal'))
  })

  it('merges NO_PROXY entries and strips ports and wildcards', () => {
    const config = resolveSteamProxyConfig({
      BSP_STEAM_HTTPS_PROXY: 'http://proxy:7890',
      BSP_STEAM_NO_PROXY: '*.internal.example, other.example:8080 ,,',
    })
    assert.ok(config)
    assert.ok(config.bypass.includes('internal.example'))
    assert.ok(config.bypass.includes('other.example'))
  })
})

describe('describeSteamProxy', () => {
  it('never leaks credentials', () => {
    const config = resolveSteamProxyConfig({ BSP_STEAM_HTTPS_PROXY: 'http://user:secret@proxy:7890' })
    const described = describeSteamProxy(config)
    assert.equal(described.enabled, true)
    assert.equal(described.host, 'proxy:7890')
    assert.ok(!JSON.stringify(described).includes('secret'))
  })

  it('reports disabled without a config', () => {
    assert.deepEqual(describeSteamProxy(null), { enabled: false, source: null, host: null })
  })
})

describe('SteamWorkshopFetchError', () => {
  it('carries the error code and retry hint', () => {
    const error = new SteamWorkshopFetchError('STEAM_RATE_LIMIT', '限流', 5000)
    assert.equal(error.code, 'STEAM_RATE_LIMIT')
    assert.equal(error.retryAfterMs, 5000)
    assert.equal(error.name, 'SteamWorkshopFetchError')
    assert.ok(isSteamWorkshopFetchError(error))
  })
})

/** 起一个 CONNECT 代理 + 一个源站，返回两端端口；用完 unref，避免拖住测试进程 */
async function startProxyAndOrigin(originHandler: http.RequestListener): Promise<{
  proxyPort: number
  originPort: number
  targets: string[]
}> {
  const targets: string[] = []
  const proxy = http.createServer((_request, response) => {
    response.writeHead(501)
    response.end()
  })
  proxy.on('connect', (request, clientSocket, head) => {
    targets.push(request.url ?? '')
    const [host, port] = (request.url ?? '').split(':')
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) {
        upstream.write(head)
      }
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  const origin = http.createServer(originHandler)
  await Promise.all([
    new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', () => resolve())),
    new Promise<void>(resolve => origin.listen(0, '127.0.0.1', () => resolve())),
  ])
  // unref：这些监听器只为本次用例而活，不该拦着进程退出
  proxy.unref()
  origin.unref()
  return {
    proxyPort: (proxy.address() as AddressInfo).port,
    originPort: (origin.address() as AddressInfo).port,
    targets,
  }
}

describe('steamHttpRequest', () => {
  it('applies the timeout to the response body after headers arrive', { timeout: 3000 }, async () => {
    clearProxyEnv()
    const origin = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.write('{')
    })
    await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve))
    try {
      await assert.rejects(steamHttpRequest(`http://127.0.0.1:${(origin.address() as AddressInfo).port}/slow`, { timeoutMs: 50, proxy: null }),
        (error: unknown) => isSteamWorkshopFetchError(error) && error.code === 'STEAM_TIMEOUT')
    }
    finally { origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve())) }
  })
  it('without a proxy it goes through global fetch', { timeout: 10_000 }, async () => {
    const original = globalThis.fetch
    let calledWith = ''
    globalThis.fetch = (async (input: string | URL | Request) => {
      calledWith = String(input)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    try {
      const response = await steamHttpRequest('http://steam.test/path', { timeoutMs: 1000, proxy: null })
      assert.equal(response.status, 200)
      assert.equal(calledWith, 'http://steam.test/path')
      assert.deepEqual(await response.json(), { ok: true })
    }
    finally {
      globalThis.fetch = original
    }
  })

  it('with a proxy it opens a CONNECT tunnel to the real target', { timeout: 15_000 }, async () => {
    const { proxyPort, originPort, targets } = await startProxyAndOrigin((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"viaTunnel":true}')
    })
    const response = await steamHttpRequest(`http://127.0.0.1:${originPort}/IPublishedFileService`, {
      timeoutMs: 3000,
      proxy: { url: `http://127.0.0.1:${proxyPort}`, bypass: [], source: 'test' },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { viaTunnel: true })
    // 关键证据：确实走了 CONNECT，且目标就是源站
    assert.deepEqual(targets, [`127.0.0.1:${originPort}`])
  })

  it('with a proxy it reads a chunked response', { timeout: 15_000 }, async () => {
    const { proxyPort, originPort } = await startProxyAndOrigin((_request, response) => {
      response.writeHead(200, { 'Transfer-Encoding': 'chunked' })
      response.write('{"chunked":')
      response.write('true}')
      response.end()
    })
    const response = await steamHttpRequest(`http://127.0.0.1:${originPort}/x`, {
      timeoutMs: 3000,
      proxy: { url: `http://127.0.0.1:${proxyPort}`, bypass: [], source: 'test' },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { chunked: true })
  })

  it('fails with a readable message when the proxy is unreachable', { timeout: 15_000 }, async () => {
    // 先拿一个空闲端口再关掉它，保证这个端口上没人监听
    const probe = http.createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', () => resolve()))
    const deadPort = (probe.address() as AddressInfo).port
    await new Promise<void>(resolve => probe.close(() => resolve()))

    await assert.rejects(
      () => steamHttpRequest('http://steam.test/x', {
        timeoutMs: 3000,
        proxy: { url: `http://127.0.0.1:${deadPort}`, bypass: [], source: 'test' },
      }),
      (error: unknown) => {
        assert.ok(isSteamWorkshopFetchError(error))
        assert.equal(error.code, 'STEAM_UPSTREAM_UNAVAILABLE')
        assert.match(error.message, /无法连接代理/)
        return true
      },
    )
  })
})
