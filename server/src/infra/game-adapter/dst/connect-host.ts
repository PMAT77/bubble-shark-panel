import { readBrandEnv } from '../../../../../shared/brand-env'
import os from 'node:os'

export type ConnectHostSource =
  | 'env'
  | 'cloud_metadata'
  | 'ip_echo'
  | 'interface_public'
  | 'interface_private'
  | 'placeholder'

export interface ResolvedConnectHost {
  host: string
  source: ConnectHostSource
  isPlaceholder: boolean
}

export const CONNECT_HOST_PLACEHOLDER = '<宿主机 IP>'

const CACHE_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 2500

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/

let cachedPublicIp: { ip: string, source: 'cloud_metadata' | 'ip_echo', expiresAt: number } | null = null

function isAutoPublicIpProbeDisabled(): boolean {
  const raw = readBrandEnv('BSP_DST_AUTO_PUBLIC_IP')?.trim().toLowerCase()
  return raw === '0' || raw === 'false' || raw === 'off' || raw === 'no'
}

export function isPublicIpv4(ip: string): boolean {
  const trimmed = ip.trim()
  if (!IPV4_PATTERN.test(trimmed)) {
    return false
  }
  const parts = trimmed.split('.').map(part => Number.parseInt(part, 10))
  if (parts.some(part => part > 255)) {
    return false
  }
  const [a, b] = parts
  if (a === 10) {
    return false
  }
  if (a === 127) {
    return false
  }
  if (a === 169 && b === 254) {
    return false
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return false
  }
  if (a === 192 && b === 168) {
    return false
  }
  return true
}

function normalizePublicIpv4Candidate(raw: string): string | null {
  const trimmed = raw.trim().replace(/\r/g, '')
  const firstLine = trimmed.split('\n')[0]?.trim() ?? ''
  const match = firstLine.match(IPV4_PATTERN)
  if (!match) {
    return null
  }
  const ip = match[0]
  return isPublicIpv4(ip) ? ip : null
}

async function fetchTextWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    })
    if (!response.ok) {
      return null
    }
    return await response.text()
  }
  catch {
    return null
  }
  finally {
    clearTimeout(timer)
  }
}

interface MetadataProbe {
  url: string
  init?: RequestInit
}

const CLOUD_METADATA_PROBES: MetadataProbe[] = [
  { url: 'http://169.254.169.254/latest/meta-data/public-ipv4' },
  { url: 'http://100.100.100.200/latest/meta-data/eipv4' },
  { url: 'http://100.100.100.200/latest/meta-data/public-ipv4' },
  { url: 'http://metadata.tencentyun.com/latest/meta-data/public-ipv4' },
  {
    url: 'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip',
    init: { headers: { 'Metadata-Flavor': 'Google' } },
  },
  {
    url: 'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text',
    init: { headers: { Metadata: 'true' } },
  },
  { url: 'http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address' },
]

const IP_ECHO_URLS = [
  'https://api.ipify.org?format=text',
  'https://ifconfig.me/ip',
  'https://icanhazip.com',
]

async function probeCloudMetadata(): Promise<string | null> {
  const tasks = CLOUD_METADATA_PROBES.map(async (probe) => {
    const body = await fetchTextWithTimeout(probe.url, probe.init, 1200)
    return body ? normalizePublicIpv4Candidate(body) : null
  })
  const results = await Promise.all(tasks)
  return results.find(ip => ip !== null) ?? null
}

async function probeIpEchoServices(): Promise<string | null> {
  for (const url of IP_ECHO_URLS) {
    const body = await fetchTextWithTimeout(url, {}, FETCH_TIMEOUT_MS)
    const ip = body ? normalizePublicIpv4Candidate(body) : null
    if (ip) {
      return ip
    }
  }
  return null
}

async function discoverPublicIpv4(): Promise<{ ip: string, source: 'cloud_metadata' | 'ip_echo' } | null> {
  const now = Date.now()
  if (cachedPublicIp && cachedPublicIp.expiresAt > now) {
    return { ip: cachedPublicIp.ip, source: cachedPublicIp.source }
  }
  const fromMetadata = await probeCloudMetadata()
  if (fromMetadata) {
    cachedPublicIp = { ip: fromMetadata, source: 'cloud_metadata', expiresAt: now + CACHE_TTL_MS }
    return { ip: fromMetadata, source: 'cloud_metadata' }
  }
  const fromEcho = await probeIpEchoServices()
  if (fromEcho) {
    cachedPublicIp = { ip: fromEcho, source: 'ip_echo', expiresAt: now + CACHE_TTL_MS }
    return { ip: fromEcho, source: 'ip_echo' }
  }
  return null
}

/** Node 18+ 使用字符串 family；旧版/部分类型定义可能为数字 4 */
function isNetworkInterfaceIpv4(family: string | number): boolean {
  return family === 'IPv4' || family === 4
}

function listInterfaceIpv4Candidates(): { publicIps: string[], privateIps: string[] } {
  const publicIps: string[] = []
  const privateIps: string[] = []
  for (const entries of Object.values(os.networkInterfaces())) {
    if (!entries) {
      continue
    }
    for (const entry of entries) {
      const isIpv4 = isNetworkInterfaceIpv4(entry.family)
      if (!isIpv4 || entry.internal) {
        continue
      }
      const ip = entry.address.trim()
      if (!ip || ip.startsWith('169.254.')) {
        continue
      }
      if (isPublicIpv4(ip)) {
        publicIps.push(ip)
      }
      else {
        privateIps.push(ip)
      }
    }
  }
  const privateScore = (ip: string) => {
    if (ip.startsWith('192.168.')) {
      return 0
    }
    if (ip.startsWith('10.')) {
      return 1
    }
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
      return 2
    }
    return 3
  }
  privateIps.sort((a, b) => privateScore(a) - privateScore(b))
  return { publicIps, privateIps }
}

/** 清除缓存（测试用） */
export function clearDstConnectHostCache(): void {
  cachedPublicIp = null
}

function isLikelyContainerBridgeIp(ip: string): boolean {
  return /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
}

/** 宿主机局域网 IPv4（供与公网地址并列展示；排除面板容器内 Docker 网桥地址） */
export function resolveLanConnectHost(): string | null {
  const { privateIps } = listInterfaceIpv4Candidates()
  return privateIps.find(ip => !isLikelyContainerBridgeIp(ip)) ?? null
}

/** 从网卡公网候选选取进服地址；无私网回退（局域网见 resolveLanConnectHost） */
export function pickConnectHostFromInterfacePublicIps(publicIps: string[]): ResolvedConnectHost {
  if (publicIps[0]) {
    return { host: publicIps[0], source: 'interface_public', isPlaceholder: false }
  }
  return { host: CONNECT_HOST_PLACEHOLDER, source: 'placeholder', isPlaceholder: true }
}

/**
 * 解析玩家用于 c_connect 的公网/对外宿主机地址：云环境优先公网 IP（元数据 / 出站探测），其次网卡公网；不回落局域网。
 */
export async function resolveDstConnectHost(): Promise<ResolvedConnectHost> {
  const fromEnv = readBrandEnv('BSP_DST_CONNECT_HOST')?.trim()
  if (fromEnv) {
    return { host: fromEnv, source: 'env', isPlaceholder: false }
  }

  if (!isAutoPublicIpProbeDisabled()) {
    const discovered = await discoverPublicIpv4()
    if (discovered) {
      return {
        host: discovered.ip,
        source: discovered.source,
        isPlaceholder: false,
      }
    }
  }

  const { publicIps } = listInterfaceIpv4Candidates()
  return pickConnectHostFromInterfacePublicIps(publicIps)
}

export function connectHostSourceLabel(source: ConnectHostSource): string {
  switch (source) {
    case 'env':
      return '手动配置'
    case 'cloud_metadata':
      return '云厂商元数据'
    case 'ip_echo':
      return '出站 IP 探测'
    case 'interface_public':
      return '网卡公网地址'
    case 'interface_private':
      return '网卡局域网地址'
    case 'placeholder':
      return '未探测到'
  }
}
