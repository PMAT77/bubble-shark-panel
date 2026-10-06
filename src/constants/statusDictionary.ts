import type { ShardContainerStatus } from '@/api/modules/shard'

/**
 * 全站状态词典（唯一出处）。
 *
 * 规则：
 * 1. 同一状态在全站只有一个中文词、一个语义色（label + tone）；
 * 2. 展示端通过 statusTagType()/statusBadgeClass() 取用，禁止在页面内自造颜色或叫法；
 * 3. 新状态先入词典再上界面。
 */

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

export interface StatusDescriptor {
  /** 用户可见的中文词（一词一义） */
  label: string
  /** 语义色 */
  tone: StatusTone
  /** lucide 图标名（i-lucide:*） */
  icon: string
}

/** tone → naive-ui NTag type */
const TAG_TYPE_BY_TONE = {
  neutral: 'default',
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
} as const

export function statusTagType(tone: StatusTone): (typeof TAG_TYPE_BY_TONE)[StatusTone] {
  return TAG_TYPE_BY_TONE[tone]
}

const BADGE_CLASS_BY_TONE: Record<StatusTone, string> = {
  neutral: 'bg-slate-500/10 text-slate-600 dark:text-slate-300',
  info: 'bg-sky-500/10 text-sky-600 dark:text-sky-300',
  success: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-300',
  error: 'bg-red-500/10 text-red-600 dark:text-red-300',
}

export function statusBadgeClass(tone: StatusTone): string {
  return BADGE_CLASS_BY_TONE[tone]
}

/** tone → 行内文本色（用于列表中的纯文本状态） */
export function statusTextClass(tone: StatusTone): string {
  switch (tone) {
    case 'success':
      return 'text-emerald-600 dark:text-emerald-400'
    case 'warning':
      return 'text-amber-600 dark:text-amber-400'
    case 'error':
      return 'text-red-600 dark:text-red-400'
    case 'info':
      return 'text-sky-600 dark:text-sky-400'
    default:
      return 'text-muted-foreground'
  }
}

/* ---------------------------------- 实例 ---------------------------------- */

/**
 * 实例展示状态（error 在展示层拆分为 install_failed / runtime_error，
 * 由 instanceDisplay.getInstanceState 依据 lastErrorPhase 判定）。
 */
export type InstanceDisplayState =
  | 'pending_install'
  | 'installing'
  | 'running'
  | 'stopped'
  | 'install_failed'
  | 'runtime_error'

export const INSTANCE_STATE: Record<InstanceDisplayState, StatusDescriptor> = {
  pending_install: { label: '未安装', tone: 'warning', icon: 'i-lucide:package-open' },
  installing: { label: '安装中', tone: 'info', icon: 'i-lucide:loader-circle' },
  running: { label: '运行中', tone: 'success', icon: 'i-lucide:play' },
  stopped: { label: '已停止', tone: 'neutral', icon: 'i-lucide:square' },
  install_failed: { label: '安装失败', tone: 'error', icon: 'i-lucide:package-x' },
  runtime_error: { label: '运行异常', tone: 'error', icon: 'i-lucide:triangle-alert' },
}

export const INSTANCE_STARTING: StatusDescriptor = { label: '启动中', tone: 'warning', icon: 'i-lucide:loader-circle' }
export const INSTANCE_START_FAILED: StatusDescriptor = { label: '启动失败', tone: 'error', icon: 'i-lucide:triangle-alert' }

/** 仅有原始枚举（无 lastErrorPhase 上下文）时的兜底：error 展示为运行异常 */
export const INSTANCE_STATUS: Record<InstanceDisplayState | 'error', StatusDescriptor> = {
  ...INSTANCE_STATE,
  error: INSTANCE_STATE.runtime_error,
}

/* ------------------------------ 世界（分片） ------------------------------ */

export const SHARD_CONTAINER_STATUS: Record<ShardContainerStatus, StatusDescriptor> = {
  running: { label: '运行中', tone: 'success', icon: 'i-lucide:play' },
  stopped: { label: '未运行', tone: 'neutral', icon: 'i-lucide:square' },
  not_created: { label: '未配置', tone: 'warning', icon: 'i-lucide:circle-dashed' },
  unknown: { label: '未知', tone: 'neutral', icon: 'i-lucide:circle-help' },
}

export const SHARD_UNCONFIGURED: StatusDescriptor = SHARD_CONTAINER_STATUS.not_created

/** 分片展示状态的判定输入（世界列表 / 实例详情 / 世界设置复用的最小字段集） */
export interface ShardDisplayFacts {
  /** 分片配置是否就绪（磁盘上存在 server.ini） */
  configured: boolean
  /** 运行容器状态（服务端 resolveShardContainerStatus） */
  containerStatus: ShardContainerStatus
  /** 世界存档是否已生成（save 目录非空）；世界列表摘要接口暂不提供，缺省视为未生成 */
  worldGenerated?: boolean
}

/**
 * 分片展示状态。
 *
 * 容器状态只表示「运行容器是否存在」——面板停止实例时会连同容器一起删除以释放内存，
 * 因此容器不存在并不代表没有配置或没有存档；仅当两者皆无时才显示「未配置」。
 */
export function resolveShardDisplayStatus(shard: ShardDisplayFacts | null | undefined): StatusDescriptor {
  if (!shard || shard.containerStatus === 'unknown') {
    return SHARD_CONTAINER_STATUS.unknown
  }
  if (shard.containerStatus === 'running') {
    return SHARD_CONTAINER_STATUS.running
  }
  if (shard.containerStatus === 'stopped') {
    return SHARD_CONTAINER_STATUS.stopped
  }
  return shard.configured || shard.worldGenerated === true
    ? SHARD_CONTAINER_STATUS.stopped
    : SHARD_CONTAINER_STATUS.not_created
}

/* ---------------------------------- 模组 ---------------------------------- */

/**
 * Mod 安装状态：只回答「文件在不在服务器上」。
 *
 * 与「开关状态」是两件事：文件没就绪，开关根本点不动；文件就绪了，还要在世界设置里开启才会被
 * 游戏加载。这里不再写「待开启」之类的后缀——开关状态紧挨着它单独成列，写在标签里会自相矛盾
 * （已开启的行显示「待开启」）。开启引导放在订阅成功的提示里。
 */
export const MOD_INSTALL_STATUS: Record<'pending' | 'ready' | 'failed', StatusDescriptor> = {
  pending: { label: '下载中', tone: 'info', icon: 'i-lucide:download' },
  ready: { label: '已就绪', tone: 'success', icon: 'i-lucide:package-check' },
  failed: { label: '下载失败', tone: 'error', icon: 'i-lucide:download-x' },
}

export const MOD_ENABLED_STATUS: Record<'enabled' | 'disabled', StatusDescriptor> = {
  enabled: { label: '已开启', tone: 'success', icon: 'i-lucide:toggle-right' },
  disabled: { label: '已关闭', tone: 'neutral', icon: 'i-lucide:toggle-left' },
}

/** Mod 版本状态：只回答「是不是创意工坊上的最新版」，unknown 表示信息不足，绝不显示成「已是最新」 */
export const MOD_UPDATE_STATUS: Record<'outdated' | 'up_to_date' | 'unknown', StatusDescriptor> = {
  outdated: { label: '有新版本', tone: 'warning', icon: 'i-lucide:arrow-up-circle' },
  up_to_date: { label: '已是最新', tone: 'success', icon: 'i-lucide:badge-check' },
  unknown: { label: '未检查', tone: 'neutral', icon: 'i-lucide:help-circle' },
}

/* -------------------------------- 洞穴功能 -------------------------------- */

export const CAVES_FEATURE_STATUS: Record<'off' | 'on' | 'error', StatusDescriptor> = {
  off: { label: '未开启', tone: 'neutral', icon: 'i-lucide:circle-off' },
  on: { label: '已开启', tone: 'success', icon: 'i-lucide:circle-check' },
  error: { label: '配置异常', tone: 'warning', icon: 'i-lucide:triangle-alert' },
}

/** 房间/世界配置读取失败时的展示态（与「运行异常」「安装失败」区分命名与颜色） */
export const CONFIG_ERROR_STATUS: StatusDescriptor = {
  label: '配置异常',
  tone: 'warning',
  icon: 'i-lucide:triangle-alert',
}
