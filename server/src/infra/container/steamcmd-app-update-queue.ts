import { readBrandEnv } from '../../../../shared/brand-env'
import { abortable } from '../../shared/abort'
let chain: Promise<void> = Promise.resolve()
let inFlight = 0
/** 只统计会改写游戏文件的任务；只读的版本查询不能算作安装/更新占用。 */
let fileWriteJobs = 0
const queuedJobs = new Map<string, AbortController>()

export class SteamcmdQueuedJobCancelledError extends Error {
  constructor() { super('SteamCMD 任务已取消（排队期间被取消）') }
}

/** 只退出指定任务的锁等待，不取消正在持锁的 SteamCMD。 */
export function cancelQueuedSteamcmdJob(cancelKey: string): void {
  queuedJobs.get(cancelKey)?.abort(new SteamcmdQueuedJobCancelledError())
}

function resolveInterJobCooldownMs(): number {
  const raw = readBrandEnv('BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS')?.trim()
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed)
    }
  }
  return 4000
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 是否有 SteamCMD 任务正在改写游戏文件（app_update / Workshop 下载）；只读版本查询不计入 */
export function isSteamcmdAppUpdateBusy(): boolean {
  return fileWriteJobs > 0
}

/** 是否有实例正在等待 SteamCMD app_update 锁（含当前即将入队的任务） */
export function isSteamcmdAppUpdateQueued(): boolean {
  return inFlight > 1
}

export interface SteamcmdAppUpdateLockOptions {
  signal?: AbortSignal
  cancelKey?: string
  /** 当前任务需等待其他 app_update 完成时调用（用于更新排队 UI） */
  onQueued?: () => void | Promise<void>
  /**
   * 任务类型：只有 app-update（及 Workshop 下载）会改写游戏文件。
   * 版本查询是只读的，仍按顺序排队，但不能把面板标成「正在安装或更新」。
   */
  kind?: 'app-update' | 'app-info'
}

/**
 * SteamCMD app_update 全局串行：并发多实例安装会导致 Missing configuration / 0x602。
 */
export async function withSteamcmdAppUpdateLock<T>(
  _jobId: string,
  fn: () => Promise<T>,
  options?: SteamcmdAppUpdateLockOptions,
): Promise<T> {
  const previous = chain
  let release!: () => void
  chain = new Promise<void>(resolve => {
    release = resolve
  })
  inFlight++
  const writesFiles = (options?.kind ?? 'app-update') === 'app-update'
  if (writesFiles) fileWriteJobs++
  let started = false
  const cancelKey = options?.cancelKey
  const controller = cancelKey ? new AbortController() : undefined
  if (controller && cancelKey) queuedJobs.set(cancelKey, controller)
  const signal = controller
    ? (options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal)
    : options?.signal
  const forgetQueuedJob = () => {
    if (options?.cancelKey && queuedJobs.get(options.cancelKey) === controller) queuedJobs.delete(options.cancelKey)
  }
  try {
    if (inFlight > 1 && options?.onQueued) {
      await options.onQueued()
    }
    await abortable(previous, signal)
    signal?.throwIfAborted()
    forgetQueuedJob()
    started = true
    return await fn()
  }
  finally {
    forgetQueuedJob()
    inFlight--
    if (writesFiles) fileWriteJobs--
    if (started) {
      const cooldownMs = resolveInterJobCooldownMs()
      if (cooldownMs > 0) await sleep(cooldownMs)
      release()
    }
    else {
      // 取消立即返回，但链中的占位仍等前序完成，后续任务不能越过正在运行的任务。
      void previous.then(release)
    }
  }
}
