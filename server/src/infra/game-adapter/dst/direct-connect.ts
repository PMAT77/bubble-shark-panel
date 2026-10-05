import fs from 'node:fs'
import type { ClusterNetworkMode } from '../../../../../shared/contracts/cluster'
import type { InstanceConnectInfoDto } from '../../../../../shared/contracts/console'
import {
  CONNECT_HOST_PLACEHOLDER,
  connectHostSourceLabel,
  resolveDstConnectHost,
  resolveLanConnectHost,
  type ConnectHostSource,
  type ResolvedConnectHost,
} from './connect-host'
import { parseClusterIni } from './cluster-ini'
import { resolveClusterPaths } from './cluster-service'
import { readCavesServerIniFields, readMasterServerIniFields } from './shard-service'

const NETWORK_MODE_LABEL: Record<ClusterNetworkMode, string> = {
  offline: '离线',
  lan_only: '仅局域网',
  public: '公网（Klei 列表）',
}

export const CONNECT_MODES = ['public', 'local', 'lan'] as const
export type ConnectMode = (typeof CONNECT_MODES)[number]

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']

/** 出站 IP 探测可能被代理接管：此时探测结果是代理出口地址，而不是本机对外地址 */
export function isProxyEnvConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return PROXY_ENV_KEYS.some(key => Boolean(env[key]?.trim()))
}

/**
 * 面板默认展示哪一档直连命令。
 *
 * 出站 IP 探测（`ip_echo`）只回答"谁的出口"，不回答"哪台机器在监听"：在家用 NAT / 容器 /
 * 开着代理的环境里，探测结果往往无法直连（面板容器里还需要宿主侧的端口转发），
 * 此时「本机」档才是可直接用的。云元数据与手动配置仍以「公网」档为默认。
 */
export function resolvePreferredConnectMode(input: {
  source: ConnectHostSource
  isPlaceholder: boolean
  hasLanCommand: boolean
}): ConnectMode {
  if (input.isPlaceholder) {
    return input.hasLanCommand ? 'lan' : 'local'
  }
  return input.source === 'ip_echo' ? 'local' : 'public'
}

function escapeLuaString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function buildDstDirectConnectCommand(host: string, port: number, password?: string): string {
  const safeHost = escapeLuaString(host)
  if (password?.trim()) {
    return `c_connect("${safeHost}", ${port}, "${escapeLuaString(password.trim())}")`
  }
  return `c_connect("${safeHost}", ${port})`
}

function collectConnectHints(
  resolved: ResolvedConnectHost,
  networkMode: ClusterNetworkMode,
): string[] {
  const hints: string[] = []
  if (resolved.isPlaceholder) {
    hints.push(`未能自动探测进服地址，请将命令中的 ${CONNECT_HOST_PLACEHOLDER} 替换为服务器公网 IP`)
    hints.push('也可在面板环境配置中手动指定进服地址')
    return hints
  }
  const sourceLabel = connectHostSourceLabel(resolved.source)
  if (resolved.source === 'interface_private') {
    if (networkMode === 'public') {
      hints.push(`当前为局域网地址（${sourceLabel}），公网玩家可能无法直连；请检查云安全组/防火墙是否已放行游戏端口`)
    }
    else {
      hints.push(`连接地址为局域网 IP（${sourceLabel}），仅同一局域网内玩家可直连`)
    }
  }
  else if (resolved.source === 'env') {
    hints.push('进服地址来自手动配置')
  }
  else if (resolved.source === 'ip_echo') {
    hints.push('进服地址来自出站 IP 探测，仅在公网 IP 已映射到本机游戏端口时可用；本机游玩请切换「本机」档')
    if (isProxyEnvConfigured()) {
      hints.push('检测到代理环境变量（HTTP_PROXY/HTTPS_PROXY），该探测结果可能指向代理出口而非本机，分享给玩家前请核对')
    }
  }
  if (networkMode === 'public' && !resolved.isPlaceholder) {
    hints.push('从游戏浏览列表进服走 Klei 中继；使用下方直连命令需在防火墙放行游戏 UDP 端口')
  }
  return hints
}

/**
 * 直连进服需要玩家侧放行的 UDP 端口：主世界三个 + 洞穴三个。
 *
 * 洞穴分片同样要求公网可达（玩家从主世界切进洞穴时客户端会直连洞穴端口），只提示主世界端口
 * 会让用户在防火墙 / NAT 转发里漏配洞穴，表现为一进洞穴就崩线；未生成洞穴分片时不追加。
 */
function collectUdpPorts(
  installPath: string,
  masterFields: { serverPort: number, steamAuthPort: number, steamMasterPort: number },
): number[] {
  const ports = [
    masterFields.serverPort,
    masterFields.steamAuthPort,
    masterFields.steamMasterPort,
  ]
  const cavesFields = readCavesServerIniFields(installPath)
  if (cavesFields) {
    ports.push(cavesFields.serverPort, cavesFields.steamAuthPort, cavesFields.steamMasterPort)
  }
  return ports.filter((value, index, arr) => arr.indexOf(value) === index)
}

export async function buildDstConnectInfo(
  installPath: string,
  options?: { gamePort?: number | null, running?: boolean },
): Promise<Omit<InstanceConnectInfoDto, 'consoleShards'>> {
  const { clusterIniPath } = resolveClusterPaths(installPath)
  let clusterName = 'BubbleShark Panel'
  let clusterPassword = ''
  let networkMode: ClusterNetworkMode = 'offline'
  if (fs.existsSync(clusterIniPath)) {
    const content = fs.readFileSync(clusterIniPath, 'utf8')
    const parsed = parseClusterIni(content)
    clusterName = parsed.fields.clusterName
    clusterPassword = parsed.fields.clusterPassword
    networkMode = parsed.fields.networkMode
  }
  const masterFields = readMasterServerIniFields(installPath, options?.gamePort)
  const resolved = await resolveDstConnectHost()
  const port = masterFields.serverPort
  const password = clusterPassword.trim() || undefined
  const command = buildDstDirectConnectCommand(resolved.host, port, password)
  const localCommand = buildDstDirectConnectCommand('127.0.0.1', port, password)
  const lanHost = resolveLanConnectHost()
  const lanCommand = lanHost && lanHost !== resolved.host && lanHost !== '127.0.0.1'
    ? buildDstDirectConnectCommand(lanHost, port, password)
    : null
  const udpPorts = collectUdpPorts(installPath, masterFields)
  const hints = collectConnectHints(resolved, networkMode)
  return {
    running: Boolean(options?.running),
    command,
    localCommand,
    lanCommand,
    host: resolved.host,
    port,
    udpPorts,
    roomName: clusterName,
    networkMode,
    networkModeLabel: NETWORK_MODE_LABEL[networkMode],
    hasPassword: Boolean(password),
    hostSourceLabel: connectHostSourceLabel(resolved.source),
    isPlaceholder: resolved.isPlaceholder,
    preferredMode: resolvePreferredConnectMode({
      source: resolved.source,
      isPlaceholder: resolved.isPlaceholder,
      hasLanCommand: lanCommand !== null,
    }),
    hints,
  }
}
