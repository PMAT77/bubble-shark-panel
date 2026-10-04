import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import type { Socket } from 'node:net'
import type { SteamModFetchErrorCode } from '../../../../../shared/contracts/mod'

/**
 * 面板访问 Steam 的出站层。
 *
 * 这一层存在的唯一理由是 **代理**：Node 原生 `fetch` 不读 `HTTPS_PROXY`，而本项目在
 * 受限网络下必须能把 Steam 请求导出去。仓库里没有引入 `undici` 之类的依赖，代理是
 * 用 `node:http`/`node:https`/`node:net` 手写 CONNECT 隧道实现的，因此：
 *
 * - **没配代理时走 `globalThis.fetch`**（保持既有的连接复用与测试桩习惯）；
 * - **配了代理时走原生 http(s) + CONNECT 隧道**。
 *
 * 代价是两条路径，好处是零依赖、且代理只作用于 Steam 请求——不会像全局 dispatcher
 * 那样顺带改变 GitHub / 通知渠道等其他出站的走向。
 */

export class SteamWorkshopFetchError extends Error {
  code: SteamModFetchErrorCode
  retryAfterMs?: number

  constructor(code: SteamModFetchErrorCode, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'SteamWorkshopFetchError'
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

export function isSteamWorkshopFetchError(error: unknown): error is SteamWorkshopFetchError {
  return error instanceof SteamWorkshopFetchError
}

export interface SteamProxyConfig {
  /** 代理地址（已补全 scheme） */
  url: string
  /** 不走代理的主机后缀，小写、无端口 */
  bypass: string[]
  /** 来源环境变量名，仅用于自检展示 */
  source: string
}

/** 代理相关的环境变量，按优先级排列 */
const PROXY_ENV_KEYS = [
  'GSH_STEAM_HTTPS_PROXY',
  'GSH_STEAM_HTTP_PROXY',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
] as const

const NO_PROXY_ENV_KEYS = ['GSH_STEAM_NO_PROXY', 'NO_PROXY', 'no_proxy'] as const

/** 无论配没配 NO_PROXY 都要绕过的本地地址，避免把面板自身/同机服务导进代理 */
const ALWAYS_BYPASS = ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal']

/**
 * 解析面板 Steam 出站代理。
 *
 * 顺序：本项目专用变量优先于进程通用的 `HTTPS_PROXY`/`HTTP_PROXY`，这样在
 * 「宿主机已经有全局代理、但只想让 Steam 走它」的场景下也能精确控制。
 */
export function resolveSteamProxyConfig(
  env: Record<string, string | undefined> = process.env,
): SteamProxyConfig | null {
  for (const key of PROXY_ENV_KEYS) {
    const raw = env[key]?.trim()
    if (!raw) {
      continue
    }
    const normalized = normalizeProxyUrl(raw)
    if (!normalized) {
      console.warn(`[steam-workshop] ${key} 不是可用的代理地址，已忽略：${redactProxyUrl(raw)}`)
      continue
    }
    const bypass = new Set(ALWAYS_BYPASS)
    for (const noProxyKey of NO_PROXY_ENV_KEYS) {
      for (const entry of (env[noProxyKey] ?? '').split(',')) {
        const host = normalizeBypassEntry(entry)
        if (host) {
          bypass.add(host)
        }
      }
    }
    return { url: normalized, bypass: [...bypass], source: key }
  }
  return null
}

/** 供自检展示：不回显凭据 */
export function describeSteamProxy(config: SteamProxyConfig | null): {
  enabled: boolean
  source: string | null
  host: string | null
} {
  if (!config) {
    return { enabled: false, source: null, host: null }
  }
  let host: string | null = null
  try {
    const parsed = new URL(config.url)
    host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
  }
  catch {
    host = null
  }
  return { enabled: true, source: config.source, host }
}

function redactProxyUrl(raw: string): string {
  return raw.replace(/\/\/[^@/]*@/, '//***@')
}

function normalizeProxyUrl(raw: string): string | null {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    if (!parsed.hostname) {
      return null
    }
    return parsed.toString()
  }
  catch {
    return null
  }
}

function normalizeBypassEntry(entry: string): string {
  const trimmed = entry.trim().toLowerCase()
  if (!trimmed) {
    return ''
  }
  // NO_PROXY 允许写成 "example.com:8080"、"*.example.com" 或 "[::1]"
  return trimmed
    .replace(/^\*\./, '')
    .replace(/^\[|\]$/g, '')
    .replace(/:\d+$/, '')
}

function shouldBypassProxy(config: SteamProxyConfig, targetHost: string): boolean {
  const host = targetHost.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) {
    return false
  }
  return config.bypass.some((entry) => {
    if (!entry) {
      return false
    }
    return host === entry || host.endsWith(`.${entry}`)
  })
}

export interface SteamRequestOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs: number
  /** 显式指定代理；不传则按环境变量解析（测试用它注入进程内傀儡代理） */
  proxy?: SteamProxyConfig | null
}

export interface SteamHttpResponse {
  status: number
  headers: { get: (name: string) => string | null }
  text: () => Promise<string>
  json: () => Promise<unknown>
}

/**
 * 发一个 Steam 出站请求。状态码不在这里判错——各调用点对 429/5xx 的措辞和
 * `Retry-After` 处理略有差异，保持在那里可以避免行为漂移。
 */
export async function steamHttpRequest(
  url: string,
  options: SteamRequestOptions,
): Promise<SteamHttpResponse> {
  const target = new URL(url)
  const proxy = options.proxy === undefined ? resolveSteamProxyConfig() : options.proxy
  if (!proxy || shouldBypassProxy(proxy, target.hostname)) {
    return await fetchResponse(url, options)
  }
  return await tunneledResponse(target, proxy, options)
}

async function fetchResponse(
  url: string,
  options: SteamRequestOptions,
): Promise<SteamHttpResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await globalThis.fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    })
    const body = await response.text()
    return {
      status: response.status,
      headers: { get: (name: string) => response.headers.get(name) },
      text: async () => body,
      json: async () => JSON.parse(body) as unknown,
    }
  }
  catch (error) {
    throw normalizeNetworkError(error)
  }
  finally {
    clearTimeout(timer)
  }
}

async function tunneledResponse(
  target: URL,
  proxy: SteamProxyConfig,
  options: SteamRequestOptions,
): Promise<SteamHttpResponse> {
  const proxyUrl = new URL(proxy.url)
  const deadline = Date.now() + options.timeoutMs
  const isSecureTarget = target.protocol === 'https:'
  const targetPort = target.port || (isSecureTarget ? '443' : '80')

  const tunnel = await openTunnel(proxyUrl, target.hostname, targetPort, options.timeoutMs)
  try {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new SteamWorkshopFetchError('STEAM_TIMEOUT', '请求 Steam 超时')
    const response = await sendOverSocket(tunnel.socket, {
      secure: isSecureTarget,
      servername: target.hostname,
      headers: {
        ...options.headers,
        // CONNECT 隧道里 Host 必须由我们自己补，否则上游看到的是代理地址
        Host: target.host,
        ...(options.body === undefined
          ? {}
          : { 'Content-Length': String(Buffer.byteLength(options.body)) }),
      },
      method: options.method ?? 'GET',
      body: options.body,
      path: `${target.pathname}${target.search}`,
      timeoutMs: remaining,
    })
    return response
  }
  catch (error) {
    tunnel.destroy()
    throw normalizeNetworkError(error)
  }
}

interface Tunnel {
  socket: Socket
  destroy: () => void
}

/** 通过代理建立 CONNECT 隧道，返回已连到目标主机的裸 socket */
function openTunnel(
  proxyUrl: URL,
  targetHost: string,
  targetPort: string,
  timeoutMs: number,
): Promise<Tunnel> {
  return new Promise<Tunnel>((resolve, reject) => {
    const proxyPort = proxyUrl.port || (proxyUrl.protocol === 'https:' ? '443' : '80')
    const proxySecure = proxyUrl.protocol === 'https:'
    const requestModule = proxySecure ? https : http

    let settled = false
    let socket: Socket | null = null
    const fail = (error: unknown) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      reject(error)
    }

    const headers: Record<string, string> = {
      Host: `${targetHost}:${targetPort}`,
      'Proxy-Connection': 'Keep-Alive',
    }
    if (proxyUrl.username || proxyUrl.password) {
      const credentials = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`
    }

    const request = requestModule.request({
      host: proxyUrl.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
      timeout: timeoutMs,
    })
    const timer = setTimeout(() => {
      request.destroy()
      fail(new SteamWorkshopFetchError('STEAM_TIMEOUT', '请求 Steam 超时'))
    }, timeoutMs)

    request.once('connect', (response, connectedSocket: Socket) => {
      socket = connectedSocket
      if (settled) {
        connectedSocket.destroy()
        return
      }
      if (response.statusCode !== 200) {
        connectedSocket.destroy()
        fail(new SteamWorkshopFetchError(
          'STEAM_UPSTREAM_UNAVAILABLE',
          `代理拒绝 CONNECT：HTTP ${response.statusCode}`,
        ))
        return
      }
      settled = true
      clearTimeout(timer)
      // 隧道建立后由业务请求自己管超时，这里清掉代理连接的超时
      connectedSocket.setTimeout(0)
      resolve({
        socket: connectedSocket,
        destroy: () => connectedSocket.destroy(),
      })
    })
    request.once('timeout', () => {
      request.destroy()
      fail(new SteamWorkshopFetchError('STEAM_TIMEOUT', '请求 Steam 超时'))
    })
    request.once('error', (error) => {
      fail(new SteamWorkshopFetchError(
        'STEAM_UPSTREAM_UNAVAILABLE',
        `无法连接代理：${sanitizeMessage(error.message)}`,
      ))
    })
    request.end()
  })
}

interface SendOverSocketOptions {
  secure: boolean
  servername: string
  headers: Record<string, string>
  method: string
  body: string | undefined
  path: string
  timeoutMs: number
}

function sendOverSocket(socket: Socket, options: SendOverSocketOptions): Promise<SteamHttpResponse> {
  return new Promise<SteamHttpResponse>((resolve, reject) => {
    let settled = false
    let stream: Socket = socket

    const finish = (error: unknown) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      stream.destroy()
      reject(normalizeNetworkError(error))
    }

    const timer = setTimeout(() => {
      finish(new SteamWorkshopFetchError('STEAM_TIMEOUT', '请求 Steam 超时'))
    }, options.timeoutMs)

    if (options.secure) {
      // 隧道已经是到目标主机的裸连接，这里再套一层 TLS；SNI 必须用目标主机名
      stream = tls.connect({
        socket,
        servername: options.servername,
      })
    }

    // 不依赖服务端主动关闭：按 Content-Length / chunked 判断 body 是否收完整，
    // 否则碰上 Connection: keep-alive 的响应会一直挂到超时。
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (settled) {
        return
      }
      const raw = Buffer.concat(chunks)
      if (!isResponseComplete(raw)) {
        return
      }
      settled = true
      clearTimeout(timer)
      try {
        const headerEnd = raw.indexOf('\r\n\r\n')
        resolve(parseHttpResponse(raw, headerEnd))
      }
      catch (error) {
        settled = false
        finish(error)
        return
      }
      // 已经拿全了，主动断开这条一次性连接
      stream.destroy()
    })
    stream.once('error', (error) => {
      finish(error)
    })
    stream.once('end', () => {
      if (settled) {
        return
      }
      const raw = Buffer.concat(chunks)
      const headerEnd = raw.indexOf('\r\n\r\n')
      if (headerEnd < 0) {
        finish(new SteamWorkshopFetchError('STEAM_UPSTREAM_UNAVAILABLE', '代理返回了无法解析的响应'))
        return
      }
      settled = true
      clearTimeout(timer)
      try {
        resolve(parseHttpResponse(raw, headerEnd))
      }
      catch (error) {
        finish(error)
      }
    })

    const headerLines = [
      `${options.method} ${options.path || '/'} HTTP/1.1`,
      ...Object.entries(options.headers).map(([name, value]) => `${name}: ${value}`),
      'Connection: close',
    ]
    stream.write(`${headerLines.join('\r\n')}\r\n\r\n`)
    if (options.body !== undefined) {
      stream.write(options.body)
    }
  })
}

/**
 * 判断响应是否收完整。
 *
 * 三种合法形态：声明了 Content-Length、chunked（读到结束块）、以及两者都没有
 * （按 HTTP/1.1 语义只能靠连接关闭来界定）。前两种能提前收工，不必等对端关连接。
 */
function isResponseComplete(raw: Buffer): boolean {
  const headerEnd = raw.indexOf('\r\n\r\n')
  if (headerEnd < 0) {
    return false
  }
  const body = raw.subarray(headerEnd + 4)
  const headerText = raw.subarray(0, headerEnd).toString('latin1').toLowerCase()
  const headerValue = (name: string): string | null => {
    for (const line of headerText.split('\r\n')) {
      const separator = line.indexOf(':')
      if (separator > 0 && line.slice(0, separator).trim() === name) {
        return line.slice(separator + 1).trim()
      }
    }
    return null
  }

  if (/chunked/.test(headerValue('transfer-encoding') ?? '')) {
    return /(^|\r\n)0\r\n\r\n$/.test(body.toString('latin1'))
  }
  const contentLength = Number.parseInt(headerValue('content-length') ?? '', 10)
  if (Number.isFinite(contentLength) && contentLength >= 0) {
    return body.length >= contentLength
  }
  return false
}

/**
 * 解析 CONNECT 隧道里回来的裸 HTTP 响应。
 *
 * Steam 的这几个接口响应都很小，所以只在内存里拼一个 Buffer；chunked 要按分块还原，
 * 否则 JSON 里会混进分块长度。
 */
function parseHttpResponse(raw: Buffer, headerEnd: number): SteamHttpResponse {
  const headerText = raw.subarray(0, headerEnd).toString('latin1')
  const lines = headerText.split('\r\n')
  const statusLine = lines.shift() ?? ''
  const status = Number.parseInt(statusLine.split(' ')[1] ?? '', 10)
  if (!Number.isFinite(status)) {
    throw new SteamWorkshopFetchError('STEAM_UPSTREAM_UNAVAILABLE', '代理返回了无法解析的响应')
  }
  const headers = new Map<string, string>()
  for (const line of lines) {
    const separator = line.indexOf(':')
    if (separator <= 0) {
      continue
    }
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim())
  }
  const payload = raw.subarray(headerEnd + 4).toString('utf8')
  const decoded = /chunked/i.test(headers.get('transfer-encoding') ?? '')
    ? decodeChunked(payload)
    : payload

  return {
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => decoded,
    json: async () => JSON.parse(decoded) as unknown,
  }
}

function decodeChunked(payload: string): string {
  const parts: string[] = []
  let cursor = 0
  while (cursor < payload.length) {
    const lineEnd = payload.indexOf('\r\n', cursor)
    if (lineEnd < 0) {
      break
    }
    const size = Number.parseInt(payload.slice(cursor, lineEnd).trim(), 16)
    if (!Number.isFinite(size) || size <= 0) {
      break
    }
    parts.push(payload.slice(lineEnd + 2, lineEnd + 2 + size))
    cursor = lineEnd + 2 + size + 2
  }
  return parts.join('')
}

function normalizeNetworkError(error: unknown): SteamWorkshopFetchError {
  if (isSteamWorkshopFetchError(error)) {
    return error
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new SteamWorkshopFetchError('STEAM_TIMEOUT', '请求 Steam 超时')
    }
    if (error.message.includes('fetch failed') || error.message.includes('socket hang up')) {
      return new SteamWorkshopFetchError('STEAM_UPSTREAM_UNAVAILABLE', '无法连接 Steam 创意工坊')
    }
    return new SteamWorkshopFetchError('STEAM_UPSTREAM_UNAVAILABLE', sanitizeMessage(error.message))
  }
  return new SteamWorkshopFetchError('STEAM_UPSTREAM_UNAVAILABLE', '无法连接 Steam 创意工坊')
}

/**
 * 把网络层的原始报错压成人能看的短句。
 *
 * 这里只做「去噪」，不做「翻译」——真正的用户文案由 `steam-workshop.ts` 决定。
 * 之所以不能直接回显：Node 的报错会带上代理地址甚至凭据。
 */
function sanitizeMessage(message: string): string {
  const normalized = message.trim()
  if (!normalized) {
    return '无法连接 Steam 创意工坊'
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up/i.test(normalized)) {
    return '无法连接 Steam 创意工坊'
  }
  return normalized
}
