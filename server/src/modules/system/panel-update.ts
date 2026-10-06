import { releaseBrandName } from '../../../../shared/release-brand'
import { readBrandEnv } from '../../../../shared/brand-env'
import type { FastifyInstance } from 'fastify'
import type DockerClient from 'dockerode'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildImageCandidates,
  buildImageRef,
  createPullProgressAggregator,
  formatPullError,
  isImagePresentByRef,
  pullImageWithCandidates,
  tagImageAlias,
} from '../../infra/container/image-candidates'
import {
  normalizeDigest,
  parseImageRef,
  shortDigest,
} from '../../infra/container/image-ref'
import { fetchRemoteImageIdentity } from '../../infra/container/registry-manifest'
import { stripDockerLogFrame } from '../../infra/container/docker-log'
import { createDockerClient } from '../../infra/docker-connect'
import type { ServerConfig } from '../../shared/config'
import { loadServerConfig } from '../../shared/config'
import { getSystemPanelSettings } from '../../shared/db/index'
import { getDefaultPanelSettings } from './defaults'
import type { PanelPortEnvKey } from './panel-port-deploy'
import { buildPanelPortWriteScript } from './panel-port-deploy'
import {
  GITHUB_PROXY_SITES,
  buildOfflineArchiveName,
  buildOfflineArchiveUrls,
  downloadOfflineImageArchive,
  formatBytes,
  listImageRepoTags,
  loadOfflineImageArchive,
} from './panel-update-offline'
import {
  NATIVE_UPDATE_INSTALLER_HINT,
  cleanupStalePrefetchedArchives,
  downloadNativeReleaseArchive,
  mergeNativeUpdateRuntime,
  readNativeUpdateState,
  resolveNativeUpdateSupport,
  resolvePrefetchedArchive,
  writeNativeUpdateRequest,
} from './panel-update-native'

/** 更新语义分类，用于把"同版本号但镜像变了"与"版本更高"区分展示 */
export type UpdateKind = 'none' | 'newer' | 'same-version-changed' | 'unknown'

/**
 * 一键更新的执行阶段。
 * 下载（preparing/downloading）与安装（installing/recreating）是两段：downloaded 表示镜像已就绪、
 * 正等用户点「立即安装」，此时没有任务在跑。failed 是终态，需用户处理后再试。
 */
export type PanelUpdatePhase =
  | 'idle'
  | 'preparing'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'recreating'
  | 'failed'

/** 更新动作：auto 为下载后立即安装（旧前端不带参数时走这里） */
export type PanelUpdateAction = 'auto' | 'download' | 'install'

export interface HubImageUpdateInfo {
  image: string
  tag: string
  releaseVersion: string | null
  localDigest: string | null
  localDigestShort: string | null
  remoteDigest: string | null
  remoteDigestShort: string | null
  updateAvailable: boolean
  localPresent: boolean
  checkError: string | null
}

export interface GitHubReleaseSummary {
  tagName: string
  name: string
  body: string
  publishedAt: string
  htmlUrl: string
}

export interface PanelUpdateStatus {
  runtimeMode: 'docker' | 'native'
  /** v0.2.0 起统一镜像：面板/DST/SteamCMD 共用同一镜像，单一更新目标 */
  image: HubImageUpdateInfo
  release: GitHubReleaseSummary | null
  lastCheckedAt: string | null
  checking: boolean
  updating: boolean
  /** 统一镜像是否支持一键更新（docker 模式且 stack 可达时为真） */
  applySupported: boolean
  imageApplySupported: boolean
  /** Native/systemd 部署是否支持面板内一键更新（安装器已布置特权更新组件时为真） */
  nativeUpdateSupported: boolean
  applyHint: string | null
  /** 更新语义分类：区分"版本更高"与"同版本号但镜像内容变了" */
  updateKind: UpdateKind
  manualUpdateCommand: string | null
  /** 离线镜像包下载与导入命令（国内推荐路径）；拼不出时为 null */
  offlineImageCommand: string | null
  checkError: string | null
  /** 一键更新的实时阶段；界面据此显示进度而不是笼统的"更新中" */
  updatePhase: PanelUpdatePhase
  /** 当前阶段的用户可读说明 */
  updateMessage: string | null
  /** 上一次更新的失败原因（未开始或已成功时为 null） */
  updateError: string | null
  /** 本次更新的目标镜像引用：跨版本升级时指向 Release tag 对应的镜像 */
  targetImage: string | null
  /** 目标镜像是否已在本地（离线镜像包导入、或下载完成后为 true，可直接重建、无需下载） */
  targetImageReady: boolean
  /** 下载阶段已下载字节；未开始下载或拿不到进度时为 null */
  downloadBytes: number | null
  /** 下载阶段本次需要下载的总字节；registry 未给出总量时为 null */
  downloadTotalBytes: number | null
}

export const STACK_CONTAINER_MOUNT = '/stack'

export interface StackPaths {
  /** 宿主机路径，用于 Docker bind 挂载与手动更新命令 */
  hostDir: string
  /** 面板进程内可访问的路径（容器内通常为 /stack） */
  localDir: string
}

export interface ApplySupport {
  imageSupported: boolean
  /** Native/systemd 部署：安装器是否已布置特权更新组件（面板内更新可用） */
  nativeSupported: boolean
  supported: boolean
  hint: string | null
  stackPaths: StackPaths | null
}

const DEFAULT_CHECK_INTERVAL_HOURS = 1
/**
 * updater 容器运行时：需要 `docker` CLI + compose 插件。
 * v0.3.10 起统一镜像自带这两样，因此优先用「目标镜像 / 当前面板镜像」在本地直接跑，
 * 不再依赖从 Docker Hub 拉取官方 CLI 镜像；下面两个只是本地没有可用镜像时的兜底。
 * 用全限定引用，备选 registry（BSP_IMAGE_MIRRORS）才能拼出 <mirror>/library/docker:... 。
 */
const FALLBACK_UPDATER_IMAGES = ['docker.io/library/docker:27-cli', 'docker.io/library/docker:cli']
const UPDATER_CONTAINER_NAME = 'bubblesharkpanel-updater'
/** 目标镜像拉取的重试策略（与实例镜像拉取保持一致） */
const TARGET_PULL_MAX_ATTEMPTS = 3
const TARGET_PULL_RETRY_BASE_MS = 2_000
/** 更新任务的最长容忍时间；超时即判定失败并复位状态，避免界面永久停在"更新中" */
const UPDATE_WATCHDOG_MS = 30 * 60 * 1000
/**
 * Native 安装段的等待上限与轮询间隔：执行器要下载、校验、解压并重启，比容器重建慢得多；
 * 面板本身会在安装中途被重启，所以这条轮询只是"本进程还活着时"的加速通道。
 */
const NATIVE_INSTALL_WATCH_MS = 30 * 60 * 1000
const NATIVE_INSTALL_POLL_MS = 3_000
/** 下载进度上报节流：docker pull 每层每块都会回调一次，全量写状态会刷爆缓存与页面轮询 */
const PROGRESS_REPORT_INTERVAL_MS = 500
const PROGRESS_REPORT_MIN_BYTES = 5 * 1024 * 1024

let cachedStatus: PanelUpdateStatus | null = null
let checkInFlight: Promise<PanelUpdateStatus> | null = null
let schedulerStarted = false
let schedulerTimer: NodeJS.Timeout | null = null
let watchdogTimer: NodeJS.Timeout | null = null

/** 一次更新的内存态；面板容器重启后自然归零 */
interface PanelUpdateRuntime {
  phase: PanelUpdatePhase
  message: string | null
  error: string | null
  startedAt: number | null
  targetImage: string | null
  targetImageReady: boolean
  downloadBytes: number | null
  downloadTotalBytes: number | null
}

function createIdleRuntime(): PanelUpdateRuntime {
  return {
    phase: 'idle',
    message: null,
    error: null,
    startedAt: null,
    targetImage: null,
    targetImageReady: false,
    downloadBytes: null,
    downloadTotalBytes: null,
  }
}

let runtime: PanelUpdateRuntime = createIdleRuntime()

/** downloaded 是等待用户点「立即安装」的静默态，不算任务进行中 */
function isUpdating(): boolean {
  return runtime.phase === 'preparing'
    || runtime.phase === 'downloading'
    || runtime.phase === 'installing'
    || runtime.phase === 'recreating'
}

function buildRuntimeFields(): Pick<
  PanelUpdateStatus,
  | 'updating'
  | 'updatePhase'
  | 'updateMessage'
  | 'updateError'
  | 'targetImage'
  | 'targetImageReady'
  | 'downloadBytes'
  | 'downloadTotalBytes'
> {
  return {
    updating: isUpdating(),
    updatePhase: runtime.phase,
    updateMessage: runtime.message,
    updateError: runtime.error,
    targetImage: runtime.targetImage,
    targetImageReady: runtime.targetImageReady,
    downloadBytes: runtime.downloadBytes,
    downloadTotalBytes: runtime.downloadTotalBytes,
  }
}

function syncRuntimeToCachedStatus(): void {
  if (cachedStatus) {
    cachedStatus = { ...cachedStatus, ...buildRuntimeFields() }
  }
}

function updateRuntime(patch: Partial<PanelUpdateRuntime>): void {
  runtime = { ...runtime, ...patch }
  syncRuntimeToCachedStatus()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 下载进度上报节流器：docker pull 的事件与 HTTP 下载的数据块都很密集，
 * 全量写状态会刷爆缓存与页面轮询。
 */
function createProgressReporter(): (downloadedBytes: number, totalBytes: number | null) => void {
  let lastReportAt = 0
  let lastReportedBytes = 0
  return (downloadedBytes, totalBytes) => {
    const now = Date.now()
    if (
      now - lastReportAt < PROGRESS_REPORT_INTERVAL_MS
      && downloadedBytes - lastReportedBytes < PROGRESS_REPORT_MIN_BYTES
    ) {
      return
    }
    lastReportAt = now
    lastReportedBytes = downloadedBytes
    updateRuntime({
      downloadBytes: downloadedBytes,
      downloadTotalBytes: totalBytes && totalBytes > 0 ? totalBytes : null,
    })
  }
}

function resolveImageMirrorsRaw(): string | null {
  const { imageMirrors } = loadServerConfig()
  return imageMirrors.length > 0 ? imageMirrors.join(',') : null
}

/** 看门狗只保留一份：超时后把状态复位成可重试的失败态，而不是永久"更新中" */
function ensureUpdateWatchdog(): void {
  if (watchdogTimer) {
    return
  }
  watchdogTimer = setInterval(() => {
    if (!isUpdating() || !runtime.startedAt) {
      return
    }
    if (Date.now() - runtime.startedAt < UPDATE_WATCHDOG_MS) {
      return
    }
    updateRuntime({
      phase: 'failed',
      message: null,
      error: '更新超时未完成，已停止等待。请检查网络后重试，或改用离线镜像包导入。',
    })
  }, 60_000)
  watchdogTimer.unref()
}

function normalizeErrorMessages(messages: Array<string | null | undefined>): string | null {
  const normalized = messages
    .flatMap((message) => {
      return String(message ?? '')
        .split(/[；;\n]+/)
        .map(item => item.trim())
        .filter(Boolean)
    })
  if (normalized.length === 0) {
    return null
  }
  return [...new Set(normalized)].join('；')
}

function resolveDocker() {
  return createDockerClient()
}

function resolveReleaseVersionFromEnv(): string | null {
  const config = loadServerConfig()
  if (config.releaseVersion) {
    return config.releaseVersion
  }
  return null
}

/**
 * 收集本地镜像持有的全部身份凭据。
 * RepoDigests 来自 docker pull（多架构镜像下是 manifest list 摘要）；
 * Id 是镜像 config 摘要；RootFS.Layers 是未压缩层摘要 ——
 * docker load 导入的离线包连 config 摘要都与 registry 不同，只有层能对上。
 */
async function inspectLocalImageDigest(image: string): Promise<{
  digests: string[]
  layers: string[]
  present: boolean
  releaseVersion: string | null
}> {
  try {
    const info = await resolveDocker().getImage(image).inspect() as {
      Id?: string
      RepoDigests?: string[]
      RootFS?: { Layers?: string[] }
      Config?: { Labels?: Record<string, string> }
    }
    const digests = [...new Set(
      [...(info.RepoDigests ?? []), info.Id]
        .map(item => normalizeDigest(item))
        .filter((digest): digest is string => Boolean(digest)),
    )]
    const layers = (info.RootFS?.Layers ?? [])
      .map(layer => normalizeDigest(layer))
      .filter((layer): layer is string => Boolean(layer))
    const labelVersion = info.Config?.Labels?.['org.opencontainers.image.version']
    return {
      digests,
      layers,
      present: true,
      releaseVersion: labelVersion?.trim() || null,
    }
  }
  catch {
    return {
      digests: [],
      layers: [],
      present: false,
      releaseVersion: null,
    }
  }
}

async function fetchLatestGitHubRelease(repo: string): Promise<GitHubReleaseSummary | null> {
  try {
    // 默认直连 api.github.com；国内服务器可配 BSP_GITHUB_API_BASE 指向兼容 GitHub API 的反代
    const apiBase = (loadServerConfig().githubApiBase || 'https://api.github.com').replace(/\/+$/, '')
    const response = await fetch(`${apiBase}/repos/${repo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'bubblesharkpanel-panel-update',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      throw new Error(`GitHub API 返回 ${response.status}`)
    }
    const json = await response.json() as {
      tag_name?: string
      name?: string
      body?: string
      published_at?: string
      html_url?: string
    }
    if (!json.tag_name) {
      return null
    }
    return {
      tagName: json.tag_name,
      name: json.name?.trim() || json.tag_name,
      body: json.body?.trim() || '',
      publishedAt: json.published_at || '',
      htmlUrl: json.html_url || '',
    }
  }
  catch {
    return null
  }
}

export function hasStackRequiredFiles(baseDir: string, composeFiles: string[]): boolean {
  const envPath = path.join(baseDir, 'panel.env')
  if (!fs.existsSync(envPath)) {
    return false
  }
  return composeFiles.every(file => fs.existsSync(path.join(baseDir, file)))
}

export function resolveStackPaths(
  stackDir: string,
  composeFiles: string[],
  mountPath = STACK_CONTAINER_MOUNT,
): StackPaths | null {
  const hostDir = stackDir.trim()
  if (!hostDir || !path.isAbsolute(hostDir)) {
    return null
  }
  if (hasStackRequiredFiles(hostDir, composeFiles)) {
    return { hostDir, localDir: hostDir }
  }
  if (hasStackRequiredFiles(mountPath, composeFiles)) {
    return { hostDir, localDir: mountPath }
  }
  return null
}

function normalizeReleaseTag(value: string | null | undefined, fallback: string): string {
  const normalized = value?.trim() ?? ''
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)
    ? normalized
    : fallback
}

export function isReleaseNewer(current: string | null, latest: string | null): boolean {
  const parse = (value: string | null) => {
    const match = value?.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
    if (!match) {
      return null
    }
    return {
      parts: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] ?? null,
    }
  }
  const left = parse(current)
  const right = parse(latest)
  if (!left || !right) {
    return Boolean(latest && current && latest !== current)
  }
  for (let index = 0; index < left.parts.length; index += 1) {
    if (right.parts[index] !== left.parts[index]) {
      return right.parts[index] > left.parts[index]
    }
  }
  if (left.prerelease && !right.prerelease) {
    return true
  }
  if (!left.prerelease || !right.prerelease) {
    return false
  }
  return right.prerelease.localeCompare(left.prerelease, 'en', { numeric: true }) > 0
}

function parseVersionTriple(value: string | null | undefined): string | null {
  const match = value?.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) {
    return null
  }
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`
}

/**
 * 把"有新版本"细分为用户能理解的几种情形。
 * Docker 模式的 updateAvailable 只由镜像摘要决定，与版本号无关，
 * 因此必须把"版本号相同但镜像变了"单独区分，否则界面自相矛盾。
 */
export function resolveUpdateKind(input: {
  runtimeMode: 'docker' | 'native'
  updateAvailable: boolean
  currentVersion: string | null
  latestVersion: string | null
}): UpdateKind {
  if (!input.updateAvailable) {
    return 'none'
  }
  if (input.runtimeMode === 'native') {
    return 'newer'
  }
  if (!input.latestVersion) {
    return 'unknown'
  }
  const current = parseVersionTriple(input.currentVersion)
  const latest = parseVersionTriple(input.latestVersion)
  if (current && latest && current === latest) {
    return 'same-version-changed'
  }
  if (isReleaseNewer(input.currentVersion, input.latestVersion)) {
    return 'newer'
  }
  return 'unknown'
}

function buildManualUpdateCommand(stackPaths: StackPaths | null, releaseTag?: string | null): string {
  const config = loadServerConfig()
  if (config.runtimeMode === 'native') {
    const currentTag = normalizeReleaseTag(config.releaseVersion, 'v0.3.10')
    const targetTag = normalizeReleaseTag(releaseTag, currentTag)
    const directUrl = `https://raw.githubusercontent.com/${config.githubRepo}/${targetTag}/scripts/install.linux.sh`
    // 国内部署直连 raw.githubusercontent.com 基本不可达，而这是 Native 唯一的面板升级路径。
    // 与安装器、离线包下载保持一致：优先用加速代理，直连地址写在注释里备查。
    const proxy = config.githubProxy?.trim()
    const prefix = (proxy ? [proxy] : GITHUB_PROXY_SITES)[0].replace(/\/+$/, '')
    return [
      `# 下载不通时把下面 URL 换成直连：${directUrl}`,
      `curl -fsSL "${prefix}/${directUrl}" | sudo env BSP_RELEASE_TAG=${targetTag} bash -s -- --mode native`,
    ].join('\n')
  }
  const hostDir = stackPaths?.hostDir || config.stackDir || '/opt/bubblesharkpanel'
  const composeArgs = config.composeFiles.map(file => `-f ${file}`).join(' ')
  return [
    `cd ${hostDir}`,
    `docker compose --env-file panel.env ${composeArgs} pull && docker compose --env-file panel.env ${composeArgs} up -d`,
  ].join(' && ')
}

export function resolveApplySupport(
  config = loadServerConfig(),
  options: { nativePathUnitFile?: string, nativeHelperFile?: string } = {},
): ApplySupport {
  if (config.runtimeMode === 'native') {
    // Native 不用容器镜像：面板内更新由安装器布置的特权执行器完成（写请求文件 + systemd 触发）。
    const nativeSupport = resolveNativeUpdateSupport(config, {
      pathUnitFile: options.nativePathUnitFile,
      helperFile: options.nativeHelperFile,
    })
    return {
      imageSupported: false,
      nativeSupported: nativeSupport.supported,
      supported: nativeSupport.supported,
      hint: nativeSupport.supported ? null : (nativeSupport.hint ?? NATIVE_UPDATE_INSTALLER_HINT),
      stackPaths: null,
    }
  }
  if (!config.stackDir) {
    return {
      imageSupported: false,
      nativeSupported: false,
      supported: true,
      hint: '缺少更新所需的目录配置，无法一键更新面板。请使用下方手动命令。',
      stackPaths: null,
    }
  }
  if (!path.isAbsolute(config.stackDir)) {
    return {
      imageSupported: false,
      nativeSupported: false,
      supported: true,
      hint: '更新目录必须填绝对路径。',
      stackPaths: null,
    }
  }
  const stackPaths = resolveStackPaths(config.stackDir, config.composeFiles)
  if (!stackPaths) {
    return {
      imageSupported: false,
      nativeSupported: false,
      supported: true,
      hint: '面板无法访问更新所需的目录，请使用下方手动命令。',
      stackPaths: null,
    }
  }
  return {
    imageSupported: true,
    nativeSupported: false,
    supported: true,
    hint: null,
    stackPaths,
  }
}

function buildApplyFields(applySupport: ApplySupport, releaseTag?: string | null) {
  const config = loadServerConfig()
  return {
    applySupported: applySupport.supported,
    imageApplySupported: applySupport.imageSupported,
    nativeUpdateSupported: applySupport.nativeSupported,
    applyHint: applySupport.hint,
    manualUpdateCommand: buildManualUpdateCommand(applySupport.stackPaths, releaseTag),
    // 离线镜像包命令只对 Docker 有意义：Native 不用镜像，给一段 docker load 只会误导
    offlineImageCommand: config.runtimeMode === 'native'
      ? null
      : buildOfflineImageCommand(config.githubRepo, releaseTag ?? null),
  }
}

/** 镜像身份：摘要集合 + 未压缩层指纹 */
export interface ImageIdentity {
  digests: string[]
  layers: string[]
}

function hasSameLayers(left: string[], right: string[]): boolean {
  return left.length > 0
    && left.length === right.length
    && left.every((layer, index) => layer === right[index])
}

/**
 * 本地镜像是否落后于远端。
 * Docker 部署下更新只按镜像内容判断，而同一份内容可以有多种凭据：manifest list、
 * 平台清单、config、未压缩层摘要 —— 本地与远端各持其中一部分（`docker pull` 记录
 * manifest list 摘要，`docker load` 导入的离线包连 config 摘要都与 registry 不同）。
 * 所以先比摘要集合，再退回比层指纹：只要有一种凭据对上，就是同一个镜像。
 */
export function isImageOutdated(input: {
  local: ImageIdentity
  remote: ImageIdentity
}): boolean {
  if (input.remote.digests.length === 0 && input.remote.layers.length === 0) {
    return false
  }
  if (input.local.digests.length === 0 && input.local.layers.length === 0) {
    return true
  }
  if (input.local.digests.some(digest => input.remote.digests.includes(digest))) {
    return false
  }
  return !hasSameLayers(input.local.layers, input.remote.layers)
}

async function buildImageUpdateInfo(
  image: string,
  fallbackReleaseVersion: string | null,
  remoteImageOverride?: string,
): Promise<HubImageUpdateInfo> {
  const parsed = parseImageRef(image)
  let localDigests: string[] = []
  let localLayers: string[] = []
  let remoteDigests: string[] = []
  let remoteLayers: string[] = []
  let remotePrimary: string | null = null
  let localPresent = false
  let releaseVersion = fallbackReleaseVersion
  let checkError: string | null = null

  try {
    const local = await inspectLocalImageDigest(image)
    localDigests = local.digests
    localLayers = local.layers
    localPresent = local.present
    releaseVersion = local.releaseVersion || releaseVersion
  }
  catch (error) {
    checkError = normalizeErrorMessages([
      checkError,
      error instanceof Error ? error.message : String(error),
    ])
  }

  try {
    // 远端基准默认与本地同为 panelImage；跨版本检查时传入目标版本镜像 ref
    const remote = await fetchRemoteImageIdentity(remoteImageOverride || image)
    remotePrimary = remote.primary
    remoteLayers = remote.layers
    remoteDigests = [...new Set(
      [remote.primary, ...remote.aliases]
        .filter((digest): digest is string => Boolean(digest)),
    )]
  }
  catch (error) {
    checkError = normalizeErrorMessages([
      checkError,
      error instanceof Error ? error.message : String(error),
    ])
  }

  const localDigest = localDigests[0] ?? null

  return {
    image,
    tag: parsed.tag,
    releaseVersion,
    localDigest,
    localDigestShort: shortDigest(localDigest),
    remoteDigest: remotePrimary,
    remoteDigestShort: shortDigest(remotePrimary),
    updateAvailable: isImageOutdated({
      local: { digests: localDigests, layers: localLayers },
      remote: { digests: remoteDigests, layers: remoteLayers },
    }),
    localPresent,
    checkError,
  }
}

function buildEmptyStatus(): PanelUpdateStatus {
  const config = loadServerConfig()
  const applySupport = resolveApplySupport(config)
  const emptyImage = (image: string): HubImageUpdateInfo => ({
    image,
    tag: parseImageRef(image).tag,
    releaseVersion: null,
    localDigest: null,
    localDigestShort: null,
    remoteDigest: null,
    remoteDigestShort: null,
    updateAvailable: false,
    localPresent: false,
    checkError: null,
  })
  return {
    runtimeMode: config.runtimeMode,
    image: emptyImage(config.panelImage),
    release: null,
    lastCheckedAt: null,
    checking: false,
    ...buildRuntimeFields(),
    ...buildApplyFields(applySupport),
    updateKind: 'none',
    checkError: null,
  }
}

export function getCachedPanelUpdateStatus(): PanelUpdateStatus {
  return cachedStatus ?? buildEmptyStatus()
}

export async function refreshPanelUpdateStatus(): Promise<PanelUpdateStatus> {
  if (checkInFlight) {
    return checkInFlight
  }

  checkInFlight = (async () => {
    const config = loadServerConfig()
    const applySupport = resolveApplySupport(config)
    const envReleaseVersion = resolveReleaseVersionFromEnv()
    if (config.runtimeMode === 'native') {
      const release = await fetchLatestGitHubRelease(config.githubRepo)
      const currentVersion = envReleaseVersion || null
      const latestVersion = release?.tagName ?? null
      const nativeUpdateAvailable = isReleaseNewer(currentVersion, latestVersion)
      // Native 的状态有两个来源：本进程刚发起的下载/安装（内存态），以及 root 执行器写的
      // state.json（跨面板重启存活）。合并规则见 mergeNativeUpdateRuntime。
      const nativeSupport = resolveNativeUpdateSupport(config)
      const targetTag = nativeUpdateAvailable ? latestVersion : null
      const nativeState = nativeSupport.supported ? readNativeUpdateState(nativeSupport.dir) : null
      const prefetchedReady = nativeSupport.supported && targetTag
        ? resolvePrefetchedArchive(nativeSupport.dir, targetTag) !== null
        : false
      const merged = mergeNativeUpdateRuntime({
        runtimePhase: runtime.phase,
        runtimeMessage: runtime.message,
        runtimeError: runtime.error,
        runtimeTargetTag: runtime.targetImage,
        runtimeTargetReady: runtime.targetImageReady,
        state: nativeState,
        targetTag,
        prefetchedReady,
        updateAvailable: nativeUpdateAvailable,
      })
      // 合并结果回写内存态：字段语义与 Docker 分支保持一致，前端无需分模式处理进度
      runtime = {
        phase: merged.phase,
        message: merged.message,
        error: merged.error,
        startedAt: runtime.startedAt,
        targetImage: merged.targetTag,
        targetImageReady: merged.targetReady,
        downloadBytes: runtime.downloadBytes,
        downloadTotalBytes: runtime.downloadTotalBytes,
      }
      const image: HubImageUpdateInfo = {
        image: 'native-release',
        tag: currentVersion || 'unknown',
        releaseVersion: currentVersion,
        localDigest: config.buildSha || null,
        localDigestShort: config.buildSha ? config.buildSha.slice(0, 12) : null,
        remoteDigest: null,
        remoteDigestShort: null,
        updateAvailable: nativeUpdateAvailable,
        localPresent: true,
        checkError: release ? null : '无法读取最新 GitHub Release',
      }
      const nextStatus: PanelUpdateStatus = {
        runtimeMode: config.runtimeMode,
        image,
        release,
        lastCheckedAt: new Date().toISOString(),
        checking: false,
        ...buildRuntimeFields(),
        ...buildApplyFields(applySupport, latestVersion),
        updateKind: resolveUpdateKind({
          runtimeMode: 'native',
          updateAvailable: nativeUpdateAvailable,
          currentVersion,
          latestVersion,
        }),
        checkError: image.checkError,
      }
      cachedStatus = nextStatus
      return nextStatus
    }
    const release = await fetchLatestGitHubRelease(config.githubRepo)
    // 固定 tag 自比自恒为“无更新”，新版本发布后面板不会提示跨版本升级。
    // 只要读取到 Release 版本，就以该版本解析出的目标镜像作为远端基准重新比对；
    // Release 拉取失败时退回 panelImage 固定 tag，维持原行为。
    const targetImage = release?.tagName
      ? resolveTargetImageRef(release.tagName, config.panelImage)
      : config.panelImage
    const image = await buildImageUpdateInfo(config.panelImage, envReleaseVersion, targetImage)

    const nextStatus: PanelUpdateStatus = {
      runtimeMode: config.runtimeMode,
      image,
      release,
      lastCheckedAt: new Date().toISOString(),
      checking: false,
      ...buildRuntimeFields(),
      ...buildApplyFields(applySupport, release?.tagName),
      updateKind: resolveUpdateKind({
        runtimeMode: 'docker',
        updateAvailable: image.updateAvailable,
        currentVersion: image.releaseVersion,
        latestVersion: release?.tagName ?? null,
      }),
      checkError: image.checkError,
    }
    cachedStatus = nextStatus
    return nextStatus
  })().finally(() => {
    checkInFlight = null
  })

  if (cachedStatus) {
    cachedStatus = {
      ...cachedStatus,
      checking: true,
      ...buildRuntimeFields(),
    }
  }
  return checkInFlight
}

/**
 * 目标镜像引用：Release tag 优先（跨版本升级），读不到 Release 时回退到当前 panelImage，
 * 保留「同一个 tag 的镜像内容被重推」这一场景的行为。
 */
export function resolveTargetImageRef(releaseTag: string | null, panelImage: string): string {
  const parsed = parseImageRef(panelImage)
  const tag = normalizeReleaseTag(releaseTag, parsed.tag)
  return buildImageRef(parsed.registry, parsed.repository, tag)
}

/** 离线镜像包的两步命令；与发布流水线上传的资产命名一致（docker-publish.yml）。 */
export function buildOfflineImageCommand(githubRepo: string, releaseTag: string | null): string | null {
  const tag = releaseTag?.trim()
  const repo = githubRepo.trim()
  if (!tag || !repo) {
    return null
  }
  const asset = `${releaseBrandName(tag)}-${tag}-docker-image.tar.gz`
  return [
    `wget https://github.com/${repo}/releases/download/${tag}/${asset}`,
    `gunzip -c ${asset} | docker load`,
  ].join('\n')
}

/**
 * updater 容器内执行的脚本：把目标镜像写进 panel.env，再重建面板。
 * 面板容器以只读方式挂载 stack 目录、改不了 panel.env，只有这个临时容器有写权限。
 * 这里刻意不调用 compose pull：镜像要么已在本地（离线包导入），要么刚由面板拉好。
 */
export function buildUpdaterShellCommand(
  targetImage: string,
  releaseTag: string | null,
  config: ServerConfig = loadServerConfig(),
): string {
  const composeArgs = config.composeFiles.map(file => `-f /stack/${file}`).join(' ')
  const resolvedTag = normalizeReleaseTag(releaseTag, parseImageRef(targetImage).tag)
  const pairs = [
    `PANEL_IMAGE=${targetImage}`,
    `BSP_GAME_DST_IMAGE=${targetImage}`,
    `BSP_STEAMCMD_IMAGE=${targetImage}`,
    `BSP_RELEASE_VERSION=${resolvedTag}`,
    // Existing Compose files still consume the legacy image keys.
    `GSH_GAME_DST_IMAGE=${targetImage}`,
    `GSH_STEAMCMD_IMAGE=${targetImage}`,
    `GSH_RELEASE_VERSION=${resolvedTag}`,
  ]
  const quotedPairs = pairs.map(pair => `'${pair}'`).join(' ')
  const panelContainerName = config.panelContainerName.replace(/'/g, "'\\''")
  const rollback = `cp /stack/$backup /stack/panel.env && docker compose -p "$project" --env-file /stack/panel.env ${composeArgs} up -d panel`
  return [
    'set -e',
    'cd /stack',
    `project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' '${panelContainerName}')"`,
    'case "$project" in',
    '  ""|"<no value>") echo "[bsp] 无法读取现有面板的 Compose 项目名，已停止更新"; exit 1 ;;',
    'esac',
    'backup="panel.env.bak.$(date +%Y%m%d%H%M%S)"',
    'cp panel.env "$backup"',
    'echo "[bsp] panel.env 已备份到 $backup"',
    `for pair in ${quotedPairs}; do`,
    '  key="${pair%%=*}"',
    '  if grep -q "^${key}=" panel.env; then',
    '    sed -i "s|^${key}=.*|${pair}|" panel.env',
    '  else',
    '    echo "${pair}" >> panel.env',
    '  fi',
    'done',
    `if ! docker compose -p "$project" --env-file panel.env ${composeArgs} up -d panel; then`,
    `  echo "[bsp] 重建面板失败，可回滚：${rollback}"`,
    '  exit 1',
    'fi',
    'echo "[bsp] 面板重建完成"',
  ].join('\n')
}

export interface UpdaterImageCandidate {
  ref: string
  /** 本地缺失时是否允许拉取；目标镜像/当前面板镜像在重建前必然已在本地 */
  canPull: boolean
}

/**
 * updater 容器镜像候选（按序尝试）：
 * 显式配置 → 目标镜像 → 当前面板镜像 → 官方 CLI 镜像兜底。
 * v0.3.10 起统一镜像自带 docker CLI 与 compose 插件，因此前三个通常直接命中，
 * 离线/国内网络下不会再因为拉不到 docker:27-cli 而整条更新链路失败。
 */
export function buildUpdaterImageCandidates(input: {
  configuredUpdaterImage?: string | null
  targetImage: string
  panelImage: string
}): UpdaterImageCandidate[] {
  const candidates: UpdaterImageCandidate[] = []
  const seen = new Set<string>()
  const push = (ref: string | null | undefined, canPull: boolean) => {
    const normalized = ref?.trim()
    if (!normalized || seen.has(normalized)) {
      return
    }
    seen.add(normalized)
    candidates.push({ ref: normalized, canPull })
  }
  push(input.configuredUpdaterImage, true)
  push(input.targetImage, false)
  push(input.panelImage, false)
  for (const image of FALLBACK_UPDATER_IMAGES) {
    push(image, true)
  }
  return candidates
}

export interface UpdaterImageResolverDeps {
  isPresent: (image: string) => Promise<boolean>
  probe: (image: string) => Promise<boolean>
  pull: (image: string) => Promise<{ ok: true } | { ok: false, error: string, tried: string[] }>
}

export interface UpdaterImageResolution {
  image: string | null
  tried: string[]
  failures: string[]
}

/** 逐个候选探测 updater 能力：本地已存在的优先，本地都不行时才拉取兜底镜像 */
export async function resolveUpdaterImage(
  candidates: UpdaterImageCandidate[],
  deps: UpdaterImageResolverDeps,
): Promise<UpdaterImageResolution> {
  const tried: string[] = []
  const failures: string[] = []
  for (const candidate of candidates) {
    tried.push(candidate.ref)
    if (await deps.isPresent(candidate.ref)) {
      if (await deps.probe(candidate.ref)) {
        return { image: candidate.ref, tried, failures }
      }
      failures.push(`${candidate.ref}：镜像内没有可用的 docker compose`)
      continue
    }
    if (!candidate.canPull) {
      failures.push(`${candidate.ref}：本地不存在`)
      continue
    }
    const pulled = await deps.pull(candidate.ref)
    if (!pulled.ok) {
      failures.push(formatPullError(pulled.error, candidate.ref, pulled.tried))
      continue
    }
    if (await deps.probe(candidate.ref)) {
      return { image: candidate.ref, tried, failures }
    }
    failures.push(`${candidate.ref}：拉取成功但镜像内没有可用的 docker compose`)
  }
  return { image: null, tried, failures }
}

/** 所有候选都不可用时的用户可读说明：先说清试过什么，再给手动更新与离线路径 */
export function buildUpdaterImageFailureMessage(
  resolution: UpdaterImageResolution,
  releaseTag: string | null,
  config: ServerConfig = loadServerConfig(),
): string {
  const manual = buildManualUpdateCommand(resolveApplySupport(config).stackPaths, releaseTag)
  return [
    `无法准备面板更新容器：${resolution.tried.join('、')} 都不可用。`,
    ...resolution.failures,
    '可在服务器终端执行手动更新：',
    manual,
    '更新完成后面板内一键更新会恢复可用（新版本镜像自带 docker CLI 与 compose）。',
  ].join('\n')
}

const updaterImageProbeCache = new Map<string, boolean>()

/** 试跑一次 `docker compose version`，确认候选镜像能当 updater 运行时用 */
async function probeUpdaterImage(docker: DockerClient, image: string): Promise<boolean> {
  const cached = updaterImageProbeCache.get(image)
  if (cached !== undefined) {
    return cached
  }
  let container: DockerClient.Container | null = null
  let usable = false
  try {
    container = await docker.createContainer({
      Image: image,
      Entrypoint: ['sh'],
      Cmd: ['-c', 'docker compose version >/dev/null 2>&1'],
    })
    await container.start()
    const result = await container.wait() as { StatusCode?: number } | undefined
    usable = (result?.StatusCode ?? 1) === 0
  }
  catch {
    usable = false
  }
  finally {
    try {
      await container?.remove({ force: true })
    }
    catch {
      // 探针容器已自行退出/被清理
    }
  }
  updaterImageProbeCache.set(image, usable)
  return usable
}

async function startPanelComposeUpdater(input: {
  applySupport: ApplySupport
  targetImage: string
  releaseTag: string | null
  updaterImage: string
}): Promise<string> {
  const { applySupport } = input
  if (!applySupport.imageSupported || !applySupport.stackPaths) {
    throw new Error(applySupport.hint || '当前环境不支持一键更新面板')
  }

  const docker = resolveDocker()
  try {
    const existing = docker.getContainer(UPDATER_CONTAINER_NAME)
    await existing.inspect()
    await existing.remove({ force: true })
  }
  catch {
    // 没有残留的 updater 容器
  }

  const container = await docker.createContainer({
    name: UPDATER_CONTAINER_NAME,
    Image: input.updaterImage,
    Cmd: ['sh', '-c', buildUpdaterShellCommand(input.targetImage, input.releaseTag)],
    HostConfig: {
      // 保留退出容器，失败时读取日志；成功后由 watcher 清理，下次重试也会清理残留。
      AutoRemove: false,
      Binds: [
        '/var/run/docker.sock:/var/run/docker.sock',
        // 可写：updater 要把目标镜像写进 panel.env，否则面板重启后会回退到旧版本
        `${applySupport.stackPaths.hostDir}:/stack`,
      ],
    },
  })
  await container.start()
  return container.id
}

const PORT_SYNC_CONTAINER_NAME = 'bubblesharkpanel-port-sync'

async function removeContainerIfExists(docker: DockerClient, name: string): Promise<void> {
  try {
    const container = docker.getContainer(name)
    await container.inspect()
    await container.remove({ force: true })
  }
  catch {
    // 没有残留容器
  }
}

/**
 * 用一次性容器把面板端口写进部署目录的 panel.env。
 *
 * 面板容器对该目录是只读挂载（`/stack:ro`），改不了自己的部署配置——一键更新同样因此需要临时容器。
 * 这里与一键更新共用镜像解析，但刻意不执行 compose up：端口在用户下次重启面板时生效。
 */
export async function writePanelPortViaStackContainer(input: {
  stackPaths: StackPaths
  envKey: PanelPortEnvKey
  port: number
}): Promise<{ ok: true } | { ok: false, error: string }> {
  const config = loadServerConfig()
  const docker = resolveDocker()
  await removeContainerIfExists(docker, PORT_SYNC_CONTAINER_NAME)

  const resolution = await resolveUpdaterImage(
    buildUpdaterImageCandidates({
      configuredUpdaterImage: config.panelUpdaterImage,
      targetImage: config.panelImage,
      panelImage: config.panelImage,
    }),
    {
      isPresent: image => isImagePresentByRef(docker, image),
      probe: image => probeUpdaterImage(docker, image),
      pull: async (image) => {
        const result = await pullImageWithCandidates(
          docker,
          buildImageCandidates(image, resolveImageMirrorsRaw()),
          image,
          { maxAttempts: TARGET_PULL_MAX_ATTEMPTS, retryBaseMs: TARGET_PULL_RETRY_BASE_MS, sleep },
        )
        return result.ok ? { ok: true as const } : result
      },
    },
  )
  if (!resolution.image) {
    return {
      ok: false,
      error: `没有可用的写入容器：${resolution.failures.join('；') || resolution.tried.join('、')}`,
    }
  }

  try {
    const container = await docker.createContainer({
      name: PORT_SYNC_CONTAINER_NAME,
      Image: resolution.image,
      Cmd: ['sh', '-c', buildPanelPortWriteScript(input.envKey, input.port)],
      HostConfig: {
        // 只挂部署目录并保持可写；脚本只做备份与替换，不碰容器
        Binds: [`${input.stackPaths.hostDir}:/stack`],
      },
    })
    await container.start()
    const result = await container.wait() as { StatusCode?: number } | null
    const exitCode = result?.StatusCode ?? 0
    if (exitCode !== 0) {
      let detail = ''
      try {
        const raw = await container.logs({ stdout: true, stderr: true, tail: 5 })
        const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
        detail = text.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300)
      }
      catch {
        detail = ''
      }
      return { ok: false, error: `写入端口失败（退出码 ${exitCode}）${detail ? `：${detail}` : ''}` }
    }
    return { ok: true }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  finally {
    await removeContainerIfExists(docker, PORT_SYNC_CONTAINER_NAME)
  }
}

/** updater 失败（面板没被换掉）时必须复位状态，否则界面会永久停在「更新中」 */
function watchUpdaterContainer(containerId: string): void {
  const container = resolveDocker().getContainer(containerId)
  container.wait()
    .then(async (result: unknown) => {
      const code = (result as { StatusCode?: number } | null)?.StatusCode ?? 0
      if (code !== 0 && runtime.phase === 'recreating') {
        let detail = ''
        try {
          const raw = await container.logs({ stdout: true, stderr: true, tail: 20 })
          detail = (Buffer.isBuffer(raw) ? stripDockerLogFrame(raw) : String(raw)).trim().slice(-2000)
        }
        catch {
          // 日志不可读时仍报告退出码，保留失败容器以便从宿主机排查。
        }
        updateRuntime({
          phase: 'failed',
          message: null,
          error: `重建面板失败（updater 退出码 ${code}）。${detail ? `\n${detail}` : '请查看 bubblesharkpanel-updater 容器日志。'}`,
        })
      }
      if (code === 0) {
        await container.remove()
      }
    })
    .catch(() => {
      // 面板正在重启或容器已被清理导致连接中断。
    })
}

export interface PanelUpdateApplyResult {
  status: 'updating' | 'completed' | 'ready'
  message: string
}

/**
 * 触发面板更新。
 * 这里只做校验与状态登记，真正的下载与重建交给后台任务 —— 拉取动辄数分钟，
 * 同步等待会让前端请求超时，界面就会看到「更新失败」而服务端其实还在跑。
 * download 只把镜像拉到本地并停在「等待安装」，install 才重建面板。
 */
export async function applyPanelUpdate(action: PanelUpdateAction = 'auto'): Promise<PanelUpdateApplyResult> {
  if (isUpdating()) {
    throw new Error('更新正在进行中，请稍后再试')
  }

  const status = cachedStatus ?? await refreshPanelUpdateStatus()
  const config = loadServerConfig()
  const applySupport = resolveApplySupport(config)
  if (config.runtimeMode === 'native' && !applySupport.nativeSupported) {
    // 旧安装没有更新组件：明确告知重跑安装脚本，而不是让人对着一条用不了的按钮发呆。
    throw new Error(applySupport.hint || NATIVE_UPDATE_INSTALLER_HINT)
  }
  const rawReleaseTag = status.release?.tagName?.trim() || null
  /**
   * 规范化后再往下传：镜像引用、离线包文件名与 updater 写回 panel.env 的值必须来自同一个 tag，
   * 否则自建/fork 的 release 命名会让离线包地址与镜像引用对不上。读不到 Release 时保持 null。
   */
  const releaseTag = rawReleaseTag
    ? normalizeReleaseTag(
        rawReleaseTag,
        config.runtimeMode === 'native'
          ? (config.releaseVersion || 'unknown')
          : parseImageRef(config.panelImage).tag,
      )
    : null

  // 更新包/镜像已就绪：跳过下载，直接进入安装（用户可能在别的标签页完成了下载）
  if (runtime.phase === 'downloaded' && runtime.targetImageReady && runtime.targetImage) {
    if (action === 'download') {
      return { status: 'ready', message: '更新内容已在服务器上，点击「立即安装」即可完成更新。' }
    }
    return startPanelUpdateInstall({
      applySupport,
      targetImage: runtime.targetImage,
      releaseTag,
    })
  }

  if (!status.image.updateAvailable) {
    return { status: 'completed', message: '当前已是最新版本' }
  }

  if (config.runtimeMode === 'native' && !releaseTag) {
    throw new Error('未能读取最新 Release 信息，无法确定要安装的版本。请点击「检查更新」后重试。')
  }

  // Native 下 targetImage 承载的是目标版本 tag（没有镜像引用这回事）
  const targetImage = config.runtimeMode === 'native'
    ? (releaseTag as string)
    : resolveTargetImageRef(releaseTag, config.panelImage)

  ensureUpdateWatchdog()
  runtime = {
    ...createIdleRuntime(),
    phase: 'preparing',
    message: config.runtimeMode === 'native' ? '正在准备更新包…' : '正在检查本地镜像…',
    startedAt: Date.now(),
    targetImage,
  }
  syncRuntimeToCachedStatus()

  void runPanelUpdate({ mode: action, applySupport, targetImage, releaseTag })

  return {
    status: 'updating',
    message: action === 'download'
      ? '正在下载更新镜像，页面会显示下载进度。'
      : '更新已开始，页面会自动显示进度。',
  }
}

/** 安装段入口：登记状态后由后台重建面板（重建会重启面板，不能同步等待） */
function startPanelUpdateInstall(input: {
  applySupport: ApplySupport
  targetImage: string
  releaseTag: string | null
}): PanelUpdateApplyResult {
  ensureUpdateWatchdog()
  updateRuntime({
    phase: 'installing',
    message: '正在准备更新容器…',
    error: null,
    startedAt: Date.now(),
    targetImage: input.targetImage,
  })
  void runPanelUpdate({ mode: 'install', ...input })
  return { status: 'updating', message: '正在安装更新，面板稍后会自动重启。' }
}

function buildPullFailureMessage(
  result: { error: string, tried: string[] },
  targetImage: string,
  releaseTag: string | null,
): string {
  const detail = formatPullError(result.error, targetImage, result.tried)
  const offlineCommand = buildOfflineImageCommand(loadServerConfig().githubRepo, releaseTag)
  if (!offlineCommand) {
    return detail
  }
  return [
    detail,
    '也可以在能访问 GitHub 的机器上下载离线镜像包后导入：',
    offlineCommand,
    '导入后回到本页点击「下载更新」，面板会检测到本地镜像并直接进入安装，不再下载。',
  ].join('\n')
}

/** 一次更新任务的调度：download 只下载，install 只安装，auto 为下载完成后立即安装 */
async function runPanelUpdate(input: {
  mode: PanelUpdateAction
  applySupport: ApplySupport
  targetImage: string
  releaseTag: string | null
}): Promise<void> {
  if (loadServerConfig().runtimeMode === 'native') {
    if (input.mode !== 'install') {
      const downloaded = await downloadNativeTarget(input)
      if (!downloaded || input.mode === 'download') {
        return
      }
    }
    await installNativeTarget(input)
    return
  }
  if (input.mode !== 'install') {
    const downloaded = await downloadTargetImage(input)
    if (!downloaded || input.mode === 'download') {
      return
    }
  }
  await installPanelUpdate(input)
}

/**
 * Native 下载段：把 Native Release 包拉到 `<更新目录>/<tag>/`，带进度与断点续传。
 * 执行器安装前会用官方 `.sha256` 独立复核这个包，所以这里下载的字节即便被替换也进不了系统。
 */
async function downloadNativeTarget(input: {
  applySupport: ApplySupport
  targetImage: string
  releaseTag: string | null
}): Promise<boolean> {
  try {
    const config = loadServerConfig()
    const support = resolveNativeUpdateSupport(config)
    if (!input.applySupport.nativeSupported || !support.supported) {
      updateRuntime({
        phase: 'failed',
        message: null,
        error: input.applySupport.hint || NATIVE_UPDATE_INSTALLER_HINT,
      })
      return false
    }
    const tag = input.releaseTag
    if (!tag) {
      updateRuntime({
        phase: 'failed',
        message: null,
        error: '未能读取最新 Release 信息，无法拼出更新包地址。请点击「检查更新」后重试。',
      })
      return false
    }
    if (resolvePrefetchedArchive(support.dir, tag)) {
      updateRuntime({
        phase: 'downloaded',
        targetImage: tag,
        targetImageReady: true,
        message: '更新包已在服务器上，可直接安装。',
      })
      return true
    }

    // 与镜像下载同构：一进入下载循环就切到 downloading。界面只在这个阶段渲染
    // 「已下载 x MB / y MB」，「更新已下载」提示也把它当作前一阶段 ——
    // 少了这一步，Native 更新包会把进度与完成提示一起吞掉。
    updateRuntime({
      phase: 'downloading',
      message: '正在下载更新包，请勿关闭面板',
      downloadBytes: 0,
      downloadTotalBytes: null,
    })
    const report = createProgressReporter()
    const result = await downloadNativeReleaseArchive({
      dir: support.dir,
      githubRepo: config.githubRepo,
      releaseTag: tag,
      githubProxy: config.githubProxy,
      onProgress: progress => report(progress.downloadedBytes, progress.totalBytes),
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    cleanupStalePrefetchedArchives(support.dir, tag)
    updateRuntime({
      phase: 'downloaded',
      targetImage: tag,
      targetImageReady: true,
      message: '更新包已下载完成，点击「立即安装」完成更新。',
    })
    return true
  }
  catch (error) {
    updateRuntime({
      phase: 'failed',
      message: null,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Native 安装段：写请求文件即返回，真正的安装由 root 执行器完成。
 * 面板通常会在几十秒后被杀掉重启，所以状态同时存在于内存（本进程）与 state.json（跨重启）。
 */
async function installNativeTarget(input: {
  applySupport: ApplySupport
  targetImage: string
  releaseTag: string | null
}): Promise<void> {
  try {
    const config = loadServerConfig()
    const support = resolveNativeUpdateSupport(config)
    if (!input.applySupport.nativeSupported || !support.supported) {
      updateRuntime({
        phase: 'failed',
        message: null,
        error: input.applySupport.hint || NATIVE_UPDATE_INSTALLER_HINT,
      })
      return
    }
    const tag = input.releaseTag
    if (!tag) {
      updateRuntime({
        phase: 'failed',
        message: null,
        error: '缺失目标版本，无法发起安装。请点击「检查更新」后重试。',
      })
      return
    }
    if (!resolvePrefetchedArchive(support.dir, tag)) {
      updateRuntime({
        phase: 'failed',
        message: null,
        error: '更新包尚未下载完成，请先点击「下载更新」。',
      })
      return
    }

    updateRuntime({
      phase: 'recreating',
      targetImage: tag,
      targetImageReady: true,
      startedAt: Date.now(),
      message: `正在安装 ${tag} 并重启面板，约 1-3 分钟后自动重连`,
    })
    writeNativeUpdateRequest(support.dir, tag)
    watchNativeUpdateState(support.dir, tag)
  }
  catch (error) {
    updateRuntime({
      phase: 'failed',
      message: null,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** 轮询执行器写的状态文件；面板重启后这条链路由 refreshPanelUpdateStatus 接管 */
function watchNativeUpdateState(dir: string, tag: string): void {
  const deadline = Date.now() + NATIVE_INSTALL_WATCH_MS
  const timer = setInterval(() => {
    const state = readNativeUpdateState(dir)
    if (state?.phase === 'done') {
      clearInterval(timer)
      runtime = createIdleRuntime()
      syncRuntimeToCachedStatus()
      return
    }
    if (state?.phase === 'failed') {
      clearInterval(timer)
      updateRuntime({
        phase: 'failed',
        message: null,
        error: state.message || `更新到 ${tag} 失败，详情见服务器上的更新日志。`,
      })
      return
    }
    if (Date.now() > deadline) {
      clearInterval(timer)
      updateRuntime({
        phase: 'failed',
        message: null,
        error: `等待更新结果超过 ${Math.round(NATIVE_INSTALL_WATCH_MS / 60_000)} 分钟。请到服务器上查看更新日志与面板服务状态。`,
      })
    }
  }, NATIVE_INSTALL_POLL_MS)
  timer.unref()
}

/**
 * 下载段：只把目标镜像拉到本地，完成后停在 downloaded 等用户点「立即安装」。
 * 返回 false 表示下载失败（状态已写成 failed）。
 */
async function downloadTargetImage(input: {
  applySupport: ApplySupport
  targetImage: string
  releaseTag: string | null
}): Promise<boolean> {
  try {
    // 重建都不支持时不要白下几百 MB
    if (!input.applySupport.imageSupported) {
      updateRuntime({
        phase: 'failed',
        message: null,
        error: `${input.applySupport.hint || '当前部署方式不支持面板内重建。'}请使用下方手动命令，或重跑安装脚本后重试。`,
      })
      return false
    }

    const docker = resolveDocker()
    if (await isImagePresentByRef(docker, input.targetImage)) {
      updateRuntime({
        phase: 'downloaded',
        targetImageReady: true,
        message: '检测到本地已有目标镜像，可直接安装。',
      })
      return true
    }

    // 默认先取 Release 离线镜像包：GHCR 的镜像层域名在国内基本不可达，而离线包能走
    // GitHub 加速代理，且 HTTP 带 Content-Length，进度也准。
    const source = await resolvePanelUpdateSource()
    let offlineError: string | null = null
    if (source !== 'pull') {
      if (!input.releaseTag) {
        // 用户明确要求只用离线包，但没有 Release tag 就拼不出资产地址，不能偷偷改走 registry
        if (source === 'offline') {
          updateRuntime({
            phase: 'failed',
            message: null,
            error: '未能读取最新 Release 信息，无法拼出离线镜像包地址。请点击「检查更新」后重试，或把「更新下载源」改为自动 / 仅镜像仓库。',
          })
          return false
        }
      }
      else {
        const offline = await downloadTargetImageFromRelease({
          docker,
          releaseTag: input.releaseTag,
          targetImage: input.targetImage,
        })
        if (offline.ok) {
          updateRuntime({
            phase: 'downloaded',
            targetImageReady: true,
            message: '镜像已下载完成，点击「立即安装」完成更新。',
          })
          return true
        }
        offlineError = offline.error
        if (source === 'offline') {
          updateRuntime({ phase: 'failed', message: null, error: offlineError })
          return false
        }
      }
    }

    updateRuntime({
      phase: 'downloading',
      message: offlineError
        ? '离线镜像包不可用，改用镜像仓库拉取'
        : '正在下载更新镜像，请勿关闭面板',
      downloadBytes: 0,
      downloadTotalBytes: null,
    })

    const progress = createPullProgressAggregator()
    const report = createProgressReporter()
    const result = await pullImageWithCandidates(
      docker,
      buildImageCandidates(input.targetImage, resolveImageMirrorsRaw()),
      input.targetImage,
      {
        maxAttempts: TARGET_PULL_MAX_ATTEMPTS,
        retryBaseMs: TARGET_PULL_RETRY_BASE_MS,
        sleep,
        onProgress: (event) => {
          progress.handle(event)
          const snapshot = progress.snapshot()
          report(snapshot.downloadedBytes, snapshot.totalBytes)
        },
      },
    )
    if (!result.ok) {
      throw new Error([
        offlineError ? `离线镜像包下载失败：${offlineError}` : null,
        buildPullFailureMessage(result, input.targetImage, input.releaseTag),
      ].filter(Boolean).join('\n'))
    }

    updateRuntime({
      phase: 'downloaded',
      targetImageReady: true,
      message: '镜像已下载完成，点击「立即安装」完成更新。',
    })
    return true
  }
  catch (error) {
    updateRuntime({
      phase: 'failed',
      message: null,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/** 面板里的选择（数据库）优先于环境变量 BSP_PANEL_UPDATE_SOURCE；两者都不可用时用 auto */
export function pickPanelUpdateSource(
  dbValue: string | null | undefined,
  envValue: 'auto' | 'offline' | 'pull',
): 'auto' | 'offline' | 'pull' {
  return dbValue === 'auto' || dbValue === 'offline' || dbValue === 'pull' ? dbValue : envValue
}

async function resolvePanelUpdateSource(): Promise<'auto' | 'offline' | 'pull'> {
  let dbValue: string | undefined
  try {
    dbValue = (await getSystemPanelSettings())?.updateSource
  }
  catch {
    // 读设置失败就退回环境变量
  }
  return pickPanelUpdateSource(dbValue, loadServerConfig().panelUpdateSource)
}

/** 离线镜像包落盘目录：与数据库同卷（容器内 /app/data），宿主机上也看得见 */
function resolveOfflineArchiveDir(): string {
  return path.join(path.dirname(loadServerConfig().dbPath), 'panel-update')
}

/**
 * 离线包下载段：Release 资产 → 流式校验 → docker load。
 * 成功即认为镜像就绪；失败把原因带回去，由调用方决定是否回退 registry 拉取。
 */
async function downloadTargetImageFromRelease(input: {
  docker: DockerClient
  releaseTag: string
  targetImage: string
}): Promise<{ ok: true } | { ok: false, error: string }> {
  const config = loadServerConfig()
  const report = createProgressReporter()
  updateRuntime({
    phase: 'downloading',
    message: '正在下载离线更新包（GitHub Release）',
    downloadBytes: 0,
    downloadTotalBytes: null,
  })

  const result = await downloadOfflineImageArchive({
    urls: buildOfflineArchiveUrls({
      githubRepo: config.githubRepo,
      releaseTag: input.releaseTag,
      githubProxy: config.githubProxy,
    }),
    destinationDir: resolveOfflineArchiveDir(),
    fileName: buildOfflineArchiveName(input.releaseTag),
    onProgress: progress => report(progress.downloadedBytes, progress.totalBytes),
  })

  if (!result.ok) {
    const triedHint = result.tried.length > 0 ? `（已尝试 ${result.tried.length} 个下载来源）` : ''
    // 分片留着：下一次点击「下载更新」会从断点继续，不必重头再下几百 MB
    const resumeHint = result.partialBytes > 0
      ? `（已保留已下载的 ${formatBytes(result.partialBytes)}，重试会从断点继续）`
      : ''
    return { ok: false, error: `${result.error}${triedHint}${resumeHint}` }
  }

  // 记下导入前的镜像引用，用于确定这次 load 进来的是哪个 tag（拿不到就跳过别名，宁可不补也不猜）
  const tagsBefore = await listImageRepoTags(input.docker).catch(() => null)

  try {
    updateRuntime({ message: result.checksumVerified ? '正在校验并导入镜像，约需 1 分钟…' : '正在导入镜像，约需 1 分钟…' })
    await loadOfflineImageArchive(input.docker, result.filePath)
  }
  catch (error) {
    return { ok: false, error: `离线镜像包导入失败：${error instanceof Error ? error.message : String(error)}` }
  }
  finally {
    // 压缩包通常几百 MB，导入完立刻删掉
    fs.rmSync(result.filePath, { force: true })
  }

  if (tagsBefore) {
    await adoptImportedImage(input.docker, tagsBefore, input.targetImage)
  }
  if (!(await isImagePresentByRef(input.docker, input.targetImage))) {
    return {
      ok: false,
      error: `离线包已导入，但镜像 ${input.targetImage} 仍不可用，请检查 PANEL_IMAGE 是否与该版本 tag 一致`,
    }
  }
  return { ok: true }
}

/**
 * 离线包里的镜像引用由发布流程决定，可能与 PANEL_IMAGE 不同（自建仓库、自定义 tag）。
 * 用 load 前后本地镜像引用的差集确定这次导入了什么，再补一个指向目标引用的别名；
 * 不按仓库名去猜镜像引用 —— 仓库是 BubbleSharkPanel，镜像却是 bubblesharkpanel。
 */
async function adoptImportedImage(
  docker: DockerClient,
  tagsBefore: Set<string>,
  targetImage: string,
): Promise<void> {
  if (await isImagePresentByRef(docker, targetImage)) {
    return
  }
  try {
    const tagsAfter = await listImageRepoTags(docker)
    const imported = [...tagsAfter].find(tag => !tagsBefore.has(tag) && tag !== targetImage)
    if (imported) {
      await tagImageAlias(docker, imported, targetImage)
    }
  }
  catch {
    // 打不上别名就由调用方回退 registry 拉取
  }
}

/** 安装段：用已就绪的镜像跑 updater 容器重建面板 */
async function installPanelUpdate(input: {
  applySupport: ApplySupport
  targetImage: string
  releaseTag: string | null
}): Promise<void> {
  try {
    if (!input.applySupport.imageSupported || !input.applySupport.stackPaths) {
      updateRuntime({
        phase: 'failed',
        message: null,
        error: `镜像已就绪，但${input.applySupport.hint || '当前部署方式不支持面板内重建。'}请使用下方手动命令，或重跑安装脚本后重试。`,
      })
      return
    }

    const docker = resolveDocker()
    if (!runtime.targetImageReady && !(await isImagePresentByRef(docker, input.targetImage))) {
      updateRuntime({
        phase: 'failed',
        message: null,
        error: '更新镜像尚未下载完成，请先点击「下载更新」。',
      })
      return
    }

    // 安装段重新计时：下载可能已跑掉很久，但看门狗只该盯住接下来的重建
    updateRuntime({
      phase: 'installing',
      targetImageReady: true,
      startedAt: Date.now(),
      message: '正在准备更新容器…',
    })

    const config = loadServerConfig()
    const resolution = await resolveUpdaterImage(
      buildUpdaterImageCandidates({
        configuredUpdaterImage: config.panelUpdaterImage,
        targetImage: input.targetImage,
        panelImage: config.panelImage,
      }),
      {
        isPresent: image => isImagePresentByRef(docker, image),
        probe: image => probeUpdaterImage(docker, image),
        pull: async (image) => {
          const result = await pullImageWithCandidates(
            docker,
            buildImageCandidates(image, resolveImageMirrorsRaw()),
            image,
            { maxAttempts: TARGET_PULL_MAX_ATTEMPTS, retryBaseMs: TARGET_PULL_RETRY_BASE_MS, sleep },
          )
          return result.ok ? { ok: true as const } : result
        },
      },
    )
    if (!resolution.image) {
      updateRuntime({
        phase: 'failed',
        message: null,
        error: buildUpdaterImageFailureMessage(resolution, input.releaseTag),
      })
      return
    }
    updateRuntime({
      phase: 'recreating',
      message: `正在重建面板（更新容器：${resolution.image}），约 30 秒后自动重连`,
    })
    const containerId = await startPanelComposeUpdater({ ...input, updaterImage: resolution.image })
    watchUpdaterContainer(containerId)
  }
  catch (error) {
    updateRuntime({
      phase: 'failed',
      message: null,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function isPanelUpdateInProgress(): boolean {
  return isUpdating()
}

async function resolveCheckIntervalMs(): Promise<number> {
  const settings = await getSystemPanelSettings()
  const hours = settings?.updateCheckIntervalHours
    ?? getDefaultPanelSettings().updateCheckIntervalHours
  const normalizedHours = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_CHECK_INTERVAL_HOURS
  return normalizedHours * 60 * 60 * 1000
}

async function scheduleNextCheck(app: FastifyInstance) {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer)
  }
  const intervalMs = await resolveCheckIntervalMs()
  schedulerTimer = setTimeout(async () => {
    try {
      const settings = await getSystemPanelSettings()
      const autoUpdate = settings?.autoUpdate ?? getDefaultPanelSettings().autoUpdate
      if (autoUpdate) {
        await refreshPanelUpdateStatus()
      }
    }
    catch (error) {
      app.log.warn({ error }, 'Hub 镜像定时检查失败')
    }
    finally {
      void scheduleNextCheck(app)
    }
  }, intervalMs)
}

export function schedulePanelUpdateChecks(app: FastifyInstance) {
  if (readBrandEnv('BSP_UNIT_TEST') === '1') {
    return
  }
  if (schedulerStarted) {
    return
  }
  schedulerStarted = true

  setTimeout(async () => {
    try {
      const settings = await getSystemPanelSettings()
      const autoUpdate = settings?.autoUpdate ?? getDefaultPanelSettings().autoUpdate
      if (autoUpdate) {
        await refreshPanelUpdateStatus()
      }
    }
    catch (error) {
      app.log.warn({ error }, 'Hub 镜像首次检查失败')
    }
    finally {
      void scheduleNextCheck(app)
    }
  }, 30_000)
}
