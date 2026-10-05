import type { FastifyRequest } from 'fastify'

/**
 * 判断 peerIp 是否命中可信代理列表。
 * 支持：精确 IP（IPv4/IPv6）与 IPv4 CIDR（如 10.0.0.0/8）。
 * 未配置可信代理时任何 X-Forwarded-For 都不可信。
 */
export function isIpTrusted(peerIp: string, trustedProxies: string[]): boolean {
  const peer = peerIp.trim()
  if (!peer || trustedProxies.length === 0) {
    return false
  }
  for (const raw of trustedProxies) {
    const entry = raw.trim()
    if (!entry) {
      continue
    }
    const slashIndex = entry.indexOf('/')
    if (slashIndex === -1) {
      if (entry === peer) {
        return true
      }
      continue
    }
    const network = entry.slice(0, slashIndex).trim()
    const prefixRaw = entry.slice(slashIndex + 1).trim()
    const prefix = Number(prefixRaw)
    if (isIpv4(peer) && isIpv4(network) && Number.isInteger(prefix) && prefix >= 0 && prefix <= 32) {
      // 注意 JS 移位按 32 取模：prefix=0 时掩码必须为 0（匹配全部）。
      const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0
      if ((ipv4ToLong(peer) & mask) === (ipv4ToLong(network) & mask)) {
        return true
      }
      continue
    }
    // IPv6 仅支持精确匹配；前缀展开（如 ::1/128 的写法）交由精确列表覆盖。
    if (network === peer && prefixRaw === '128') {
      return true
    }
  }
  return false
}

function isIpv4(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 4) {
    return false
  }
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false
    }
    const num = Number(part)
    return num >= 0 && num <= 255
  })
}

function ipv4ToLong(value: string): number {
  const [a, b, c, d] = value.split('.').map(Number)
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0
}

/**
 * 解析客户端 IP：
 * - 默认返回 Fastify 的 request.ip（TCP 对端地址，不可伪造）。
 * - 仅当对端命中 BSP_TRUST_PROXY 配置的可信代理列表时，才采信
 *   X-Forwarded-For 的第一跳，防止伪造请求头绕过基于 IP 的限流。
 */
export function resolveClientIp(request: Pick<FastifyRequest, 'ip' | 'headers'>, trustedProxies: string[]): string {
  const peer = request.ip || 'unknown'
  if (trustedProxies.length === 0) {
    return peer
  }
  if (!isIpTrusted(peer, trustedProxies)) {
    return peer
  }
  const forwarded = request.headers['x-forwarded-for']
  const first = Array.isArray(forwarded)
    ? forwarded[0]?.split(',')[0]?.trim()
    : forwarded?.split(',')[0]?.trim()
  return first || peer
}
