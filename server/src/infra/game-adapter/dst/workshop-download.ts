import fs from 'node:fs'
import path from 'node:path'
import type { ModDownloadProgress, ModInstallJobPhase, ModDownloadFailureStage } from '../../../../../shared/contracts/mod'
import { ContentTransaction } from '../../backup/content-transaction'
import { prepareDstModContent } from './mod-content-install'
import { assertWorkshopId, inspectContentTree, assertFreeSpace } from './mod-content'
import { resolveDstSteamWorkshopModDir } from './constants'
import { withInstallPathLock } from '../../../shared/instance-content/install-lock'
import { assertInstanceContentAvailable } from '../../../shared/instance-content/operation'
import { hasUnconfirmedSteamcmdJob } from '../../container/steamcmd-runner'
import { loadServerConfig } from '../../../shared/config'
import { readBrandEnv } from '../../../../../shared/brand-env'
import { resolveSteamProxyConfig } from './steam-http'
import { WorkshopWorker, type WorkshopContentResult } from './workshop-worker'
import { loadSteamcmdRuntimeConfig, resolveWorkshopCdnDownloadTimeoutMs } from '../../../shared/config/steamcmd'

export interface WorkshopDownloadProgress { workshopId: string, phase: ModInstallJobPhase, progress: ModDownloadProgress | null, error?: string,
  reusedBytes?: number, failureStage?: ModDownloadFailureStage, errorCode?: string }
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
  return Boolean(controller)
}

const workers = new Map<string, { worker: WorkshopWorker, leases: number }>()
let cacheRootForTest: string | undefined
export function setWorkshopCacheRootForTest(value?: string): void { cacheRootForTest = value }

/** Cancelling one subscriber never kills another instance's shared download. */
async function runWorker(input: WorkshopDownloadInput, cacheRoot: string, signal: AbortSignal) {
  let owner = workers.get(cacheRoot)
  if (!owner || owner.worker.closed) {
    const proxy = resolveSteamProxyConfig()
    const configuredMax = Number(readBrandEnv('BSP_MOD_CACHE_MAX_BYTES'))
    const worker = new WorkshopWorker({ cacheRoot, httpProxy: proxy?.url || loadSteamcmdRuntimeConfig().httpsProxy || undefined,
      noProxy: proxy?.bypass ?? [], maxCacheBytes: Number.isSafeInteger(configuredMax) && configuredMax >= 0 && readBrandEnv('BSP_MOD_CACHE_MAX_BYTES') ? configuredMax : 5 * 1024 ** 3 },
    message => { try { (input.onLogLine ?? console.info)(message) } catch { /* Diagnostics do not own task completion. */ } })
    // Leases survive worker crashes until the parent has finished copying content.
    owner = { worker, leases: owner?.leases ?? 0 }
    workers.set(cacheRoot, owner)
  }
  owner.leases++
  const handles = input.workshopIds.map(workshopId => owner!.worker.acquire({ workshopId, instanceId: input.instanceId, signal,
    existingRoot: path.dirname(resolveDstSteamWorkshopModDir(input.hostInstallPath, workshopId)),
    legacyCacheRoot: path.join(input.hostInstallPath, '.bsp-mod-download-cache'), timeoutMs: resolveWorkshopCdnDownloadTimeoutMs(),
    onProgress: event => {
      if (!signal.aborted && ['waiting_download', 'preparing_download', 'downloading', 'verifying'].includes(event.phase)) input.onProgress?.(event)
    } }))
  const results = await Promise.all(handles.map(async (handle, index): Promise<WorkshopContentResult> => {
    try { return await handle.result }
    catch (error) { return { workshopId: input.workshopIds[index]!, ok: false, error: signal.aborted ? '下载已取消' : (error as Error).message, failureStage: 'connection', errorCode: 'WORKSHOP_WORKER_FAILED' } }
  }))
  return { results, cancelled: signal.aborted, release: () => {
    for (const handle of handles) handle.release()
    const current = workers.get(cacheRoot)!
    current.leases--
    if (!current.leases) current.worker.prune()
  } }
}

export const WORKSHOP_CONTENT_VERSION_FILE = '.bsp-workshop-download.json'
type WorkerResult = { results: WorkshopContentResult[], cancelled: boolean, release?: () => void }
let workerRunner: (input: WorkshopDownloadInput, cacheRoot: string, signal: AbortSignal) => Promise<WorkerResult> = runWorker
export function setWorkshopDownloadWorkerForTest(value?: typeof workerRunner): void { workerRunner = value ?? runWorker }

export async function runWorkshopDownload(input: WorkshopDownloadInput): Promise<WorkshopDownloadResult> {
  for (const id of input.workshopIds) assertWorkshopId(id)
  if (!input.workshopIds.length) return { ok: true, items: [] }
  const key = input.cancelKey?.trim() || input.instanceId
  const controller = new AbortController()
  running.set(key, controller)
  let release: (() => void) | undefined
  const log = (message: string) => { try { (input.onLogLine ?? console.info)(message) } catch { /* Logging cannot undo an installation. */ } }
  try {
    for (const workshopId of input.workshopIds) input.onProgress?.({ workshopId, phase: 'preparing_download', progress: null })
    let cacheRoot = cacheRootForTest ?? path.join(path.dirname(loadServerConfig().dbPath), 'cache', 'steam-workshop', 'v1')
    try { fs.mkdirSync(cacheRoot, { recursive: true }); fs.accessSync(cacheRoot, fs.constants.W_OK) }
    catch {
      cacheRoot = path.join(input.hostInstallPath, '.bsp-mod-download-cache')
      fs.mkdirSync(cacheRoot, { recursive: true })
    }
    assertFreeSpace(input.hostInstallPath, 0)
    const downloaded = await workerRunner(input, cacheRoot, controller.signal)
    release = downloaded.release
    const { results, cancelled } = downloaded
    const items: NonNullable<WorkshopDownloadResult['items']> = []
    const errors: string[] = []
    for (const result of results) {
      if (result.diagnostics) log(`[workshop] ${JSON.stringify({ instanceId: input.instanceId, workshopId: result.workshopId, manifestId: result.manifestId,
        reusedBytes: result.reusedBytes, totalBytes: result.totalBytes, failureStage: result.failureStage, ...result.diagnostics })}`)
      if (!result.ok) {
        items.push({ workshopId: result.workshopId, ok: false }); errors.push(result.error ?? '下载失败')
        if (!controller.signal.aborted) input.onProgress?.({ workshopId: result.workshopId, phase: 'verifying', progress: null,
          error: result.error ?? 'Mod 下载失败', failureStage: result.failureStage, errorCode: result.errorCode })
        continue
      }
      if (controller.signal.aborted) { items.push({ workshopId: result.workshopId, ok: false }); continue }
      const waitStarted = performance.now()
      try {
        await withInstallPathLock(input.hostInstallPath, async () => {
          let transaction: ContentTransaction<null> | undefined
          const installStarted = performance.now()
          try {
            controller.signal.throwIfAborted()
            assertInstanceContentAvailable(input.instanceId)
            if (hasUnconfirmedSteamcmdJob(input.instanceId)) throw new Error('安装任务清理未完成，请先停止实例')
            if (!result.manifestId || !/^\d+$/.test(result.manifestId) || !result.updatedAt || !Number.isFinite(Date.parse(result.updatedAt))) throw new Error('下载版本凭据无效')
            const source = path.join(cacheRoot, result.workshopId, result.manifestId, 'content')
            if (path.resolve(result.sourceDir ?? '') !== path.resolve(source)) throw new Error('下载目录越界')
            await inspectContentTree(source, { requireModInfo: true })
            input.onProgress?.({ workshopId: result.workshopId, phase: 'installing', progress: null })
            transaction = new ContentTransaction(input.hostInstallPath, null)
            await prepareDstModContent(transaction, input.hostInstallPath, result.workshopId, source, { workshopVersion: { manifestId: result.manifestId, updatedAt: result.updatedAt } })
            controller.signal.throwIfAborted()
            transaction.apply()
            transaction.commit()
            items.push({ workshopId: result.workshopId, ok: true, installed: true })
            log(`[workshop] ${JSON.stringify({ instanceId: input.instanceId, workshopId: result.workshopId, installed: true,
              installWaitMs: installStarted - waitStarted, installMs: performance.now() - installStarted })}`)
          }
          catch (error) { transaction?.rollback(() => {}); throw error }
        }, { signal: controller.signal, onQueued: () => input.onProgress?.({ workshopId: result.workshopId, phase: 'waiting_install', progress: null }) })
      }
      catch (error) {
        input.onProgress?.({ workshopId: result.workshopId, phase: 'installing', progress: null, error: (error as Error).message, failureStage: 'install', errorCode: 'WORKSHOP_INSTALL_FAILED' })
        items.push({ workshopId: result.workshopId, ok: false })
        errors.push((error as Error).message)
      }
    }
    return { ok: items.every(item => item.ok) && !controller.signal.aborted, cancelled: cancelled || controller.signal.aborted, items, ...(errors.length ? { error: errors.join('；') } : {}) }
  }
  catch (error) {
    return { ok: false, cancelled: controller.signal.aborted, error: controller.signal.aborted ? '下载已取消' : (error as Error).message }
  }
  finally { release?.(); if (running.get(key) === controller) running.delete(key) }
}
