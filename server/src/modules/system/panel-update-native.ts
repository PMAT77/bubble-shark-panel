import fs from 'node:fs'
import path from 'node:path'
import type { ServerConfig } from '../../shared/config'
import {
  GITHUB_PROXY_SITES,
  downloadReleaseArchive,
} from './panel-update-offline'
import type {
  OfflineArchiveDownloadResult,
  OfflineArchiveProgress,
} from './panel-update-offline'

/**
 * Native/systemd 部署的面板内更新：面板只做「准备字节 + 发起请求 + 展示状态」。
 *
 * 面板进程以非特权用户运行，既写不了 `releases/`，也不能重启自己的 systemd 服务。
 * 因此这里把真正的安装动作交给安装器布置的特权执行器：
 *   面板写 `<UPDATE_DIR>/request`（单行 = 目标版本 tag）
 *     -> game-server-hub-update.path（systemd, root）触发
 *       -> game-server-hub-update.service 执行 scripts/gsh-native-update.sh
 * 执行器会独立拉取官方 `.sha256` 校验面板预下载的包，因此面板无法借这条通道投递代码。
 * 本模块只提供纯函数与文件读写，不做任何特权操作。
 */

export const NATIVE_UPDATE_REQUEST_FILENAME = 'request'
export const NATIVE_UPDATE_STATE_FILENAME = 'state.json'
/** 安装器写入的 path unit 路径：它的存在代表这套安装已具备面板内更新能力 */
export const NATIVE_UPDATE_PATH_UNIT_FILE = '/etc/systemd/system/game-server-hub-update.path'
/** 特权更新执行器路径（与 path unit 的 ExecStart 一致）；缺失时面板内更新一定跑不起来 */
export const NATIVE_UPDATE_HELPER_FILE = '/usr/local/lib/game-server-hub/gsh-native-update'
/** 状态文件读取上限：它是 root 写的，但仍按不可信输入处理 */
export const NATIVE_UPDATE_STATE_MAX_BYTES = 8 * 1024

export const NATIVE_UPDATE_INSTALLER_HINT
  = '当前安装还没有面板内更新组件。重跑一次安装脚本即可在面板里一键更新（步骤见 docs/install-native.md 的升级章节）。'

export type NativeUpdatePhase = 'running' | 'done' | 'failed'

/** 与面板更新阶段同构的字符串联合：单独定义，避免与 panel-update.ts 形成模块循环 */
export type NativeUpdatePhaseName
  = | 'idle'
    | 'preparing'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'recreating'
    | 'failed'

export interface NativeUpdateState {
  phase: NativeUpdatePhase
  tag: string
  message: string
  startedAt: string | null
  updatedAt: string | null
  rolledBack: boolean
}

export interface NativeUpdateSupport {
  supported: boolean
  /** 请求/状态交换目录；不支持时也回填配置值，便于界面与排障 */
  dir: string
  hint: string | null
}

/** 只接受 `vX.Y.Z` 与带预发布后缀的形式；与执行器的校验保持一致 */
const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/

export function isValidReleaseTag(tag: string): boolean {
  return RELEASE_TAG_PATTERN.test(tag.trim())
}

/** Native Release 压缩包名，与 `scripts/build-native-release.mjs` 的产物一致 */
export function buildNativeReleaseAssetName(releaseTag: string): string {
  return `game-server-hub-native-${releaseTag}-linux-x64.tar.gz`
}

/**
 * 候选下载地址：加速代理前缀 → 直连，与离线镜像包一致。
 * `GSH_GITHUB_PROXY` 设置时只用该代理 + 直连。
 */
export function buildNativeReleaseUrls(input: {
  githubRepo: string
  releaseTag: string
  githubProxy?: string
}): string[] {
  const fileName = buildNativeReleaseAssetName(input.releaseTag)
  const direct = `https://github.com/${input.githubRepo}/releases/download/${input.releaseTag}/${fileName}`
  const proxy = input.githubProxy?.trim()
  const proxies = proxy ? [proxy] : GITHUB_PROXY_SITES
  const urls = proxies.map(prefix => `${prefix.replace(/\/+$/, '')}/${direct}`)
  // 直连永远作为最后一个候选：代理池全军覆没时仍有一次机会。
  urls.push(direct)
  return urls
}

export interface NativeUpdatePaths {
  dir: string
  requestFile: string
  stateFile: string
  archiveDir: string
  archiveFile: string
}

export function resolveNativeUpdatePaths(dir: string, releaseTag: string): NativeUpdatePaths {
  const root = dir.trim()
  return {
    dir: root,
    requestFile: path.join(root, NATIVE_UPDATE_REQUEST_FILENAME),
    stateFile: path.join(root, NATIVE_UPDATE_STATE_FILENAME),
    archiveDir: path.join(root, releaseTag),
    archiveFile: path.join(root, releaseTag, buildNativeReleaseAssetName(releaseTag)),
  }
}

/**
 * 能力探测：只有安装器布置过 path unit，并且面板能写交换目录时才允许面板内更新。
 * 老安装（未重跑过安装脚本）会走到这里并退回「去服务器执行命令」。
 */
export function resolveNativeUpdateSupport(
  config: Pick<ServerConfig, 'runtimeMode' | 'nativeUpdateDir'>,
  options: { pathUnitFile?: string, helperFile?: string } = {},
): NativeUpdateSupport {
  const dir = config.nativeUpdateDir?.trim() || ''
  if (config.runtimeMode !== 'native') {
    return { supported: false, dir, hint: null }
  }
  if (!dir || !path.isAbsolute(dir)) {
    return { supported: false, dir, hint: NATIVE_UPDATE_INSTALLER_HINT }
  }
  // path unit 与执行器缺一不可：少了任何一个，写进去的请求都不会有人处理，
  // 与其让面板停在「更新中」，不如直接告诉用户重跑安装脚本。
  const requiredFiles = [
    options.pathUnitFile ?? NATIVE_UPDATE_PATH_UNIT_FILE,
    options.helperFile ?? NATIVE_UPDATE_HELPER_FILE,
  ]
  for (const file of requiredFiles) {
    try {
      if (!fs.statSync(file).isFile()) {
        return { supported: false, dir, hint: NATIVE_UPDATE_INSTALLER_HINT }
      }
    }
    catch {
      return { supported: false, dir, hint: NATIVE_UPDATE_INSTALLER_HINT }
    }
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK)
  }
  catch {
    return { supported: false, dir, hint: NATIVE_UPDATE_INSTALLER_HINT }
  }
  return { supported: true, dir, hint: null }
}

/**
 * 写更新请求：临时文件 + 原子改名，执行器只需读到「完整的一行 tag」。
 * 内容格式与 `scripts/gsh-native-update.sh` 的校验一一对应（单行、≤64 字节）。
 */
export function writeNativeUpdateRequest(dir: string, releaseTag: string): void {
  const tag = releaseTag.trim()
  if (!isValidReleaseTag(tag)) {
    throw new Error(`版本号不合法，拒绝发起更新：${releaseTag}`)
  }
  const paths = resolveNativeUpdatePaths(dir, tag)
  fs.mkdirSync(paths.dir, { recursive: true })
  const tmp = `${paths.requestFile}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, `${tag}\n`, { encoding: 'utf8', mode: 0o644 })
  fs.renameSync(tmp, paths.requestFile)
}

/**
 * 读执行器写的状态文件。它是 root 产物但按不可信输入解析：
 * 文件过大、JSON 坏了、字段类型不对都只当作「没有状态」，绝不把异常抛给调用方。
 */
export function readNativeUpdateState(dir: string): NativeUpdateState | null {
  const file = path.join(dir, NATIVE_UPDATE_STATE_FILENAME)
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size <= 0 || stat.size > NATIVE_UPDATE_STATE_MAX_BYTES) {
      return null
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') {
      return null
    }
    const record = parsed as Record<string, unknown>
    const phase = record.phase
    if (phase !== 'running' && phase !== 'done' && phase !== 'failed') {
      return null
    }
    const asString = (value: unknown): string => (typeof value === 'string' ? value : '')
    const asNullableString = (value: unknown): string | null =>
      (typeof value === 'string' && value.trim() ? value : null)
    return {
      phase,
      tag: asString(record.tag).trim(),
      message: asString(record.message).trim(),
      startedAt: asNullableString(record.startedAt),
      updatedAt: asNullableString(record.updatedAt),
      rolledBack: record.rolledBack === true,
    }
  }
  catch {
    return null
  }
}

/** 面板预下载的包是否已就绪（执行器仍会用官方 `.sha256` 独立复核） */
export function resolvePrefetchedArchive(dir: string, releaseTag: string): string | null {
  const { archiveFile } = resolveNativeUpdatePaths(dir, releaseTag)
  try {
    const stat = fs.statSync(archiveFile)
    return stat.isFile() && stat.size > 0 ? archiveFile : null
  }
  catch {
    return null
  }
}

/**
 * 只保留目标版本的预下载包：每次升级会留下几十到几百 MB，攒着能把小机器磁盘吃满。
 * 只删「长得像版本号的目录」，交换目录里的其它内容（root 私有子目录等）一律不碰。
 */
export function cleanupStalePrefetchedArchives(dir: string, keepTag: string): void {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidReleaseTag(entry.name) || entry.name === keepTag) {
        continue
      }
      fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true })
    }
  }
  catch {
    // 清理失败不影响更新本身
  }
}

/**
 * 执行器状态超过这个时长还没更新就视为「已经中断」：它的 oneshot 有 45 分钟超时，
 * 被 SIGTERM / 机器重启打断时也可能来不及写终态，界面不能因此永久停在「更新中」。
 */
export const NATIVE_UPDATE_STALE_MS = 45 * 60 * 1000

function resolveStateAgeMs(state: NativeUpdateState | null, nowMs: number): number | null {
  if (!state) {
    return null
  }
  const stamp = state.updatedAt ?? state.startedAt
  if (!stamp) {
    return null
  }
  const parsed = Date.parse(stamp)
  if (!Number.isFinite(parsed)) {
    return null
  }
  return nowMs - parsed
}

/**
 * 把「内存态（本进程刚发起的下载/安装）」与「磁盘态（root 执行器写的状态文件）」合并成界面状态。
 *
 * 优先级说明：下载是本进程独有的进行中状态，最高优先；执行器写 running 说明它正在安装，
 * 此时面板可能马上被杀，必须以它为准；内存态的安装中其次；之后才是执行器留下的失败记录。
 * 失败时仍保留「包已就绪」，这样按钮会显示「立即安装」而不是让人重新下载。
 */
export function mergeNativeUpdateRuntime(input: {
  runtimePhase: NativeUpdatePhaseName
  runtimeMessage: string | null
  runtimeError: string | null
  runtimeTargetTag: string | null
  runtimeTargetReady: boolean
  state: NativeUpdateState | null
  targetTag: string | null
  prefetchedReady: boolean
  updateAvailable: boolean
  /** 判定执行器是否卡住的时间基准；测试可注入 */
  nowMs?: number
}): {
  phase: NativeUpdatePhaseName
  message: string | null
  error: string | null
  targetTag: string | null
  targetReady: boolean
} {
  const targetTag = input.targetTag
  const prefetchedReady = Boolean(targetTag) && input.prefetchedReady
  const nowMs = input.nowMs ?? Date.now()
  const stateAgeMs = resolveStateAgeMs(input.state, nowMs)
  const stateRunning = input.state?.phase === 'running'
  const stateStale = stateRunning && stateAgeMs !== null && stateAgeMs > NATIVE_UPDATE_STALE_MS

  if (input.runtimePhase === 'preparing' || input.runtimePhase === 'downloading') {
    return {
      phase: input.runtimePhase,
      message: input.runtimeMessage,
      error: input.runtimeError,
      targetTag: input.runtimeTargetTag ?? targetTag,
      targetReady: input.runtimeTargetReady,
    }
  }

  if (stateRunning && !stateStale) {
    return {
      phase: 'recreating',
      message: input.state?.message || `正在安装 ${input.state?.tag || targetTag || '新版本'}…`,
      error: null,
      targetTag: input.state?.tag || targetTag,
      targetReady: true,
    }
  }

  // 本进程确认过「包已就绪 / 正在安装」时以内存态为准：用户刚点过下载或安装，
  // 不该被上一次失败的历史记录盖回失败态（面板重启后内存态归零，那时才读 state.json）。
  if (
    input.runtimePhase === 'installing'
    || input.runtimePhase === 'recreating'
    || input.runtimePhase === 'downloaded'
  ) {
    return {
      phase: input.runtimePhase,
      message: input.runtimeMessage,
      error: input.runtimeError,
      targetTag: input.runtimeTargetTag ?? targetTag,
      targetReady: input.runtimeTargetReady,
    }
  }

  // 本进程刚失败的下载：原因必须留在界面上（否则用户一刷新就再也看不到为什么失败）
  if (input.runtimePhase === 'failed' && input.runtimeError) {
    return {
      phase: 'failed',
      message: null,
      error: input.runtimeError,
      targetTag: input.runtimeTargetTag ?? targetTag,
      targetReady: prefetchedReady,
    }
  }

  if (stateStale) {
    const minutes = stateAgeMs === null ? null : Math.round(stateAgeMs / 60_000)
    return {
      phase: 'failed',
      message: null,
      error: [
        `上一次更新到 ${input.state?.tag || targetTag || '新版本'} 在服务器上中断了`,
        minutes === null ? '' : `（最后更新于 ${minutes} 分钟前）`,
        '。请重新发起更新；若反复失败，到服务器上查看更新日志与面板服务状态。',
      ].join(''),
      targetTag: input.state?.tag || targetTag,
      targetReady: prefetchedReady,
    }
  }

  // 上一次失败只有在「还有更新可装」时才继续提示：用户可能已经用命令行升到了最新，
  // 那时再挂一条红色失败只会让人以为系统坏了。
  if (input.state?.phase === 'failed' && (input.updateAvailable || prefetchedReady)) {
    return {
      phase: 'failed',
      message: null,
      error: input.state.message
        || `更新到 ${input.state.tag || targetTag || '新版本'} 失败，详情见服务器上的更新日志。`,
      targetTag: input.state.tag || targetTag,
      targetReady: prefetchedReady,
    }
  }

  if (input.updateAvailable && prefetchedReady) {
    return {
      phase: 'downloaded',
      message: '更新包已下载完成，点击「立即安装」完成更新。',
      error: null,
      targetTag,
      targetReady: true,
    }
  }

  return { phase: 'idle', message: null, error: null, targetTag, targetReady: false }
}

/** 下载 Native Release 包（断点续传 + 进度 + 官方 `.sha256` 校验，复用离线包那套） */
export async function downloadNativeReleaseArchive(input: {
  dir: string
  githubRepo: string
  releaseTag: string
  githubProxy?: string
  onProgress?: (progress: OfflineArchiveProgress) => void
}): Promise<OfflineArchiveDownloadResult> {
  const { archiveDir, archiveFile } = resolveNativeUpdatePaths(input.dir, input.releaseTag)
  return downloadReleaseArchive({
    urls: buildNativeReleaseUrls({
      githubRepo: input.githubRepo,
      releaseTag: input.releaseTag,
      githubProxy: input.githubProxy,
    }),
    destinationDir: archiveDir,
    fileName: path.basename(archiveFile),
    subjectLabel: '更新包',
    diskHint: '安装新版本还需要 releases 目录同等大小的空间',
    onProgress: input.onProgress,
  })
}
