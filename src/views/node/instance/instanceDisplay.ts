import type { InstanceInstallLogPayload, InstanceInstallLogSource, InstanceItem, InstanceStatus } from '@/api/modules/instance'

import { INSTANCE_STATE, INSTANCE_STATUS, statusBadgeClass, type StatusDescriptor } from '@/constants/statusDictionary'

/** 实例原始状态中文标签（无上下文时的兜底；列表页请优先用 getInstanceState） */
export function getStatusLabel(status: InstanceStatus) {
  return INSTANCE_STATUS[status].label
}

/** 实例状态徽章 UnoCSS 类名（无上下文时的兜底） */
export function getStatusBadgeClass(status: InstanceStatus) {
  return statusBadgeClass(INSTANCE_STATUS[status].tone)
}

/** 最近一次失败是否发生在安装环节（后端写入失败时一并落库，见 `last_error_phase`） */
function isInstallPhaseFailure(instance: Pick<InstanceItem, 'lastErrorPhase'>) {
  return instance.lastErrorPhase === 'install'
}

/**
 * 实例展示状态：将 error 拆分为「安装失败 / 运行异常」，
 * 其余状态直接映射词典。列表/详情/通知应统一使用本函数。
 *
 * 依据是 `lastErrorPhase`（后端写入失败时一并落库的环节），不是错误文案——
 * 内存守卫拒绝启动时写的说明里同时提到「安装」「启动」，靠文案判不出真实环节。
 * 环节未知（旧数据、手工改库）按运行异常兜底，与 `INSTANCE_STATUS.error` 的口径一致。
 */
export function getInstanceState(
  instance: Pick<InstanceItem, 'status' | 'lastErrorPhase'>,
): StatusDescriptor & { key: keyof typeof INSTANCE_STATE } {
  if (instance.status === 'error') {
    return isInstallPhaseFailure(instance)
      ? { ...INSTANCE_STATE.install_failed, key: 'install_failed' }
      : { ...INSTANCE_STATE.runtime_error, key: 'runtime_error' }
  }
  return { ...INSTANCE_STATE[instance.status], key: instance.status }
}

/** 判断 lastCommand 是否为运行时启动命令（非安装日志） */
export function looksLikeRuntimeCommand(text: string | null | undefined) {
  if (!text?.trim()) {
    return false
  }
  // 注意：dontstarve_dedicated_server 是下划线连接符，\b 在词内不生效，需直接匹配标识符
  return /\.(?:sh|bat|cmd)\b/i.test(text)
    || /dontstarve|dedicated_server/i.test(text)
}

/** 从实例状态与 lastCommand/lastError 解析安装阶段文案 */
export function resolveInstallPhase(instance: InstanceItem): string {
  const command = instance.lastCommand?.trim() ?? ''
  const error = instance.lastError?.trim() ?? ''
  const text = `${command}\n${error}`.trim()

  if (instance.status === 'error') {
    return isInstallPhaseFailure(instance) ? '安装失败' : '—'
  }

  if (!text) {
    return instance.status === 'pending_install' ? '等待安装' : '安装中'
  }
  if (text.includes('等待安装')) {
    return '等待安装'
  }
  if (text.includes('正在准备更新')) {
    return '准备更新'
  }
  if (text.includes('正在启动 SteamCMD')) {
    return '启动 SteamCMD'
  }
  if (text.includes('排队等待')) {
    return '排队等待'
  }
  if (text.includes('正在准备')) {
    return '准备安装'
  }
  if (text.includes('登录重试') || text.includes('账号登录')) {
    return '账号登录重试'
  }
  if (/安装进度\s*\d+%/.test(text) || /\[\s*\d+%\]/.test(text) || /update state/i.test(text) || /downloading/i.test(text)) {
    return '下载游戏'
  }
  if (text.includes('安装完成') || text.includes('启动脚本')) {
    return '准备启动'
  }
  if (/\d{1,3}\s*%/.test(text)) {
    return '下载游戏'
  }
  if (instance.status === 'installing' || instance.status === 'pending_install') {
    return '安装处理中'
  }
  return '—'
}

/** 解析安装进度百分比，无则返回 null */
export function extractInstallProgressPercent(instance: InstanceItem): number | null {
  if (typeof instance.installPercent === 'number' && Number.isFinite(instance.installPercent)) {
    return Math.max(0, Math.min(100, instance.installPercent))
  }
  const sources = [instance.lastCommand, instance.lastError]
  for (const text of sources) {
    if (!text) {
      continue
    }
    const normalizedMatch = text.match(/安装进度\s*(\d{1,3})\s*%/)
    if (normalizedMatch) {
      return Math.max(0, Math.min(100, Number(normalizedMatch[1])))
    }
    const bracketMatch = text.match(/\[\s*(\d{1,3})%\]/)
    if (bracketMatch) {
      return Math.max(0, Math.min(100, Number(bracketMatch[1])))
    }
    const progressMatch = text.match(/progress:\s*(\d+(?:\.\d+)?)/i)
    if (progressMatch) {
      return Math.max(0, Math.min(100, Math.round(Number(progressMatch[1]))))
    }
    const genericMatch = text.match(/(\d{1,3})\s*%/)
    if (genericMatch) {
      return Math.max(0, Math.min(100, Number(genericMatch[1])))
    }
  }
  return null
}

/** 是否应在安装列展示详细进度/阶段 */
export function shouldShowInstallDetail(instance: InstanceItem) {
  if (instance.status === 'error') {
    // 只有安装环节失败才谈得上「安装进度 / 安装阶段」；
    // 启动或运行期失败的实例，安装早已就绪，展示安装区块只会把人往重装方向引
    return isInstallPhaseFailure(instance)
  }
  return instance.status === 'pending_install'
    || instance.status === 'installing'
}

/** 是否可打开 SteamCMD 安装日志弹窗 */
export function canOpenInstallLog(instance: InstanceItem) {
  if (instance.status === 'pending_install' || instance.status === 'installing' || instance.status === 'error') {
    return true
  }
  if (instance.lastError?.trim()) {
    return true
  }
  const command = instance.lastCommand?.trim()
  if (!command) {
    return false
  }
  if (looksLikeRuntimeCommand(command)) {
    return false
  }
  return command.includes('安装')
    || command.includes('Steam')
    || command.includes('steamcmd')
    || command.includes('脚本')
}

/** 安装日志数据来源中文 */
export function getInstallLogSourceLabel(source: InstanceInstallLogSource | undefined) {
  switch (source) {
    case 'install_log':
      return '完整 SteamCMD 输出'
    case 'status_summary':
      return '最近状态摘要（非完整日志）'
    case 'empty':
      return '暂无日志'
    default:
      return '未知'
  }
}

/** 安装日志接口状态中文 */
export function getInstallLogStatusLabel(status: InstanceInstallLogPayload['status'] | undefined) {
  switch (status) {
    case 'running':
      return '安装进行中'
    case 'success':
      return '安装成功'
    case 'failed':
      return '安装失败'
    case 'unknown':
      return '未知'
    default:
      return '未知'
  }
}

/** 是否为安装中状态（待安装 / 安装中） */
export function isInstanceInstallingStatus(status: InstanceStatus | undefined) {
  return status === 'pending_install' || status === 'installing'
}

/** 格式化处理进程内存占用（MB） */
export function formatMemoryMb(mb: number | null | undefined) {
  if (mb === null || typeof mb === 'undefined' || !Number.isFinite(mb)) {
    return '—'
  }
  return `${Math.round(mb)} MB`
}

/** 格式化运行时长（秒） */
export function formatUptime(seconds: number | null | undefined) {
  if (seconds === null || typeof seconds === 'undefined' || !Number.isFinite(seconds) || seconds < 0) {
    return '—'
  }
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (days > 0) {
    return `${days}天 ${hours}时`
  }
  if (hours > 0) {
    return `${hours}时 ${minutes}分`
  }
  if (minutes > 0) {
    return `${minutes}分 ${secs}秒`
  }
  return `${secs}秒`
}

/** 根据 runtimeStartedAt 计算当前运行秒数（纯前端 tick） */
export function computeUptimeSecondsFromStartedAt(runtimeStartedAt: string | null | undefined, nowMs = Date.now()) {
  if (!runtimeStartedAt?.trim()) {
    return null
  }
  const started = Date.parse(runtimeStartedAt)
  if (!Number.isFinite(started)) {
    return null
  }
  return Math.max(0, Math.floor((nowMs - started) / 1000))
}

/** 将轮询间隔毫秒转为用户可读刷新文案 */
export function formatPollIntervalHint(ms: number) {
  const seconds = Math.round(ms / 1000)
  return seconds >= 1 ? `每 ${seconds} 秒` : `每 ${ms} 毫秒`
}
