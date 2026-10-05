import { readBrandEnv } from '../../../../shared/brand-env'
let chain: Promise<void> = Promise.resolve()
let inFlight = 0

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

/** 是否有其他实例正在执行 SteamCMD app_update */
export function isSteamcmdAppUpdateBusy(): boolean {
  return inFlight > 0
}

/** 是否有实例正在等待 SteamCMD app_update 锁（含当前即将入队的任务） */
export function isSteamcmdAppUpdateQueued(): boolean {
  return inFlight > 1
}

export interface SteamcmdAppUpdateLockOptions {
  /** 当前任务需等待其他 app_update 完成时调用（用于更新排队 UI） */
  onQueued?: () => void | Promise<void>
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
  if (inFlight > 1 && options?.onQueued) {
    await options.onQueued()
  }

  await previous

  try {
    return await fn()
  }
  finally {
    inFlight--
    const cooldownMs = resolveInterJobCooldownMs()
    if (cooldownMs > 0) {
      await sleep(cooldownMs)
    }
    release()
  }
}
