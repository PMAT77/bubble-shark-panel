import { withInstanceContentActivity } from '../../shared/instance-content/operation'
import type { FastifyInstance } from 'fastify'
import type { HostMemoryPressureFailure } from '../../infra/container/host-resource-guard'
import fs from 'node:fs'
import path from 'node:path'
import { resolveDockerStatus } from '../../infra/docker'
import { createDockerClient } from '../../infra/docker-connect'
import {
  assessHostMemoryForHeavyOperation,
  ensureSteamcmdImage,
  formatGameDstImageError,
  getContainerRuntime,
  isSteamcmdImagePresent,
  pullGameDstImage,
} from '../../infra/container'
import { resolveInstanceContainerBind } from '../../infra/container/steamcmd-install-bind'
import { buildCavesContainerName, buildMasterContainerName } from '../../infra/container/naming'
import type { ContainerInspect, ContainerRef, ContainerRuntime, ShardContainerSpec } from '../../infra/container/types'
import { DST_APP_ID, DST_CLUSTER_NAME, DST_CONF_DIR, DST_STORAGE_DIR } from '../../infra/game-adapter/dst/constants'
import {
  buildDstStartBlockedMessage,
  diagnoseDstInstallReadiness,
} from '../../infra/game-adapter/dst/install-readiness'
import { findHostUdpPortConflicts, validateShardPortsForStart } from '../../infra/game-adapter/dst/port-conflict'
import {
  buildDstCavesShardContainerSpec,
  buildDstMasterShardContainerSpec,
} from '../../infra/game-adapter/dst/runtime-spec'
import { ensureDstCavesShardConfig } from '../../infra/game-adapter/dst/cluster-config'
import { syncInstanceModFilesFromDb } from '../mod/mod-file-sync-service'
import { collectReservedDstPortsOnNode } from './dst-port-service'
import { LOCAL_NODE_ID } from '../../shared/dst/local-dst-instance'
import {
  ensureDockerShardInterconnectConfig,
  ensureNativeShardInterconnectConfig,
} from '../../infra/game-adapter/dst/shard-network-config'
import {
  isCavesShardConfigured,
  readClusterShardEnabledFromInstall,
  readCavesServerIniFields,
  readMasterServerIniFields,
} from '../../infra/game-adapter/dst/shard-service'
import { getServerContainerConfig } from '../../shared/config/container'
import { isSteamcmdRuntimeReady, resolveRuntimeStatus } from '../../infra/runtime'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import { getGameInstanceById, listInstanceMods, updateGameInstanceRuntime } from '../../shared/db/index'
import { resolveClusterPaths } from '../../infra/game-adapter/dst/cluster-service'
import { resolveShardRoot } from '../../infra/game-adapter/dst/shard-layout'
import { parseClusterIni } from '../../infra/game-adapter/dst/cluster-ini'
import { describeSystemdExitReason, readHostMemorySnapshot, resolveShardMemoryCapMb } from '../../infra/container/exit-reason'

/** 主世界分片互联端口（cluster.ini [SHARD] master_port）；读不到时退回 DST 默认值 */
const DEFAULT_DST_MASTER_PORT = 10888
/**
 * 等待主世界就绪的默认上限（秒）。
 *
 * 给足余量：36 个 Mod 的分片在 2 核机上冷启动要两分多钟，多 Mod 存档更久。
 * 上限拉长没有副作用——主世界的分片端口一打开就立即返回，等待只用来卡住洞穴；
 * 真正有害的是「等不够就放洞穴进来」，那会让两个加载峰值重新叠在一起。
 */
const DEFAULT_SHARD_READY_WAIT_SEC = 900

/** 就绪等待上限；可用 GSH_SHARD_READY_WAIT_SEC 覆盖（小机器上 Mod 特别多时可再调大） */
export function resolveShardReadyWaitSec(): number {
  const raw = process.env.GSH_SHARD_READY_WAIT_SEC?.trim()
  const parsed = raw ? Number(raw) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_SHARD_READY_WAIT_SEC
}

/**
 * 分片端口早于这个秒数就被占用时，不认为世界已经加载完。
 *
 * DST 的分片网络是在世界初始化过程中建立的，正常情况下端口出现得比较晚；一旦它出现得过早，
 * 说明「端口被占用」只能证明进程起来了，不能证明能接客。60 秒足够区分这两种情形：
 * 多 Mod 大存档的冷启动远不止 60 秒。
 *
 * 这里只约束**端口这条辅助判据**：主判据是 `hasMasterReadyMarker()`，命中即放行，与端口无关。
 */
const SHARD_PORT_EARLY_BIND_GRACE_SEC = 60

/**
 * 主世界「世界已经加载完、分片端口已经在监听」的标记。
 *
 * 每一条都注明是在**哪一份真实日志**里核实的。教训：上一轮拿洞穴的日志去否定
 * `Starting master server`，而它只出现在主世界的日志里——两个分片打印的行并不相同，
 * 用错日志会得出相反的结论。三个标记都取自用户服务器上的真实输出：
 *
 *   主世界日志（server_log.txt / 面板采集的 console-logs）：
 *     [00:01:22]: About to start a shard with these settings:
 *     [00:01:22]:   ShardRole: MASTER
 *     [00:01:22]: [Shard] Starting master server
 *     [00:01:22]: [Shard] Shard server started on port: 10888   ← 最精确：端口已在监听
 *   洞穴日志（同一台机器、完整成功的一次运行）：
 *     [00:02:49]: Reconstructing topology
 *     [00:02:50]: About to start a shard with these settings:
 */
const MASTER_READY_MARKER = /Shard server started on port|About to start a shard with these settings|Reconstructing topology/

/** DST 执行某个 Mod 的 modmain 时会打印的行（取自用户服务器上的真实输出） */
const MOD_LOADED_LINE_PATTERN = /Mod:\s*workshop-(\d+)/g
/** 本轮分片的 Mod 索引流程已完成；只有它出现后才能对「加载了几个 Mod」下结论 */
const MOD_INDEX_DONE_MARKER = /ModIndex: Load sequence finished successfully/
/** Mod 数量级：一行的 Mod 下 2 MiB 足以覆盖整个索引段 */
const MOD_LOAD_REPORT_MAX_BYTES = 2 * 1024 * 1024
/** 小机器上 36 个 Mod 的索引实测约 40 秒完成，留足余量 */
const MOD_LOAD_REPORT_TIMEOUT_MS = 5 * 60 * 1000
const MOD_LOAD_REPORT_POLL_INTERVAL_MS = 3000

/** 读文件尾部若干字节；日志可达数百 KB，只关心结尾 */
function readTailText(filePath: string, maxBytes = 64 * 1024): string {
  let descriptor: number | undefined
  try {
    const size = fs.statSync(filePath).size
    if (size === 0) {
      return ''
    }
    const start = size > maxBytes ? size - maxBytes : 0
    descriptor = fs.openSync(filePath, 'r')
    const buffer = Buffer.allocUnsafe(size - start)
    const read = fs.readSync(descriptor, buffer, 0, buffer.length, start)
    return buffer.subarray(0, read).toString('utf8')
  }
  catch {
    return ''
  }
  finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor)
    }
  }
}

/**
 * 主世界分片是否已经打印过世界就绪的标记。
 *
 * 两个来源都看，因为它们的可靠性不同：
 *   1. 面板采集到控制台的行——依赖 systemd 的 stdout 采集链路，链路断了就永远匹配不到；
 *   2. **DST 自己写的 `server_log.txt`**——面板从实例目录直接读，不依赖任何采集链路，
 *      而且该文件每次分片启动都会被重写，天然只包含「本轮」的日志，不会匹配到上一轮的旧标记。
 */
export function hasMasterReadyMarker(instanceId: string, installPath?: string): boolean {
  try {
    const hit = instanceConsoleLogStore
      .listLogs(instanceId)
      .some(line => line.stream === 'stdout' && (line.shard == null || line.shard === 'master') && MASTER_READY_MARKER.test(line.text))
    if (hit) {
      return true
    }
  }
  catch {
    // 控制台存储不可用不影响下面的文件判定
  }
  if (!installPath) {
    return false
  }
  const logPath = path.join(resolveShardRoot(installPath, 'master'), 'server_log.txt')
  return MASTER_READY_MARKER.test(readTailText(logPath))
}

/**
 * 从分片日志文本里读出「本轮 Mod 索引是否完成」与「实际被加载的 Mod ID」。
 *
 * 抽成纯函数是为了能用真实日志片段固化口径：DST 只在实际执行某个 Mod 的 modmain 时
 * 打印 `Mod: workshop-<id> ... Registering prefabs`，因此这个集合就是游戏真正加载的 Mod。
 */
export function summarizeLoadedMods(logText: string): { indexFinished: boolean, workshopIds: string[] } {
  const workshopIds = new Set<string>()
  for (const match of logText.matchAll(MOD_LOADED_LINE_PATTERN)) {
    workshopIds.add(match[1] as string)
  }
  return {
    indexFinished: MOD_INDEX_DONE_MARKER.test(logText),
    workshopIds: [...workshopIds],
  }
}

/**
 * 启动后在控制台回答「游戏这次到底加载了几个 Mod」。
 *
 * 面板此前只能回答「内容已就绪」，而「内容在盘上」与「游戏真的加载」是两件事：
 * 落位目录与游戏读取目录不一致时，面板显示全部就绪、游戏里一个 Mod 都没有，且没有任何报错
 * （`-skip_update_server_mods` 还禁止了游戏自己补下载）。
 *
 * 读 DST 自己写的 `server_log.txt`：该文件每次分片启动都会被重写，天然只含本轮。
 * 只有看到本轮的 Mod 索引完成标记才下结论，否则宁可不说话——把「还没加载到那一步」
 * 说成「一个都没加载」会误导排查方向。
 */
async function reportLoadedModsAfterStart(input: { instanceId: string, installPath: string }): Promise<void> {
  const logPath = path.join(resolveShardRoot(input.installPath, 'master'), 'server_log.txt')
  const deadline = Date.now() + MOD_LOAD_REPORT_TIMEOUT_MS
  let loadedIds: Set<string> | null = null
  // NaN 保证首轮必读：文件还不存在时 size 也是 -1，用 -1 初始化会一直跳过读取
  let lastSize = Number.NaN
  while (Date.now() < deadline) {
    let size = -1
    try {
      size = fs.statSync(logPath).size
    }
    catch {
      // 日志还没写出来：下一轮再看
    }
    // 日志没长就不重复读：索引完成后它基本不再变化，避免一直空转读盘
    if (size !== lastSize) {
      lastSize = size
      const summary = summarizeLoadedMods(readTailText(logPath, MOD_LOAD_REPORT_MAX_BYTES))
      if (summary.indexFinished) {
        loadedIds = new Set(summary.workshopIds)
        break
      }
    }
    await new Promise(resolve => setTimeout(resolve, MOD_LOAD_REPORT_POLL_INTERVAL_MS))
  }
  if (!loadedIds) {
    return
  }

  const expected = (await listInstanceMods(input.instanceId))
    .filter(mod => mod.enabled && mod.installStatus === 'ready')
    .map(mod => mod.workshopId)

  if (loadedIds.size === 0) {
    if (expected.length === 0) {
      return
    }
    instanceConsoleLogStore.appendSystem(
      input.instanceId,
      `游戏本次没有加载任何 Mod（面板启用 ${expected.length} 个）：请到「模组管理」核对这些 Mod 的状态，`
      + '并确认实例目录下 mods/workshop-<ID> 有内容',
      'master',
    )
    return
  }

  instanceConsoleLogStore.appendSystem(
    input.instanceId,
    `本次启动已加载 ${loadedIds.size} 个 Mod（面板启用 ${expected.length} 个）`,
    'master',
  )
  const missing = expected.filter(workshopId => !loadedIds.has(workshopId))
  if (missing.length > 0) {
    instanceConsoleLogStore.appendSystem(
      input.instanceId,
      `以下已启用的 Mod 未被游戏加载：${missing.slice(0, 10).join('、')}`
      + `${missing.length > 10 ? ` 等 ${missing.length} 个` : ''}`,
      'master',
    )
  }
}

export type ConsoleCommandShard = 'master' | 'caves'

const CONSOLE_SHARD_LABEL: Record<ConsoleCommandShard, string> = {
  master: '地上',
  caves: '洞穴',
}

const logFollowAbortControllers = new Map<string, AbortController>()

function logFollowKey(instanceId: string, shard: ConsoleCommandShard) {
  return `${instanceId}:${shard}`
}

export async function ensureContainerRuntimeReady(): Promise<{ ok: boolean, message?: string }> {
  const { runtimeMode } = getServerContainerConfig()
  if (runtimeMode === 'native') {
    if ((await resolveRuntimeStatus()) !== 'running') {
      return { ok: false, message: '无法连接 systemd 用户服务管理器，请确认 gsh 用户已启用 linger 且 user bus 正常' }
    }
    if (!(await isSteamcmdRuntimeReady())) {
      return { ok: false, message: 'SteamCMD 未就绪，请检查 GSH_NATIVE_STEAMCMD_PATH 或重新运行 Native 安装器' }
    }
    return { ok: true }
  }
  if ((await resolveDockerStatus()) !== 'running') {
    return { ok: false, message: '无法连接 Docker，请确认面板已挂载 docker.sock（或 Windows 下 Docker Desktop 已启动）' }
  }
  const pullResult = await ensureSteamcmdImage()
  if (!pullResult.ok) {
    return {
      ok: false,
      message: `SteamCMD 镜像未就绪：${pullResult.error}。请检查网络或 panel.env 中的 GSH_STEAMCMD_IMAGE`,
    }
  }
  return { ok: true }
}

export function resolveDefaultInstanceInstallPath(instanceId: string): string {
  const { instancesRoot } = getServerContainerConfig()
  return path.join(instancesRoot, instanceId)
}

export async function resolveInstanceContainerRef(instanceId: string): Promise<ContainerRef | undefined> {
  const instance = await getGameInstanceById(instanceId)
  if (instance?.containerId) {
    return {
      id: instance.containerId,
      name: buildMasterContainerName(instanceId),
    }
  }
  const runtime = getContainerRuntime()
  return runtime.findByName(buildMasterContainerName(instanceId))
}

export async function resolveCavesContainerRef(instanceId: string): Promise<ContainerRef | undefined> {
  const runtime = getContainerRuntime()
  return runtime.findByName(buildCavesContainerName(instanceId))
}

export async function isInstanceContainerRunning(
  instanceId: string,
  shard: ConsoleCommandShard = 'master',
): Promise<boolean> {
  const ref = await resolveConsoleCommandContainerRef(instanceId, shard)
  if (!ref) {
    return false
  }
  const runtime = getContainerRuntime()
  const inspect = await runtime.inspect(ref)
  return inspect.running
}

export interface InstanceShardRuntimeProbe {
  /** 该分片是否存在运行时单元（从未创建或已被移除时为 false） */
  unitExists: boolean
  /** 运行时快照；运行时不可达时为 null（此时不能据此判定已停止） */
  snapshot: ContainerInspect | null
}

/**
 * 分片运行时快照：状态对账用它区分「运行中 / 崩溃后等待重启 / 真的停了 / 问不到」。
 * 把这四种情况压成一个布尔值正是实例状态在运行与停止之间来回跳的根源。
 */
export async function inspectInstanceShardRuntime(
  instanceId: string,
  shard: ConsoleCommandShard = 'master',
): Promise<InstanceShardRuntimeProbe> {
  const ref = await resolveConsoleCommandContainerRef(instanceId, shard)
  if (!ref) {
    return { unitExists: false, snapshot: null }
  }
  try {
    return { unitExists: true, snapshot: await getContainerRuntime().inspect(ref) }
  }
  catch {
    return { unitExists: true, snapshot: null }
  }
}

function stopLogFollow(instanceId: string) {
  for (const [key, controller] of logFollowAbortControllers.entries()) {
    if (key === instanceId || key.startsWith(`${instanceId}:`)) {
      controller.abort()
      logFollowAbortControllers.delete(key)
    }
  }
}

function stopShardLogFollow(instanceId: string, shard: ConsoleCommandShard) {
  const key = logFollowKey(instanceId, shard)
  logFollowAbortControllers.get(key)?.abort()
  logFollowAbortControllers.delete(key)
}

/**
 * 分片日志来源已改为 systemd 直接追加到面板可读的文件（见 NativeSystemdRuntime），
 * 不再依赖 journald 权限。这里保留一条兜底：万一文件读不到，至少告诉用户去哪找
 * 游戏自己写的 server_log.txt。
 */
const JOURNAL_PERMISSION_HINT = /No journal files were opened|insufficient permissions/i

/** 实例目录内游戏自己写的启动日志（面板读不到分片日志时，用户据此排查崩溃原因） */
function resolveShardGameLogHint(shard: ConsoleCommandShard): string {
  const shardDir = shard === 'caves' ? 'Caves' : 'Master'
  return `${DST_STORAGE_DIR}/${DST_CONF_DIR}/${DST_CLUSTER_NAME}/${shardDir}/server_log.txt`
}

function startShardLogFollow(instanceId: string, ref: ContainerRef, shard: ConsoleCommandShard) {
  stopShardLogFollow(instanceId, shard)
  const key = logFollowKey(instanceId, shard)
  const controller = new AbortController()
  logFollowAbortControllers.set(key, controller)
  const label = CONSOLE_SHARD_LABEL[shard]
  instanceConsoleLogStore.appendSystem(instanceId, `已连接${label}运行时，开始采集控制台输出`, shard)
  void (async () => {
    const runtime = getContainerRuntime()
    let permissionHintShown = false
    try {
      for await (const line of runtime.logs(ref, { follow: true, tail: 100, signal: controller.signal })) {
        if (controller.signal.aborted) {
          break
        }
        if (JOURNAL_PERMISSION_HINT.test(line.text)) {
          // 万一还是读到了系统日志的报错（不是游戏输出）：换成一句能指导排查的说明，
          // 否则控制台看起来像「服务器什么都没说」，把真正的崩溃原因藏起来。
          if (!permissionHintShown) {
            permissionHintShown = true
            instanceConsoleLogStore.appendSystem(
              instanceId,
              `${label}分片日志暂时取不到。请查看实例目录的 ${resolveShardGameLogHint(shard)}，或服务器上的 systemctl --user status 输出`,
              shard,
            )
          }
          continue
        }
        instanceConsoleLogStore.appendDockerLine(instanceId, line.text, shard)
      }
    }
    catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error)
        instanceConsoleLogStore.appendSystem(instanceId, `${label}日志流中断: ${message}`, shard)
      }
    }
  })()
}

export function startContainerLogFollow(instanceId: string, ref: ContainerRef) {
  startShardLogFollow(instanceId, ref, 'master')
}

async function readRecentContainerLogLines(runtime: ContainerRuntime, ref: ContainerRef, tail = 20): Promise<string[]> {
  const lines: string[] = []
  try {
    for await (const line of runtime.logs(ref, { tail })) {
      lines.push(line.text)
    }
  }
  catch {
    return []
  }
  return lines.slice(-tail)
}

async function readRecentContainerLogs(runtime: ContainerRuntime, ref: ContainerRef, tail = 20): Promise<string> {
  return readRecentContainerLogLines(runtime, ref, tail).then(rows => rows.join('\n').trim())
}

/** 读取指定分片容器最近日志行（不依赖面板内存日志流，面板重启后仍可用） */
export async function readRecentInstanceContainerLogLines(
  instanceId: string,
  tail = 80,
  shard: ConsoleCommandShard = 'master',
): Promise<string[]> {
  const ref = await resolveConsoleCommandContainerRef(instanceId, shard)
  if (!ref) {
    return []
  }
  const runtime = getContainerRuntime()
  const inspect = await runtime.inspect(ref)
  if (!inspect.running) {
    return []
  }
  return readRecentContainerLogLines(runtime, ref, tail)
}

/** 面板重启后，为仍在运行的实例重新挂载 Docker 日志流 */
export async function ensureInstanceContainerLogFollow(instanceId: string): Promise<void> {
  const runtime = getContainerRuntime()
  const masterRef = await resolveInstanceContainerRef(instanceId)
  if (masterRef) {
    const inspect = await runtime.inspect(masterRef)
    if (inspect.running && !logFollowAbortControllers.has(logFollowKey(instanceId, 'master'))) {
      startShardLogFollow(instanceId, masterRef, 'master')
    }
  }
  const cavesRef = await resolveCavesContainerRef(instanceId)
  if (cavesRef) {
    const inspect = await runtime.inspect(cavesRef)
    if (inspect.running && !logFollowAbortControllers.has(logFollowKey(instanceId, 'caves'))) {
      startShardLogFollow(instanceId, cavesRef, 'caves')
    }
  }
}

/**
 * 镜像类错误只在 Docker 模式翻译：Native 模式没有镜像，它的报错原文里带着
 * unit 诊断（systemd 的原始抱怨、unit 文件内容），必须原样透出，不能被镜像文案顶掉。
 */
function formatShardStartError(raw: string, gameDstImage: string, runtimeMode: 'docker' | 'native'): string {
  return runtimeMode === 'docker' ? formatGameDstImageError(raw, gameDstImage) : raw
}

async function startSingleShardContainer(
  runtime: ContainerRuntime,
  spec: ShardContainerSpec,
  gameDstImage: string,
  runtimeMode: 'docker' | 'native',
): Promise<{ ok: true, ref: ContainerRef, inspect: ContainerInspect } | { ok: false, message: string }> {
  let ref: ContainerRef
  try {
    ref = await runtime.createShardContainer(spec)
  }
  catch (error) {
    const raw = error instanceof Error ? error.message : '创建分片运行时失败'
    return { ok: false, message: formatShardStartError(raw, gameDstImage, runtimeMode) }
  }
  try {
    await runtime.start(ref)
  }
  catch (error) {
    await runtime.remove(ref)
    const raw = error instanceof Error ? error.message : '分片运行时启动失败'
    return { ok: false, message: formatShardStartError(raw, gameDstImage, runtimeMode) }
  }
  const inspect = await runtime.inspect(ref)
  if (!inspect.running) {
    const logTail = await readRecentContainerLogs(runtime, ref)
    await runtime.remove(ref)
    const hint = logTail || '分片启动后立即退出，请检查安装目录与分片配置'
    return { ok: false, message: hint }
  }
  return { ok: true, ref, inspect }
}

function describeLifecycleError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 停止并移除分片。
 *
 * 两步都是 best-effort：失败不能阻断停机流程，否则一个卡住的容器会让实例永远停在
 * 「停止中」。但失败不再完全静默 —— 停止失败意味着分片可能仍在运行，而面板会继续
 * 往下走到「已停止」，控制台必须留下痕迹，否则「界面说停了、进程其实还在跑」不会
 * 被任何人看到（日志目录不可写这类成因另由环境自检覆盖）。
 */
async function stopAndRemoveShard(runtime: ContainerRuntime, ref: ContainerRef | undefined, instanceId: string) {
  if (!ref) {
    return
  }
  try {
    await runtime.stop(ref, 15)
  }
  catch (error) {
    instanceConsoleLogStore.appendSystem(instanceId, `停止分片失败：${describeLifecycleError(error)}，面板将继续尝试清理`)
  }
  try {
    await runtime.remove(ref)
  }
  catch (error) {
    instanceConsoleLogStore.appendSystem(instanceId, `移除分片失败：${describeLifecycleError(error)}`)
  }
}

/** 启用中且内容已就绪的 Mod 数量：内存估算的直接输入 */
export async function countEnabledInstanceMods(instanceId: string): Promise<number> {
  try {
    const mods = await listInstanceMods(instanceId)
    return mods.filter(mod => mod.enabled && mod.installStatus === 'ready').length
  }
  catch {
    return 0
  }
}

/**
 * DB 记为已停止时，运行时探测到的快照是否真的代表「实例还在正常服务」。
 *
 * 正在被 systemd 自动拉起（`Restart=on-failure` 的 auto-restart 窗口）或已经重启过，
 * 属于崩溃循环而不是「容器还在跑」。若此时把状态翻回运行中，就会抹掉上一趟对账刚写入
 * 的崩溃告警——线上实测同一个请求里两趟对账互相覆盖，服主永远看不到「主世界已停止」。
 */
export function isHealthyRuntimeForResurrect(snapshot: ContainerInspect | null): boolean {
  if (!snapshot?.running) {
    return false
  }
  return !snapshot.restarting && (snapshot.restarts ?? 0) === 0
}

/** 主世界分片互联端口（cluster.ini [SHARD] master_port）；读不到时退回 DST 默认值 */
export function readClusterMasterPort(installPath: string): number {  try {
    const { clusterIniPath } = resolveClusterPaths(installPath)
    const { fields } = parseClusterIni(fs.readFileSync(clusterIniPath, 'utf8'))
    return Number.isInteger(fields.masterPort) && fields.masterPort > 0 && fields.masterPort <= 65535
      ? fields.masterPort
      : DEFAULT_DST_MASTER_PORT
  }
  catch {
    return DEFAULT_DST_MASTER_PORT
  }
}

/**
 * 主世界的分片互联端口是否已被占用。
 *
 * **必须是 UDP**：DST 的端口全是 UDP（仓库里既有的端口冲突探测 `findHostUdpPortConflicts`
 * 用的就是 `dgram.createSocket('udp4')`）。此处原先用 TCP `net.connect` 探测，
 * TCP 连一个只监听 UDP 的端口会被内核直接回 RST，探测永远返回 false——
 * 线上表现为「房间已经能进、控制台却一路报主世界仍在加载」，直到 900 秒超时兜底才启动洞穴。
 *
 * **但 UDP 也不是充分条件**：bind 探测的是「调用方所在网络命名空间」里的占用情况，而
 * `master_port` 是 `cluster.ini [SHARD]` 的分片互联端口，只在实例容器网络内监听、从不发布到
 * 宿主机，面板容器里探测必然为空。因此它只是把握度较高的辅助判据，主判据必须是
 * `hasMasterReadyMarker()`（见 `waitForMasterShardReady`）。
 */
export function isShardPortBound(port: number): Promise<boolean> {
  return findHostUdpPortConflicts([port]).then(conflicts => conflicts.includes(port))
}

/**
 * 等待主世界就绪的结果。
 *
 * 为什么要等：两个分片同时加载会把整机内存吃穿（见 `waitForMasterShardReady`）。
 */
export type MasterReadyOutcome =
  /** 已确认世界加载完成（就绪标记，或同命名空间下已过宽限期的端口），洞穴可以起来了 */
  | { kind: 'ready' }
  /** 等满上限仍未就绪：照常启动洞穴，但要在控制台说明原因 */
  | { kind: 'timed-out' }
  /** 主世界进程已不在（退出或被运行时放弃拉起） */
  | { kind: 'stopped', detail: string }
  /** 主世界在崩溃循环里反复重启，永远不会就绪 */
  | { kind: 'restart-loop', detail: string }

export type MasterProbeVerdict = 'healthy' | 'unknown' | 'stopped' | 'restart-loop'

/**
 * 等待期间对主世界分片快照的判决。
 *
 * `unknown`（问不到运行时）必须继续等：user bus 抖动一次就判崩溃会误伤正常启动。
 * `restart-loop` 必须判失败：`Restart=on-failure` 的重启窗口里单元仍算「在运行」，
 * 只按这一条判断就会白等满上限、然后照样把洞穴拉起来占内存。
 *
 * 重启计数一律与**本次启动时的基线**比较，而不是与 0 比较：systemd 是否在显式启动时
 * 把 `NRestarts` 清零是实现细节，赌错一次就会让每次正常启动都被误判成崩溃循环而中止。
 * 基线比较只关心「我们启动它之后有没有崩过」，与清零语义无关。
 */
export function classifyMasterProbe(
  snapshot: ContainerInspect | null,
  baselineRestarts = 0,
): MasterProbeVerdict {
  if (!snapshot) {
    return 'unknown'
  }
  if (!snapshot.running) {
    return 'stopped'
  }
  if (snapshot.restarting) {
    return 'restart-loop'
  }
  if ((snapshot.restarts ?? 0) > baselineRestarts) {
    return 'restart-loop'
  }
  return 'healthy'
}

/**
 * 等主世界就绪后再拉起洞穴。
 *
 * 两个分片同时加载时，各自都要把整套 Mod 与世界读一遍：2 核 4G 机器上两个峰值叠在
 * 一起会触发整机 OOM（线上实测主世界 anon-rss 已达 2.0 GiB 时被内核杀掉），而洞穴
 * 此时连不上主世界，只会反复报 `Connection to master failed`，最后两个分片都白跑。
 * 主世界先跑完，洞穴再加载时页缓存已经热了，整机峰值只剩原来的一个多一点。
 *
 * 就绪判据以 DST 自己写的 `server_log.txt` 标记为主，端口探测只作辅助——理由见函数内注释。
 *
 * 崩溃循环必须当成失败：`Restart=on-failure` 的重启窗口里单元仍算「在运行」，
 * 若只按这一条判断就会白等满上限、然后照样把洞穴拉起来占内存。
 */
export async function waitForMasterShardReady(
  app: FastifyInstance,
  instanceId: string,
  masterRef: ContainerRef,
  masterPort: number,
  installPath: string,
  waitSec = resolveShardReadyWaitSec(),
  baselineRestarts = 0,
): Promise<MasterReadyOutcome> {
  const runtime = getContainerRuntime()
  const startAt = Date.now()
  const deadline = startAt + waitSec * 1000
  let lastHeartbeat = startAt
  let portBoundAt: number | null = null
  while (Date.now() < deadline) {
    // 首选判据：DST 自己写的世界就绪标记（`server_log.txt`，或面板采集到的同一行）。
    //
    // 它不依赖任何网络命名空间，因此容器模式与 native 模式都成立。端口探测**不能**当主判据：
    // `master_port` 是 `cluster.ini [SHARD]` 的分片互联端口，只在实例容器的网络里监听、
    // 从不发布到宿主机（发布的是 `server.ini` 的三个游戏端口），面板容器里 bind 它必然成功，
    // 于是「端口已被占用」永远为 false——只按端口判断会让 Docker 模式一路等到上限，
    // 表现为「房间能进、控制台却一直报『尚未监听到分片端口』」。
    if (hasMasterReadyMarker(instanceId, installPath)) {
      instanceConsoleLogStore.appendSystem(
        instanceId,
        `主世界已加载完成（启动后 ${Math.round((Date.now() - startAt) / 1000)} 秒），就绪后启动洞穴分片`,
        'master',
      )
      return { kind: 'ready' }
    }
    // 端口探测降级为辅助判据：只在「面板与游戏处于同一网络命名空间」（native 同机进程）
    // 时才探测得到，用于兜住就绪标记读不到（实例目录权限异常等）的情形。
    if (await isShardPortBound(masterPort)) {
      if (portBoundAt === null) {
        portBoundAt = Date.now()
        // 把「端口是什么时候起来的」写进控制台：它同时是给用户看的进度，
        // 也是判断「端口是否早于世界加载就绑定」的唯一现场证据。
        instanceConsoleLogStore.appendSystem(
          instanceId,
          `主世界已监听分片端口 ${masterPort}（启动后 ${Math.round((portBoundAt - startAt) / 1000)} 秒），就绪后启动洞穴分片`,
          'master',
        )
      }
      // 端口绑得太早说明 DST 可能在进程启动早期就占住了它，此时还不能断定世界已加载完；
      // 晚绑定（超过宽限）则说明它随世界初始化一起起来。
      const portElapsedSec = (portBoundAt - startAt) / 1000
      if (portElapsedSec > SHARD_PORT_EARLY_BIND_GRACE_SEC) {
        return { kind: 'ready' }
      }
    }
    let snapshot: ContainerInspect | null = null
    try {
      snapshot = await runtime.inspect(masterRef)
    }
    catch {
      // 问不到运行时（user bus 抖动等）：当作还活着，继续等，别误判成崩溃
      snapshot = null
    }
    const verdict = classifyMasterProbe(snapshot, baselineRestarts)
    if (verdict === 'stopped') {
      const reason = describeSystemdExitReason(snapshot?.exitResult, resolveShardMemoryCapMb(), readHostMemorySnapshot())
      return {
        kind: 'stopped',
        detail: reason ? `主世界分片在加载途中退出：${reason}` : '主世界分片在加载途中退出',
      }
    }
    if (verdict === 'restart-loop') {
      const reason = describeSystemdExitReason(snapshot?.exitResult, resolveShardMemoryCapMb(), readHostMemorySnapshot())
      return {
        kind: 'restart-loop',
        detail: `主世界分片反复重启（已重启 ${snapshot?.restarts ?? 0} 次）${reason ? `，最近一次退出：${reason}` : ''}`,
      }
    }
    const now = Date.now()
    if (now - lastHeartbeat >= 30_000) {
      lastHeartbeat = now
      const waited = Math.round((now - startAt) / 1000)
      instanceConsoleLogStore.appendSystem(
        instanceId,
        portBoundAt === null
          ? `主世界仍在加载（已等待 ${waited} 秒，尚未看到世界就绪标记），就绪后再启动洞穴分片`
          : `主世界已监听端口但仍在加载世界（已等待 ${waited} 秒），就绪后再启动洞穴分片`,
        'master',
      )
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  app.log.warn({ instanceId, masterPort, waitSec }, '等待主世界就绪超时，仍继续启动洞穴分片')
  return { kind: 'timed-out' }
}

async function startInstanceContainerUnlocked(
  app: FastifyInstance,
  input: {
    instanceId: string
    gameCode: string
    installPath: string
    instanceName: string
    gamePort: number | null
  },
): Promise<
  | { ok: true, ref: ContainerRef, displayCommand: string }
  | { ok: false, message: string, hostMemoryPressure?: HostMemoryPressureFailure }
> {
  if (input.gameCode.trim() !== DST_APP_ID) {
    return { ok: false, message: '当前仅支持饥荒（343050）实例启动' }
  }
  const { gameDstImage, instancesRoot, runtimeMode } = getServerContainerConfig()
  let containerGameRoot = input.installPath
  let hostBinds: string[] = []
  let bindMode = 'native'
  if (runtimeMode === 'docker') {
    const docker = createDockerClient()
    const bindPlan = await resolveInstanceContainerBind(docker, input.installPath, instancesRoot)
    if (bindPlan.error) {
      return { ok: false, message: bindPlan.error }
    }
    containerGameRoot = bindPlan.containerGameRoot
    hostBinds = bindPlan.hostBinds
    bindMode = bindPlan.mode
  }
  const clusterInput = {
    instanceName: input.instanceName,
    gamePort: input.gamePort,
  }
  const masterSpec = buildDstMasterShardContainerSpec({
    instanceId: input.instanceId,
    hostInstallPath: input.installPath,
    image: gameDstImage,
    containerGameRoot,
    clusterInput,
  })
  if (!masterSpec) {
    const readiness = diagnoseDstInstallReadiness(input.installPath)
    const steamcmdImageReady = runtimeMode === 'docker'
      ? await isSteamcmdImagePresent()
      : await isSteamcmdRuntimeReady()
    return {
      ok: false,
      message: buildDstStartBlockedMessage(readiness, steamcmdImageReady, {
        instanceStatus: 'error',
      }),
    }
  }
  const shardEnabled = readClusterShardEnabledFromInstall(input.installPath)
  if (shardEnabled && !isCavesShardConfigured(input.installPath)) {
    ensureDstCavesShardConfig(input.installPath, input.gamePort ?? undefined)
    try {
      // 洞穴目录新建后需重写 Caves modoverrides（与启动前全量 sync 条件不同）
      await syncInstanceModFilesFromDb(input.instanceId, input.installPath)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '同步 Mod 配置失败'
      return { ok: false, message }
    }
  }
  const cavesConfigured = shardEnabled && isCavesShardConfigured(input.installPath)
  // 内存守卫放在这里而不是函数开头：只有知道「要不要起洞穴、挂了多少 Mod」，
  // 估算才对得上实际峰值。线上就是因为固定按单分片 512 MiB 放行，
  // 36 个 Mod 的双分片启动在加载途中被内核 OOM 杀掉。
  const memoryPressure = assessHostMemoryForHeavyOperation('dst-container-start', {
    shardCount: cavesConfigured ? 2 : 1,
    modCount: await countEnabledInstanceMods(input.instanceId),
  })
  if (!memoryPressure.ok) {
    return { ok: false, message: memoryPressure.detail, hostMemoryPressure: memoryPressure }
  }
  if (shardEnabled && !cavesConfigured) {
    return { ok: false, message: '已开启洞穴分片但无法准备洞穴配置，请检查安装目录权限后重试' }
  }
  const masterFields = readMasterServerIniFields(input.installPath, input.gamePort)
  const cavesFields = shardEnabled && cavesConfigured
    ? readCavesServerIniFields(input.installPath)
    : null
  const reservedPorts = await collectReservedDstPortsOnNode(LOCAL_NODE_ID, input.instanceId, {
    onlyRunning: true,
  })
  const portError = await validateShardPortsForStart(masterFields, cavesFields, {
    reservedPorts,
  })
  if (portError) {
    return { ok: false, message: portError }
  }
  let cavesSpec: ShardContainerSpec | undefined
  if (shardEnabled && cavesConfigured) {
    cavesSpec = buildDstCavesShardContainerSpec({
      instanceId: input.instanceId,
      hostInstallPath: input.installPath,
      image: gameDstImage,
      containerGameRoot,
      clusterInput,
    })
    if (!cavesSpec) {
      return { ok: false, message: '无法构建洞穴分片运行规格，请检查游戏文件是否完整' }
    }
  }
  if (runtimeMode === 'docker') {
    app.log.info({ gameDstImage, bindMode, hostBinds, shardEnabled }, '确保 DST 运行镜像可用')
    const imagePull = await pullGameDstImage()
    if (!imagePull.ok) {
      return { ok: false, message: imagePull.error }
    }
    masterSpec.hostBinds = hostBinds
    if (cavesSpec) {
      cavesSpec.hostBinds = hostBinds
    }
  }
  else {
    app.log.info({ runtimeMode, installPath: input.installPath, shardEnabled }, '使用 Native systemd 运行 DST')
  }
  const runtime = getContainerRuntime()
  let shardNetworkName: string | undefined
  if (shardEnabled && cavesConfigured) {
    const interconnectChanged = runtimeMode === 'docker'
      ? ensureDockerShardInterconnectConfig(input.installPath, input.instanceId)
      : ensureNativeShardInterconnectConfig(input.installPath)
    if (interconnectChanged) {
      instanceConsoleLogStore.appendSystem(
        input.instanceId,
        '已自动配置地上与洞穴互联地址',
      )
    }
    shardNetworkName = await runtime.ensureShardNetwork(input.instanceId)
    masterSpec.networkName = shardNetworkName
    if (cavesSpec) {
      cavesSpec.networkName = shardNetworkName
    }
  }
  const masterStart = await startSingleShardContainer(runtime, masterSpec, gameDstImage, runtimeMode)
  if (!masterStart.ok) {
    return { ok: false, message: `主世界：${masterStart.message}` }
  }
  const ref = masterStart.ref
  const displayCommand = masterSpec.cmd.join(' ')
  app.log.info({
    instanceId: input.instanceId,
    containerId: ref.id,
    name: ref.name,
    command: displayCommand,
    shardEnabled,
  }, '实例运行时已启动')
  startShardLogFollow(input.instanceId, ref, 'master')
  // 不阻塞启动：等本轮的 Mod 索引完成后，把「实际加载了几个 Mod」写进控制台
  void reportLoadedModsAfterStart({
    instanceId: input.instanceId,
    installPath: input.installPath,
  }).catch((error) => {
    app.log.warn({ instanceId: input.instanceId, err: error }, 'Mod 加载情况上报失败')
  })

  if (cavesSpec) {
    instanceConsoleLogStore.appendSystem(
      input.instanceId,
      '主世界分片已启动，正在加载 Mod 与世界；就绪后再启动洞穴分片',
      'master',
    )
    // 不能在 HTTP 请求里等主世界就绪：36 个 Mod 在 2 核机上要加载两分多钟，
    // 而前端 axios 的超时是 60 秒——同步等待会让面板先报「启动失败」，
    // 实际却已经起来了。这里放到后台，主世界本身就已经算「实例在运行」。
    void startCavesAfterMasterReady(app, {
      instanceId: input.instanceId,
      installPath: input.installPath,
      masterRef: ref,
      cavesSpec,
      generation: bumpCavesStartGeneration(input.instanceId),
      baselineRestarts: masterStart.inspect.restarts ?? 0,
      startCaves: async () => {
        const result = await startSingleShardContainer(runtime, cavesSpec, gameDstImage, runtimeMode)
        return result.ok ? { ok: true as const, ref: result.ref } : { ok: false as const, message: `洞穴：${result.message}` }
      },
    })
  }
  return { ok: true, ref, displayCommand }
}

/**
 * 每次启动/停止自增的代号，用来作废还在等待中的洞穴启动任务。
 *
 * 后台任务要等主世界就绪（可能好几分钟）才动手。这段时间里用户完全可能又点了一次
 * 停止或重新启动：旧任务若不感知，就会在实例已经被停机之后把洞穴拉起来、还会顺手挂上
 * 一个再也停不掉的日志跟随。代号变了就静默退出，并把已经起来的残留分片收掉。
 */
const cavesStartGenerations = new Map<string, number>()

export function bumpCavesStartGeneration(instanceId: string): number {
  const next = (cavesStartGenerations.get(instanceId) ?? 0) + 1
  cavesStartGenerations.set(instanceId, next)
  return next
}

export function isCurrentCavesStartGeneration(instanceId: string, generation: number): boolean {
  return (cavesStartGenerations.get(instanceId) ?? 0) === generation
}

/**
 * 后台等主世界就绪再拉起洞穴，并在失败时如实上报。
 *
 * 两个分片同时加载会把整机内存吃穿（线上实测主世界 anon-rss 2.0 GiB 时被内核 OOM 杀掉），
 * 而主世界崩了以后洞穴连不上它、只会反复重连失败，白占内存。所以主世界没站住就中止，
 * 并把状态写成 error——用 whereStatus 守卫，避免用户在等待期间主动停止实例后又被改回错误态。
 */
async function startCavesAfterMasterReady(
  app: FastifyInstance,
  input: {
    instanceId: string
    installPath: string
    masterRef: ContainerRef
    cavesSpec: ShardContainerSpec
    /** 本次启动的代号；与当前代号不一致说明用户已重新启动或停止，任务应作废 */
    generation: number
    /** 本次启动主世界时的重启计数基线：只关心「我们启动它之后有没有崩过」 */
    baselineRestarts: number
    startCaves: () => Promise<{ ok: true, ref: ContainerRef } | { ok: false, message: string }>
  },
): Promise<void> {
  const runtime = getContainerRuntime()
  const stale = () => !isCurrentCavesStartGeneration(input.instanceId, input.generation)
  const failStart = async (message: string) => {
    if (stale()) {
      return
    }
    await stopAndRemoveShard(runtime, input.masterRef, input.instanceId)
    instanceConsoleLogStore.appendSystem(input.instanceId, message, 'caves')
    await updateGameInstanceRuntime(input.instanceId, {
      status: 'error',
      containerId: null,
      runtimePid: null,
      runtimeStartedAt: null,
      lastError: message,
      lastErrorPhase: 'runtime',
      whereStatus: 'running',
    })
    app.log.error({ instanceId: input.instanceId }, message)
  }
  try {
    const readiness = await waitForMasterShardReady(
      app,
      input.instanceId,
      input.masterRef,
      readClusterMasterPort(input.installPath),
      input.installPath,
      resolveShardReadyWaitSec(),
      input.baselineRestarts,
    )
    if (stale()) {
      app.log.info({ instanceId: input.instanceId }, '实例已被重新启动或停止，放弃本次洞穴启动')
      return
    }
    if (readiness.kind === 'stopped' || readiness.kind === 'restart-loop') {
      await failStart(
        `${readiness.detail}，已中止启动洞穴分片。内存不足时可先执行 gsh setup-swap 增加 swap，'
        + '或在「世界设置 → 模组」减少订阅的 Mod；完整日志见控制台。`,
      )
      return
    }
    if (readiness.kind === 'timed-out') {
      instanceConsoleLogStore.appendSystem(
        input.instanceId,
        `等待主世界就绪超时（${resolveShardReadyWaitSec()} 秒），仍继续启动洞穴分片；若洞穴反复重连失败请检查主世界日志`,
        'caves',
      )
    }
    const cavesStart = await input.startCaves()
    if (stale()) {
      // 洞穴是在代号变更之后才起来的：立刻收掉，别留下没人管的残留分片与日志跟随
      if (cavesStart.ok) {
        await stopAndRemoveShard(runtime, cavesStart.ref, input.instanceId)
      }
      return
    }
    if (!cavesStart.ok) {
      await failStart(cavesStart.message)
      return
    }
    instanceConsoleLogStore.appendSystem(input.instanceId, '洞穴分片已启动', 'caves')
    startShardLogFollow(input.instanceId, cavesStart.ref, 'caves')
  }
  catch (error) {
    app.log.error({ instanceId: input.instanceId, err: error }, '等待主世界就绪或启动洞穴分片时发生异常')
  }
}

export async function stopInstanceContainer(instanceId: string): Promise<void> {
  // 先作废还在等待中的洞穴启动任务：否则它会在实例停机之后把洞穴拉起来
  bumpCavesStartGeneration(instanceId)
  stopLogFollow(instanceId)
  const instance = await getGameInstanceById(instanceId)
  const runtime = getContainerRuntime()
  const cavesRef = await resolveCavesContainerRef(instanceId)
  const masterRef = await resolveInstanceContainerRef(instanceId)
  if (cavesRef) {
    instanceConsoleLogStore.appendSystem(instanceId, '正在停止并移除洞穴分片以释放内存')
  }
  await stopAndRemoveShard(runtime, cavesRef, instanceId)
  if (masterRef) {
    instanceConsoleLogStore.appendSystem(instanceId, '正在停止并移除主世界分片以释放内存')
  }
  await stopAndRemoveShard(runtime, masterRef, instanceId)
  if (masterRef) {
    instanceConsoleLogStore.appendSystem(instanceId, '实例运行时已删除')
  }
  await runtime.removeShardNetwork(instanceId)
  if (!masterRef && !cavesRef) {
    if (instance?.status === 'running') {
      await updateGameInstanceRuntime(instanceId, {
        status: 'stopped',
        containerId: null,
        runtimePid: null,
        runtimeStartedAt: null,
        lastError: null,
      })
    }
    return
  }
  await updateGameInstanceRuntime(instanceId, {
    status: 'stopped',
    containerId: null,
    runtimePid: null,
    runtimeStartedAt: null,
    lastError: null,
  })
}

export async function removeInstanceContainer(instanceId: string): Promise<void> {
  // 删除实例同样要作废等待中的洞穴启动任务，否则它会把分片又拉回来
  bumpCavesStartGeneration(instanceId)
  stopLogFollow(instanceId)
  const runtime = getContainerRuntime()
  const cavesRef = await resolveCavesContainerRef(instanceId)
  await stopAndRemoveShard(runtime, cavesRef, instanceId)
  const masterRef = await resolveInstanceContainerRef(instanceId)
  if (masterRef) {
    await stopAndRemoveShard(runtime, masterRef, instanceId)
    instanceConsoleLogStore.appendSystem(instanceId, '实例运行时已删除')
  }
  await runtime.removeShardNetwork(instanceId)
}

export async function isCavesContainerRunning(instanceId: string): Promise<boolean> {
  const ref = await resolveCavesContainerRef(instanceId)
  if (!ref) {
    return false
  }
  const runtime = getContainerRuntime()
  const inspect = await runtime.inspect(ref)
  return inspect.running
}

async function resolveConsoleCommandContainerRef(
  instanceId: string,
  shard: ConsoleCommandShard,
): Promise<ContainerRef | undefined> {
  if (shard === 'caves') {
    return resolveCavesContainerRef(instanceId)
  }
  return resolveInstanceContainerRef(instanceId)
}

export async function sendInstanceContainerCommand(
  instanceId: string,
  command: string,
  shard: ConsoleCommandShard = 'master',
  options?: { silent?: boolean },
): Promise<{ ok: boolean, message?: string }> {
  const trimmed = command.trim()
  if (!trimmed) {
    return { ok: false, message: '命令不能为空' }
  }
  const ref = await resolveConsoleCommandContainerRef(instanceId, shard)
  if (!ref) {
    return {
      ok: false,
      message: shard === 'caves' ? '洞穴分片未运行，无法发送命令' : '实例未运行，无法发送命令',
    }
  }
  const runtime = getContainerRuntime()
  const inspect = await runtime.inspect(ref)
  if (!inspect.running) {
    return {
      ok: false,
      message: shard === 'caves' ? '洞穴分片未运行，无法发送命令' : '实例未运行，无法发送命令',
    }
  }
  const result = await runtime.execStdin(ref, trimmed)
  // 面板自己的周期查询（在线人数 / 名单）传 silent：它们不是用户发的命令，
  // 不该每隔几十秒就往控制台里塞一条命令行回显
  if (!options?.silent) {
    instanceConsoleLogStore.appendSystem(instanceId, `> ${trimmed}`, shard)
  }
  if (result.exitCode !== 0) {
    return { ok: false, message: result.output || '命令发送失败' }
  }
  return { ok: true }
}

export async function startInstanceContainer(...args: Parameters<typeof startInstanceContainerUnlocked>): ReturnType<typeof startInstanceContainerUnlocked> {
  try { return await withInstanceContentActivity(args[1].instanceId, () => startInstanceContainerUnlocked(...args)) }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : '启动失败' } }
}
