import type DockerClient from 'dockerode'
import { parseImageRef } from './image-ref'
import { abortable, abortableDelay } from '../../shared/abort'

export interface ImagePreparationOptions {
  signal?: AbortSignal
  timeoutMs?: number
  onProgress?: (event: unknown) => void
}
const sharedPulls = new Map<string, { controller: AbortController, promise: Promise<unknown>, listeners: Set<(event: unknown) => void> }>()

/** 每位等待者独立取消；最后一位离开时才停止拉取流。 */
export async function shareImagePreparation<T>(key: string, options: ImagePreparationOptions, run: (options: ImagePreparationOptions) => Promise<T>): Promise<T> {
  options.signal?.throwIfAborted()
  let entry = sharedPulls.get(key)
  if (!entry) {
    const controller = new AbortController()
    const listeners = new Set<(event: unknown) => void>()
    const timer = setTimeout(() => controller.abort(new Error('镜像准备超过等待时间')), options.timeoutMs ?? 60 * 60 * 1000)
    timer.unref()
    const promise = Promise.resolve().then(() => abortable(run({ signal: controller.signal, onProgress: event => {
      for (const listener of listeners) listener(event)
    } }), controller.signal)).finally(() => {
      clearTimeout(timer)
      if (sharedPulls.get(key)?.controller === controller) sharedPulls.delete(key)
    })
    entry = { controller, promise, listeners }
    sharedPulls.set(key, entry)
  }
  const listener = options.onProgress ?? (() => {})
  entry.listeners.add(listener)
  try { return await abortable(entry.promise as Promise<T>, options.signal) }
  finally {
    entry.listeners.delete(listener)
    if (!entry.listeners.size) {
      entry.controller.abort(new Error('没有等待该镜像的任务'))
      if (sharedPulls.get(key) === entry) sharedPulls.delete(key)
    }
  }
}

/**
 * 通用镜像候选拉取：
 * 1) 若配置了备选 registry（BSP_IMAGE_MIRRORS / 旧 BSP_STEAMCMD_IMAGE_MIRRORS），按顺序优先尝试候选；
 * 2) 最后尝试完整的已配置镜像引用。
 * v0.2.0 起面板/DST/SteamCMD 共用统一镜像，该模块由 steamcmd-runner 与 game-dst-image 共享。
 */

/** 未配置镜像引用时使用的官方默认仓库（统一镜像）。 */
export const OFFICIAL_UNIFIED_IMAGE_REPOSITORY = 'ghcr.io/pmat77/bubblesharkpanel'

export function normalizeMirrorRegistries(raw: string | null | undefined): string[] {
  const normalized = (raw || '').trim()
  if (!normalized) {
    return []
  }
  return [...new Set(
    normalized
      .split(',')
      .map(item => item.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''))
      .filter(Boolean),
  )]
}

export function buildImageRef(registry: string, repository: string, tag: string): string {
  if (registry === 'docker.io') {
    return `${repository}:${tag}`
  }
  return `${registry}/${repository}:${tag}`
}

export function buildImageCandidates(configuredRef: string, mirrorsRaw: string | null | undefined): string[] {
  const ref = configuredRef.trim() || `${OFFICIAL_UNIFIED_IMAGE_REPOSITORY}:latest`
  const parsed = parseImageRef(ref)
  const mirrors = normalizeMirrorRegistries(mirrorsRaw).filter(registry => registry !== parsed.registry)
  const candidates = mirrors.map(registry => buildImageRef(registry, parsed.repository, parsed.tag))
  candidates.push(ref)
  return candidates
}

export async function isImagePresentByRef(docker: DockerClient, imageRef: string): Promise<boolean> {
  try {
    await docker.getImage(imageRef).inspect()
    return true
  }
  catch {
    return false
  }
}

export async function tagImageAlias(docker: DockerClient, sourceRef: string, targetRef: string): Promise<void> {
  if (sourceRef === targetRef) {
    return
  }
  const parsed = parseImageRef(targetRef)
  const repo = parsed.registry === 'docker.io'
    ? parsed.repository
    : `${parsed.registry}/${parsed.repository}`
  await docker.getImage(sourceRef).tag({ repo, tag: parsed.tag })
}

export interface PullProgressSnapshot {
  /** 本次需要下载的层已下载字节之和 */
  downloadedBytes: number
  /** 本次需要下载的总字节；registry 未给出总量时为 0 */
  totalBytes: number
}

/**
 * 聚合 docker pull 的进度事件（followProgress 的第三个回调）。
 * 按层 id 取最大值：Extracting 阶段 current 会跳到解压进度，取最大值数字才不会倒退；
 * total 取该层最近一次非零值，「Download complete」表示该层已下满。
 * 跨候选镜像重试时沿用同一份聚合，因此重试不会把字节数重复累加。
 */
export function createPullProgressAggregator() {
  const layers = new Map<string, { current: number, total: number }>()

  function readBytes(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }

  return {
    handle(event: unknown): void {
      if (!event || typeof event !== 'object') {
        return
      }
      const { id, status, progressDetail } = event as {
        id?: unknown
        status?: unknown
        progressDetail?: unknown
      }
      if (typeof id !== 'string' || !id) {
        return
      }
      const layer = layers.get(id) ?? { current: 0, total: 0 }
      const detail = progressDetail && typeof progressDetail === 'object'
        ? progressDetail as { current?: unknown, total?: unknown }
        : null
      const current = readBytes(detail?.current)
      const total = readBytes(detail?.total)
      if (current > layer.current) {
        layer.current = current
      }
      if (total > 0) {
        layer.total = total
      }
      if (status === 'Download complete' && layer.total > 0) {
        layer.current = layer.total
      }
      layers.set(id, layer)
    },
    snapshot(): PullProgressSnapshot {
      let downloadedBytes = 0
      let totalBytes = 0
      for (const layer of layers.values()) {
        downloadedBytes += layer.current
        totalBytes += layer.total
      }
      return { downloadedBytes, totalBytes }
    },
  }
}

export function pullImageOnce(
  docker: DockerClient,
  image: string,
  onProgress?: (event: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted()
    let activeStream: NodeJS.ReadableStream | undefined
    const aborted = () => {
      ;(activeStream as NodeJS.ReadableStream & { destroy?: () => void })?.destroy?.()
      reject(signal?.reason)
    }
    const finish = (error?: Error | null) => {
      signal?.removeEventListener('abort', aborted)
      if (error) reject(error)
      else resolve()
    }
    signal?.addEventListener('abort', aborted, { once: true })
    docker.pull(image, (pullError: Error | null, stream: NodeJS.ReadableStream) => {
      if (pullError) {
        finish(pullError)
        return
      }
      activeStream = stream
      if (signal?.aborted) { aborted(); signal.removeEventListener('abort', aborted); return }
      docker.modem.followProgress(stream, (progressError: Error | null) => {
        finish(progressError)
      }, onProgress)
    })
  })
}

export interface PullCandidatesOptions {
  signal?: AbortSignal
  maxAttempts?: number
  retryBaseMs?: number
  sleep?: (ms: number) => Promise<void>
  /** docker pull 的原始进度事件，用于向界面回报下载量 */
  onProgress?: (event: unknown) => void
}

export type PullCandidatesResult
  = | { ok: true, image: string }
    | { ok: false, error: string, tried: string[] }

/** 按候选顺序拉取：本地已有则直接 tag 别名；否则逐候选重试拉取。 */
export async function pullImageWithCandidates(
  docker: DockerClient,
  candidates: string[],
  targetRef: string,
  options: PullCandidatesOptions = {},
): Promise<PullCandidatesResult> {
  const maxAttempts = options.maxAttempts ?? 3
  const retryBaseMs = options.retryBaseMs ?? 2_000
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  for (const candidate of candidates) {
    options.signal?.throwIfAborted()
    if (await isImagePresentByRef(docker, candidate)) {
      await tagImageAlias(docker, candidate, targetRef)
      return { ok: true, image: candidate }
    }
  }

  let lastError = ''
  const tried: string[] = []
  for (const candidate of candidates) {
    tried.push(candidate)
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await pullImageOnce(docker, candidate, options.onProgress, options.signal)
        await tagImageAlias(docker, candidate, targetRef)
        return { ok: true, image: candidate }
      }
      catch (error) {
        options.signal?.throwIfAborted()
        lastError = error instanceof Error ? error.message : String(error)
        if (!/timeout|timed out|deadline|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ENOTFOUND|network|connection|unexpected EOF|HTTP.*(?:429|50[0234])|too many requests|temporar(?:y|ily)|service unavailable/i.test(lastError)) break
        if (attempt < maxAttempts) {
          if (options.signal) await abortableDelay(retryBaseMs * attempt, options.signal)
          else await sleep(retryBaseMs * attempt)
        }
      }
    }
  }
  return {
    ok: false,
    error: lastError || `拉取 ${candidates[candidates.length - 1] || targetRef} 失败`,
    tried,
  }
}

/** 构建拉取失败的通用提示（网络/权限/镜像不存在分类）。 */
export function formatPullError(raw: string, image: string, triedImages?: string[], envHint = 'BSP_IMAGE_MIRRORS'): string {
  const text = raw.trim() || `拉取 ${image} 失败`
  const attempted = triedImages?.length ? `已尝试镜像：${triedImages.join(' -> ')}。` : ''
  if (/403 Forbidden|denied|unauthorized/i.test(text)) {
    return `${attempted}镜像仓库拒绝访问（403/unauthorized），请检查镜像可见性或更换可访问镜像。原始错误：${text}`
  }
  if (/registry-1\.docker\.io|docker\.io|connectex|ETIMEDOUT|timeout|deadline|ECONNREFUSED|failed to respond/i.test(text)) {
    return [
      attempted,
      `无法从镜像仓库拉取镜像 ${image}（网络超时或被阻断）。`,
      `可尝试：① 在可访问网络下手动 docker pull 后重试；`,
      `② 在 panel.env 中配置 ${envHint} 指向可达 registry；`,
      `③ 检查镜像引用的 tag 是否与发布一致。`,
      `原始错误：${text}`,
    ].join('')
  }
  if (/manifest unknown|not found|404/i.test(text)) {
    return `${attempted}镜像 ${image} 不存在或标签错误，请检查镜像引用配置。原始错误：${text}`
  }
  return `${attempted}${text}`
}
