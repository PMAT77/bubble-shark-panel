import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { ModDownloadFailureStage, ModDownloadProgress, ModInstallJobPhase } from '../../../../../shared/contracts/mod'

export interface WorkshopContentResult {
  workshopId: string
  ok: boolean
  sourceDir?: string
  manifestId?: string
  updatedAt?: string
  reusedBytes?: number
  totalBytes?: number
  error?: string
  failureStage?: ModDownloadFailureStage
  errorCode?: string
  diagnostics?: Record<string, unknown>
}
export interface WorkshopProgressEvent {
  workshopId: string
  phase: ModInstallJobPhase
  progress: ModDownloadProgress | null
  reusedBytes?: number
  error?: string
  failureStage?: ModDownloadFailureStage
  errorCode?: string
}
interface Request {
  workshopId: string
  progress: (event: WorkshopProgressEvent) => void
  resolve: (value: WorkshopContentResult) => void
  reject: (error: Error) => void
  removeAbort: () => void
  completed: boolean
}

/** Each result holds a cache lease until the caller finishes installing it. */
export class WorkshopWorker {
  private child: ChildProcess
  private requests = new Map<string, Request>()
  closed = false
  constructor(config: { cacheRoot: string, httpProxy?: string, noProxy?: string[], maxCacheBytes: number }, onDiagnostic: (message: string) => void = () => {}, workerFile?: string) {
    const worker = new URL(import.meta.url.endsWith('.js') ? './mod-download-worker.js' : './mod-download-worker.mjs', import.meta.url)
    this.child = fork(workerFile ?? fileURLToPath(worker), [], {
      execArgv: [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), '--max-old-space-size=256'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    this.child.on('message', (message: any) => {
      if (message?.type === 'diagnostic') { onDiagnostic(String(message.message)); return }
      const request = this.requests.get(message?.requestId)
      if (!request || request.completed) return
      if (message.type === 'cancelled') {
        request.removeAbort()
        this.requests.delete(message.requestId)
        request.reject(new Error('下载已取消'))
      }
      else if (message.type === 'progress' && message.event?.workshopId === request.workshopId) {
        request.progress(message.event)
      }
      else if (message.type === 'result' && message.result?.workshopId === request.workshopId) {
        request.completed = true
        request.removeAbort()
        request.resolve(message.result)
      }
    })
    const failed = (error: Error) => {
      this.closed = true
      for (const request of this.requests.values()) {
        request.removeAbort()
        if (!request.completed) request.reject(error)
      }
      this.requests.clear()
    }
    this.child.once('error', failed)
    this.child.once('close', code => failed(new Error(`Mod 下载进程结束（${code}）`)))
    this.child.send({ type: 'init', config })
  }
  acquire(input: { workshopId: string, instanceId?: string, existingRoot: string, legacyCacheRoot: string, timeoutMs: number,
    signal: AbortSignal, onProgress: (event: WorkshopProgressEvent) => void }) {
    const requestId = randomUUID()
    const result = new Promise<WorkshopContentResult>((resolve, reject) => {
      const abort = () => this.send({ type: 'cancel', requestId })
      const request: Request = { workshopId: input.workshopId, progress: input.onProgress, resolve, reject,
        removeAbort: () => input.signal.removeEventListener('abort', abort), completed: false }
      this.requests.set(requestId, request)
      this.send({ type: 'download', requestId, workshopId: input.workshopId, instanceId: input.instanceId, existingRoot: input.existingRoot,
        legacyCacheRoot: input.legacyCacheRoot, timeoutMs: input.timeoutMs })
      input.signal.addEventListener('abort', abort, { once: true })
      if (input.signal.aborted) abort()
    })
    return { result, release: () => {
      this.requests.get(requestId)?.removeAbort()
      this.requests.delete(requestId)
      this.send({ type: 'release', requestId })
    } }
  }
  private send(message: object) {
    if (this.child.connected) this.child.send(message, () => {})
  }
  prune() { this.send({ type: 'prune' }) }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    return new Promise(resolve => { this.child.once('close', () => resolve()); this.child.kill('SIGKILL') })
  }
}
