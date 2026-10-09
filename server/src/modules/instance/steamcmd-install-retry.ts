import { isRetriableSteamcmdInstallOutput } from '../../infra/container/steamcmd-errors'
import { loadSteamcmdRuntimeConfig } from '../../shared/config/steamcmd'
import { abortableDelay } from '../../shared/abort'

interface InstallAttemptResult { ok: boolean, output: string, cancelled?: boolean }

/** 每种登录方式使用同一重试预算；不清理清单或下载缓存。 */
export async function retrySteamcmdInstall(input: {
  run: () => Promise<InstallAttemptResult>
  signal?: AbortSignal
  isCancelled: () => boolean
  onRetry: (attempt: number, maxAttempts: number, delayMs: number) => Promise<void>
}): Promise<InstallAttemptResult> {
  const { installMaxAttempts, installRetryDelaysMs } = loadSteamcmdRuntimeConfig()
  let result: InstallAttemptResult = { ok: false, output: '', cancelled: true }
  for (let attempt = 1; attempt <= installMaxAttempts; attempt++) {
    if (input.isCancelled()) return { ...result, ok: false, cancelled: true }
    if (attempt > 1) {
      const delayMs = installRetryDelaysMs[attempt - 2] ?? installRetryDelaysMs.at(-1) ?? 8000
      await input.onRetry(attempt, installMaxAttempts, delayMs)
      await abortableDelay(delayMs, input.signal)
      if (input.isCancelled()) return { ...result, ok: false, cancelled: true }
    }
    result = await input.run()
    if (result.ok || result.cancelled || !isRetriableSteamcmdInstallOutput(result.output)) break
  }
  return result
}
