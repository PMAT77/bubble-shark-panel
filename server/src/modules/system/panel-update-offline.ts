import { releaseBrandName } from '../../../../shared/release-brand'
import type DockerClient from 'dockerode'
import type { Hash } from 'node:crypto'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

/**
 * Release 离线镜像包的下载与导入。
 *
 * 面板内更新默认走这条路：GHCR 的镜像层域名在国内基本不可达，而 Release 资产
 * （`bubblesharkpanel-<tag>-docker-image.tar.gz`）可以走同一套 GitHub 加速代理，
 * 且 HTTP 带 Content-Length，能直接给出准确的「已下载 X / Y」。
 *
 * 下载写入 `<name>.tar.gz.part`，校验通过后才改名为最终文件：中断或换来源都不会
 * 丢掉已下载的部分，重试时按 HTTP Range 从断点续传。
 */

/** 加速代理前缀池：与安装脚本 install.linux.sh 的 GITHUB_PROXY_SITES 保持一致 */
export const GITHUB_PROXY_SITES = [
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://ghproxy.com/',
]

/** 单个来源长时间无数据即判定卡死，换下一个来源（国内直连 GitHub 常见半死连接） */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000
/** 校验文件/探测大小的整体超时 */
const PROBE_TIMEOUT_MS = 15_000
/** 磁盘余量：镜像包之外还要留出改名、校验与导入期间的余量 */
const DISK_SPACE_MARGIN = 1.15

export function buildOfflineArchiveName(releaseTag: string): string {
  return `${releaseBrandName(releaseTag)}-${releaseTag}-docker-image.tar.gz`
}

/**
 * 候选下载地址：加速代理前缀 → 直连。
 * BSP_GITHUB_PROXY 设置时只用该代理 + 直连，与安装脚本的行为一致。
 */
export function buildOfflineArchiveUrls(input: {
  githubRepo: string
  releaseTag: string
  githubProxy?: string
}): string[] {
  const fileName = buildOfflineArchiveName(input.releaseTag)
  const direct = `https://github.com/${input.githubRepo}/releases/download/${input.releaseTag}/${fileName}`
  const proxy = input.githubProxy?.trim()
  const proxies = proxy ? [proxy] : GITHUB_PROXY_SITES
  return [
    ...proxies.map(item => `${item.replace(/\/+$/, '')}/${direct}`),
    direct,
  ]
}

/** Release 上的 `.sha256` 资产内容形如 `<hex>  <filename>` */
export function parseSha256File(content: string): string | null {
  const first = content.trim().split(/\s+/)[0] ?? ''
  return /^[0-9a-f]{64}$/i.test(first) ? first.toLowerCase() : null
}

/** `Content-Range: bytes 100-999/1000` → 1000；续传时用它拿完整文件大小 */
export function parseContentRangeTotal(header: string | null): number | null {
  const match = header?.match(/\/(\d+)\s*$/)
  const total = Number.parseInt(match?.[1] ?? '', 10)
  return Number.isFinite(total) && total > 0 ? total : null
}

/** 人类可读的字节数：不足 10 时保留一位小数（1.2 GB），否则取整（512 MB） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const rounded = index > 0 && value < 10 ? Math.round(value * 10) / 10 : Math.round(value)
  return `${rounded} ${units[index]}`
}

export interface OfflineArchiveProgress {
  downloadedBytes: number
  totalBytes: number | null
}

export interface DiskSpaceReport {
  ok: boolean
  requiredBytes: number
  availableBytes: number | null
}

/** 下载前的磁盘预检：查不到文件系统信息时不拦（宁可让下载自己失败） */
export async function ensureDiskSpace(dirPath: string, requiredBytes: number): Promise<DiskSpaceReport> {
  try {
    const stats = await fs.promises.statfs(dirPath)
    const availableBytes = Number(stats.bavail) * Number(stats.bsize)
    return {
      ok: availableBytes >= requiredBytes,
      requiredBytes,
      availableBytes,
    }
  }
  catch {
    return { ok: true, requiredBytes, availableBytes: null }
  }
}

export type OfflineArchiveDownloadResult =
  | { ok: true, filePath: string, bytes: number, source: string, checksumVerified: boolean, resumed: boolean }
  | { ok: false, error: string, tried: string[], partialBytes: number }

/** HEAD 探测镜像包大小；拿不到就跳过磁盘预检（不能因为探测失败就不让更新） */
export async function probeArchiveSize(urls: string[]): Promise<number | null> {
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (!response.ok) {
        continue
      }
      const length = Number.parseInt(response.headers.get('content-length') ?? '', 10)
      if (Number.isFinite(length) && length > 0) {
        return length
      }
    }
    catch {
      // 探测失败就换下一个来源
    }
  }
  return null
}

export function resolvePartPath(filePath: string): string {
  return `${filePath}.part`
}

/** 已下载的分片大小；没有分片时为 0 */
export function readPartSize(partPath: string): number {
  try {
    return fs.statSync(partPath).size
  }
  catch {
    return 0
  }
}

/** 把已有分片读进哈希，续传后算出的仍是完整文件的 sha256 */
async function hashExistingPart(partPath: string, hash: Hash): Promise<void> {
  for await (const chunk of fs.createReadStream(partPath)) {
    hash.update(chunk as Buffer)
  }
}

interface DownloadedArchive {
  bytes: number
  sha256: string
  resumed: boolean
}

/** 返回 null 表示该来源不支持断点续传（服务器忽略了 Range 头） */
async function downloadFile(
  url: string,
  partPath: string,
  resumeFrom: number,
  knownTotal: number | null,
  onProgress?: (progress: OfflineArchiveProgress) => void,
): Promise<DownloadedArchive | null> {
  const controller = new AbortController()
  let idleTimer: NodeJS.Timeout | undefined
  const armIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
    }
    idleTimer = setTimeout(() => controller.abort(new Error('下载超时（60 秒无数据）')), DOWNLOAD_IDLE_TIMEOUT_MS)
    idleTimer.unref()
  }

  try {
    armIdleTimer()
    const response = await fetch(url, {
      headers: resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : undefined,
      redirect: 'follow',
      signal: controller.signal,
    })
    if (resumeFrom > 0 && response.status !== 206) {
      // 代理不支持 Range：丢掉分片由调用方从头下载
      await response.body?.cancel().catch(() => {})
      return null
    }
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`)
    }

    const lengthHeader = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    const contentLength = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null
    const totalBytes = response.status === 206
      ? parseContentRangeTotal(response.headers.get('content-range'))
        ?? (contentLength ? resumeFrom + contentLength : knownTotal)
      : contentLength ?? knownTotal

    const hash = createHash('sha256')
    if (resumeFrom > 0) {
      await hashExistingPart(partPath, hash)
    }

    let bytes = resumeFrom
    onProgress?.({ downloadedBytes: bytes, totalBytes })
    const stream = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      hash.update(chunk)
      armIdleTimer()
      onProgress?.({ downloadedBytes: bytes, totalBytes })
    })
    await pipeline(
      stream,
      fs.createWriteStream(partPath, { flags: resumeFrom > 0 ? 'a' : 'w' }),
      { signal: controller.signal },
    )
    return { bytes, sha256: hash.digest('hex'), resumed: resumeFrom > 0 }
  }
  finally {
    if (idleTimer) {
      clearTimeout(idleTimer)
    }
  }
}

/** 优先续传；来源不支持时丢掉分片重下 */
async function downloadWithResume(
  url: string,
  partPath: string,
  knownTotal: number | null,
  onProgress?: (progress: OfflineArchiveProgress) => void,
): Promise<DownloadedArchive> {
  const existing = readPartSize(partPath)
  if (existing > 0) {
    const resumed = await downloadFile(url, partPath, existing, knownTotal, onProgress)
    if (resumed) {
      return resumed
    }
    fs.rmSync(partPath, { force: true })
  }
  const fresh = await downloadFile(url, partPath, 0, knownTotal, onProgress)
  if (!fresh) {
    throw new Error('下载失败')
  }
  return fresh
}

/** 校验文件拿不到不算致命：少一层保险，但不能因此让用户更新不了 */
async function fetchExpectedSha256(url: string): Promise<string | null> {
  try {
    const response = await fetch(`${url}.sha256`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) {
      return null
    }
    return parseSha256File(await response.text())
  }
  catch {
    return null
  }
}

/** 通用 Release 资产下载参数：离线镜像包与 Native 更新包共用同一套断点续传 + 校验逻辑 */
export interface ReleaseArchiveDownloadInput {
  urls: string[]
  destinationDir: string
  fileName: string
  /** 文案主体名（「镜像包」/「更新包」）；只影响用户可见的错误说明 */
  subjectLabel: string
  /** 磁盘不足时的补充建议（例如导入镜像还要占用的空间） */
  diskHint?: string
  onProgress?: (progress: OfflineArchiveProgress) => void
}

/**
 * 按候选地址依次下载 Release 资产，流式校验 sha256；成功后 `.part` 改名为最终文件。
 * 失败时保留分片，下一次调用会从断点继续。
 */
export async function downloadReleaseArchive(input: ReleaseArchiveDownloadInput): Promise<OfflineArchiveDownloadResult> {
  fs.mkdirSync(input.destinationDir, { recursive: true })
  cleanupStaleParts(input.destinationDir, input.fileName)
  const filePath = path.join(input.destinationDir, input.fileName)
  const partPath = resolvePartPath(filePath)
  const tried: string[] = []
  let lastError = ''

  const knownTotal = await probeArchiveSize(input.urls)
  const partialBytes = readPartSize(partPath)
  if (knownTotal) {
    const remaining = Math.max(0, knownTotal - partialBytes)
    const space = await ensureDiskSpace(input.destinationDir, Math.ceil(remaining * DISK_SPACE_MARGIN))
    if (!space.ok) {
      return {
        ok: false,
        tried,
        partialBytes,
        error: [
          `磁盘空间不足：${input.subjectLabel}约 ${formatBytes(knownTotal)}，`,
          `${input.destinationDir} 可用 ${space.availableBytes === null ? '未知' : formatBytes(space.availableBytes)}。`,
          `请清理磁盘后重试${input.diskHint ? `（${input.diskHint}）` : ''}。`,
        ].join(''),
      }
    }
  }

  for (const url of input.urls) {
    tried.push(url)
    try {
      const archive = await downloadWithResume(url, partPath, knownTotal, input.onProgress)
      const expected = await fetchExpectedSha256(url)
      if (expected && expected !== archive.sha256) {
        // 分片内容已不可信，删掉重下
        fs.rmSync(partPath, { force: true })
        throw new Error(`${input.subjectLabel}校验失败（期望 ${expected.slice(0, 12)}…，实际 ${archive.sha256.slice(0, 12)}…）`)
      }
      fs.renameSync(partPath, filePath)
      return {
        ok: true,
        filePath,
        bytes: archive.bytes,
        source: url,
        checksumVerified: expected !== null,
        resumed: archive.resumed,
      }
    }
    catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      // 分片留着，下一个来源接着下
    }
  }

  return {
    ok: false,
    error: lastError || '所有下载来源都失败了',
    tried,
    partialBytes: readPartSize(partPath),
  }
}

/** 离线镜像包入口：国内推荐路径，文案面向镜像导入 */
export async function downloadOfflineImageArchive(input: {
  urls: string[]
  destinationDir: string
  fileName: string
  onProgress?: (progress: OfflineArchiveProgress) => void
}): Promise<OfflineArchiveDownloadResult> {
  return downloadReleaseArchive({
    ...input,
    subjectLabel: '镜像包',
    diskHint: '导入镜像还需要 docker 数据目录同等大小的空间',
  })
}

/** 本地已有的镜像引用集合；用于对比 `docker load` 前后确定这次导入进来的 tag */
export async function listImageRepoTags(docker: DockerClient): Promise<Set<string>> {
  const images = await docker.listImages()
  const tags = new Set<string>()
  for (const image of images) {
    for (const tag of image.RepoTags ?? []) {
      if (tag && tag !== '<none>:<none>') {
        tags.add(tag)
      }
    }
  }
  return tags
}

/** 清掉同目录里其它版本的断点分片：换 tag 或换来源后它们只会一直占着几百 MB */
export function cleanupStaleParts(destinationDir: string, keepFileName: string): void {
  const keepPart = `${keepFileName}.part`
  try {
    for (const entry of fs.readdirSync(destinationDir)) {
      if (entry.endsWith('.part') && entry !== keepPart) {
        fs.rmSync(path.join(destinationDir, entry), { force: true })
      }
    }
  }
  catch {
    // 目录不存在或不可读：不阻塞下载
  }
}

/** 把离线镜像包（.tar.gz）导入本地 docker，等价于 `docker load -i` */
export async function loadOfflineImageArchive(
  docker: DockerClient,
  filePath: string,
  onProgress?: (event: unknown) => void,
): Promise<void> {
  const archive = fs.createReadStream(filePath).pipe(createGunzip())
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (error: unknown) => {
      if (settled) {
        return
      }
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    archive.on('error', fail)
    docker.loadImage(archive, (loadError: Error | null, output: NodeJS.ReadableStream) => {
      if (loadError) {
        fail(loadError)
        return
      }
      docker.modem.followProgress(output, (progressError: Error | null) => {
        if (progressError) {
          fail(progressError)
          return
        }
        if (!settled) {
          settled = true
          resolve()
        }
      }, onProgress)
    })
  })
}
