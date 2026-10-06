import type { PanelUpdateStatus } from '@/api/modules/system'

type PanelImage = PanelUpdateStatus['image']
type UpdateKind = PanelUpdateStatus['updateKind']
type UpdatePhase = PanelUpdateStatus['updatePhase']

/** 主按钮语义：download 开始下载；install 重建面板；busy 进行中；none 不可用 */
export type PanelUpdateActionKind = 'download' | 'install' | 'busy' | 'none'

export interface PanelUpdatePresentation {
  /** 版本主行，例如「当前版本：v0.2.2 · 已是最新」 */
  versionLine: string
  /** 有更新但当前部署方式不能在面板内更新时为 true */
  needsManualCommand: boolean
  /** 更新进行中或失败时的过程说明；没有进行中的更新且没有失败时为 null */
  phaseLine: string | null
  /** 上一次更新失败，需用户处理后重试 */
  updateFailed: boolean
  /** 下载中的下载量，例如「已下载 512 MB / 1.2 GB」；其它阶段为 null */
  progressText: string | null
  /** 主按钮语义 */
  action: PanelUpdateActionKind
  /** 主按钮文案 */
  actionLabel: string
}

/** 四种环境原因的解决办法完全一样，对用户只说一句 */
export const MANUAL_UPDATE_NOTE = '这种安装方式无法在面板里更新，请在服务器上执行'

const PHASE_LINES: Record<UpdatePhase, string> = {
  idle: '',
  preparing: '正在准备…',
  downloading: '正在下载更新，请勿关闭页面…',
  downloaded: '更新已下载，点「立即安装」完成更新。',
  installing: '正在准备安装…',
  recreating: '正在安装，约 30 秒后自动返回…',
  failed: '',
}

/**
 * Native 的更新物件是「更新包」，安装动作还会重启面板服务，
 * 所以文案不能复用镜像那套（说「镜像」「30 秒」都会误导）。
 */
const NATIVE_PHASE_LINES: Record<UpdatePhase, string> = {
  idle: '',
  preparing: '正在检查磁盘空间…',
  downloading: '正在下载更新包，请勿关闭页面…',
  downloaded: '更新包已就绪，点「立即安装」完成更新。',
  installing: '正在准备安装…',
  recreating: '正在安装并重启面板，约 1-3 分钟后自动重连…',
  failed: '',
}

function phaseLines(status: PanelUpdateStatus): Record<UpdatePhase, string> {
  return status.runtimeMode === 'native' ? NATIVE_PHASE_LINES : PHASE_LINES
}

/** 版本主行的进行中后缀：下载与安装是两段，分开说清楚 */
const RUNNING_SUFFIX: Partial<Record<UpdatePhase, string>> = {
  preparing: '正在准备下载',
  downloading: '正在下载更新',
  installing: '正在安装更新',
  recreating: '正在安装更新',
}

/** 进行中的按钮文案 */
const BUSY_LABELS: Partial<Record<UpdatePhase, string>> = {
  preparing: '下载中…',
  downloading: '下载中…',
  installing: '安装中…',
  recreating: '安装中…',
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** 人类可读的字节数：不足 10 时保留一位小数（1.2 GB），否则取整（512 MB） */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const rounded = unitIndex > 0 && value < 10 ? Math.round(value * 10) / 10 : Math.round(value)
  return `${rounded} ${BYTE_UNITS[unitIndex]}`
}

/** 下载量文本；registry 没给总量时只说已下载多少，绝不显示「/ 0 B」这种假总量 */
function buildProgressText(status: PanelUpdateStatus): string | null {
  if (status.updatePhase !== 'downloading' || status.downloadBytes == null) {
    return null
  }
  const total = status.downloadTotalBytes
  if (total == null || total <= 0) {
    return `已下载 ${formatByteSize(status.downloadBytes)}`
  }
  return `已下载 ${formatByteSize(Math.min(status.downloadBytes, total))} / ${formatByteSize(total)}`
}

function resolveLocalVersion(image: PanelImage): string | null {
  const label = image.releaseVersion?.trim()
  if (label) {
    return label
  }
  const tag = image.tag?.trim()
  // latest 是可变标签，不能当作版本号展示。
  if (tag && tag !== 'latest') {
    return tag
  }
  return null
}

function buildVersionLine(version: string | null, suffix: string): string {
  return `当前版本：${version ?? '未知'} · ${suffix}`
}

/** 旧后端没有 updateKind 时退回按 updateAvailable 推断，避免误显示为「已是最新」 */
function resolveUpdateKind(status: PanelUpdateStatus, latestVersion: string | null): UpdateKind {
  if (status.updateKind) {
    return status.updateKind
  }
  if (!status.image.updateAvailable) {
    return 'none'
  }
  return latestVersion ? 'newer' : 'unknown'
}

/**
 * 过程说明：后端的 updateMessage 优先（它知道更细的情况，比如「本地已有镜像」），
 * 否则按阶段给一句通用文案；旧后端只有 updating 布尔值时退化为原提示。
 */
function resolvePhaseLine(status: PanelUpdateStatus): string | null {
  if (status.updatePhase === 'failed') {
    return status.updateError?.trim() || '更新失败，请稍后重试。'
  }
  if (!status.updatePhase || status.updatePhase === 'idle') {
    return status.updating ? '正在更新，稍后自动返回…' : null
  }
  return status.updateMessage?.trim() || phaseLines(status)[status.updatePhase] || null
}

/** 主按钮：下载 → 立即安装两段，能安装就不再让人重新下载 */
function resolveAction(status: PanelUpdateStatus): Pick<PanelUpdatePresentation, 'action' | 'actionLabel'> {
  const busyLabel = BUSY_LABELS[status.updatePhase]
  if (busyLabel) {
    return { action: 'busy', actionLabel: busyLabel }
  }
  if (status.checkError || status.image.checkError) {
    return { action: 'none', actionLabel: '下载更新' }
  }
  // Native（systemd）与 Docker 的安装机制不同，但对用户都是「下载 → 立即安装」两段
  const installable = status.image.updateAvailable
    && (status.imageApplySupported || status.nativeUpdateSupported === true)
  // 更新内容已就绪（离线导入、面板预下载完成、或安装失败但包还在）：下一步只剩安装
  if (installable && status.targetImageReady) {
    return { action: 'install', actionLabel: '立即安装' }
  }
  if (installable) {
    return {
      action: 'download',
      actionLabel: status.updatePhase === 'failed' ? '重新下载' : '下载更新',
    }
  }
  // 面板内更新不可用：按钮只是状态提示，真正出路是旁边的手动命令
  return { action: 'none', actionLabel: '下载更新' }
}

export function buildPanelUpdatePresentation(status: PanelUpdateStatus | null): PanelUpdatePresentation {
  if (!status) {
    return {
      versionLine: '',
      needsManualCommand: false,
      phaseLine: null,
      updateFailed: false,
      progressText: null,
      action: 'none',
      actionLabel: '下载更新',
    }
  }

  const image = status.image
  const version = resolveLocalVersion(image)
  const latestVersion = status.release?.tagName?.trim() || null
  const phaseLine = resolvePhaseLine(status)
  const updateFailed = status.updatePhase === 'failed'
  const progressText = buildProgressText(status)
  const { action, actionLabel } = resolveAction(status)

  if (status.updating) {
    return {
      versionLine: buildVersionLine(version, RUNNING_SUFFIX[status.updatePhase] ?? '更新进行中'),
      needsManualCommand: false,
      phaseLine,
      updateFailed,
      progressText,
      action,
      actionLabel,
    }
  }

  let suffix = '已是最新'
  switch (resolveUpdateKind(status, latestVersion)) {
    case 'newer':
      suffix = latestVersion ? `有新版本 ${latestVersion}` : '有新版本'
      break
    case 'same-version-changed':
      suffix = '已发布更新'
      break
    case 'unknown':
      suffix = '检测到有新更新'
      break
    case 'none':
    default:
      suffix = '已是最新'
      break
  }
  const checkFailed = Boolean(status.checkError || image.checkError)
  if (checkFailed) {
    suffix = '检查失败，无法确认是否最新'
  }

  return {
    versionLine: buildVersionLine(version, suffix),
    needsManualCommand: !checkFailed && image.updateAvailable
      && !status.imageApplySupported
      && status.nativeUpdateSupported !== true,
    phaseLine,
    updateFailed,
    progressText,
    action,
    actionLabel,
  }
}
