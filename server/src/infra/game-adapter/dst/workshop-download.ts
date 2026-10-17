import fs from 'node:fs'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ModDownloadProgress, ModInstallJobPhase } from '../../../../../shared/contracts/mod'
import { ContentTransaction } from '../../backup/content-transaction'
import { prepareDstModContent } from './mod-content-install'
import { assertWorkshopId, inspectContentTree, assertFreeSpace } from './mod-content'
import { resolveDstSteamWorkshopModDir } from './constants'
import { withSteamcmdAppUpdateLock, cancelQueuedSteamcmdJob } from '../../container/steamcmd-app-update-queue'
import { loadSteamcmdRuntimeConfig, resolveSteamcmdWorkshopDownloadTimeoutMs } from '../../../shared/config/steamcmd'

export interface WorkshopDownloadProgress { workshopId: string, phase: ModInstallJobPhase, progress: ModDownloadProgress | null, error?: string }
export interface WorkshopDownloadInput {
  hostInstallPath: string
  workshopIds: string[]
  instanceId: string
  force?: boolean
  cancelKey?: string
  onLogLine?: (line: string) => void
  onAwaitingSteamcmdLock?: () => void | Promise<void>
  onPreparingSteamcmd?: () => void
  onDownloadStart?: () => void
  onProgress?: (event: WorkshopDownloadProgress) => void
}
interface VerifiedContent { workshopId: string, ok: boolean, sourceDir?: string, manifestId?: string, updatedAt?: string, error?: string }
export interface WorkshopDownloadResult {
  ok: boolean
  error?: string
  cancelled?: boolean
  items?: Array<{ workshopId: string, ok: boolean, installed?: boolean }>
}
const running = new Map<string, AbortController>()
export function cancelDstWorkshopDownloads(cancelKey: string): boolean {
  const controller = running.get(cancelKey)
  controller?.abort()
  cancelQueuedSteamcmdJob(cancelKey)
  return Boolean(controller)
}

/** Only byte events from this worker attempt reach the queue. Killing the child
 * stops SDK callbacks and keeps partial files outside the installed content. */
async function runWorker(input: WorkshopDownloadInput, cacheRoot: string, signal: AbortSignal) {
  return new Promise<{ results: VerifiedContent[], cancelled: boolean }>((resolve, reject) => {
    const worker = new URL(import.meta.url.endsWith('.js') ? './mod-download-worker.js' : './mod-download-worker.mjs', import.meta.url)
    const child = fork(fileURLToPath(worker), [], {
      execArgv: [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), '--max-old-space-size=256'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    const results = new Map<string, VerifiedContent>()
    let error: string | null = null
    let stopped = false
    let cancelled = false
    const stop = () => { stopped = true; cancelled = true; child.kill('SIGKILL') }
    signal.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => { stopped = true; error = 'Mod 下载超时，请重试'; child.kill('SIGKILL') }, resolveSteamcmdWorkshopDownloadTimeoutMs())
    child.on('message', (message: any) => {
      if (stopped || signal.aborted) return
      if (message?.type === 'progress' && input.workshopIds.includes(message.event?.workshopId)) {
        const event = message.event
        if (event.phase === 'verified') results.set(event.workshopId, event)
        else if (['preparing_download', 'downloading', 'verifying'].includes(event.phase)) input.onProgress?.(event)
        else if (event.ok === false) {
          results.set(event.workshopId, event)
          input.onProgress?.({ workshopId: event.workshopId, phase: 'verifying', progress: null, error: event.error ?? 'Mod 下载失败' })
        }
      }
      if (message?.type === 'result' && Array.isArray(message.results)) {
        for (const result of message.results) if (input.workshopIds.includes(result.workshopId)) results.set(result.workshopId, result)
      }
      if (message?.type === 'error') error = message.error
    })
    child.once('error', value => { error = value.message })
    child.once('close', code => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      if (error && results.size === 0 && !cancelled) return reject(new Error(error))
      for (const workshopId of input.workshopIds) if (!results.has(workshopId)) {
        results.set(workshopId, { workshopId, ok: false, error: error ?? (cancelled ? '下载已取消' : `下载进程异常结束（${code}）`) })
      }
      resolve({ results: [...results.values()], cancelled })
    })
    child.send({ ids: input.workshopIds, cacheRoot,
      existingRoot: path.dirname(resolveDstSteamWorkshopModDir(input.hostInstallPath, input.workshopIds[0]!)),
      httpProxy: loadSteamcmdRuntimeConfig().httpsProxy || undefined })
    if (signal.aborted) stop()
  })
}

export const WORKSHOP_CONTENT_VERSION_FILE = '.bsp-workshop-download.json'
let workerRunner = runWorker
export function setWorkshopDownloadWorkerForTest(value?: typeof runWorker): void { workerRunner = value ?? runWorker }

export async function runWorkshopDownload(input: WorkshopDownloadInput): Promise<WorkshopDownloadResult> {
  for (const id of input.workshopIds) assertWorkshopId(id)
  if (!input.workshopIds.length) return { ok: true, items: [] }
  const key = input.cancelKey?.trim() || input.instanceId
  const controller = new AbortController()
  running.set(key, controller)
  try {
    return await withSteamcmdAppUpdateLock(key, async () => {
      for (const workshopId of input.workshopIds) input.onProgress?.({ workshopId, phase: 'preparing_download', progress: null })
      const cacheRoot = path.join(input.hostInstallPath, '.bsp-mod-download-cache')
      fs.mkdirSync(cacheRoot, { recursive: true })
      assertFreeSpace(input.hostInstallPath, 0)
      const { results, cancelled } = await workerRunner(input, cacheRoot, controller.signal)
      const items: NonNullable<WorkshopDownloadResult['items']> = []
      const errors: string[] = []
      for (const result of results) {
        if (!result.ok) { items.push({ workshopId: result.workshopId, ok: false }); errors.push(result.error ?? '下载失败'); continue }
        let transaction: ContentTransaction<null> | undefined
        try {
          if (!result.manifestId || !/^\d+$/.test(result.manifestId) || !result.updatedAt || !Number.isFinite(Date.parse(result.updatedAt))) throw new Error('下载版本凭据无效')
          const source = path.join(cacheRoot, result.workshopId, result.manifestId, 'content')
          if (path.resolve(result.sourceDir ?? '') !== path.resolve(source)) throw new Error('下载目录越界')
          await inspectContentTree(source, { requireModInfo: true })
          input.onProgress?.({ workshopId: result.workshopId, phase: 'installing', progress: null })
          fs.writeFileSync(path.join(source, WORKSHOP_CONTENT_VERSION_FILE), JSON.stringify({ manifestId: result.manifestId, updatedAt: result.updatedAt }))
          transaction = new ContentTransaction(input.hostInstallPath, null)
          await prepareDstModContent(transaction, input.hostInstallPath, result.workshopId, source)
          transaction.apply()
          transaction.commit()
          items.push({ workshopId: result.workshopId, ok: true, installed: true })
        }
        catch (error) {
          transaction?.rollback(() => {})
          input.onProgress?.({ workshopId: result.workshopId, phase: 'installing', progress: null, error: (error as Error).message })
          items.push({ workshopId: result.workshopId, ok: false })
          errors.push((error as Error).message)
        }
      }
      return { ok: items.every(item => item.ok), cancelled, items, ...(errors.length ? { error: errors.join('；') } : {}) }
    }, { signal: controller.signal, cancelKey: key, onQueued: input.onAwaitingSteamcmdLock })
  }
  catch (error) {
    return { ok: false, cancelled: controller.signal.aborted, error: controller.signal.aborted ? '下载已取消' : (error as Error).message }
  }
  finally { if (running.get(key) === controller) running.delete(key) }
}
