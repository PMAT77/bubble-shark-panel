import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  DST_APP_ID,
  DST_CLUSTER_NAME,
  DST_CONF_DIR,
  DST_STORAGE_DIR,
} from '../../infra/game-adapter/dst/constants'
import {
  parseClusterIni,
} from '../../infra/game-adapter/dst/cluster-ini'
import {
  resolveClusterPaths,
  resolveInstanceInstallPath,
} from '../../infra/game-adapter/dst/cluster-service'
import {
  readClusterTokenFile,
  validateClusterToken,
  writeClusterTokenFile,
} from '../../infra/game-adapter/dst/cluster-token'
import {
  markPanelMasterWorldSaved,
  markPanelRoomSaved,
} from '../../infra/game-adapter/dst/panel-config-meta'
import {
  parseModOverridesEntries,
} from '../../infra/game-adapter/dst/mod-config'
import { isDstWorkshopModPresent } from '../../infra/game-adapter/dst/mod-download'
import { isWorldSeedModId } from '../../infra/game-adapter/dst/world-seed'
import {
  buildServerIni,
  defaultCavesServerIniFields,
  defaultMasterServerIniFields,
  parseServerIni,
} from '../../infra/game-adapter/dst/server-ini'
import { findDstServerBinary } from '../../infra/game-adapter/dst/cluster-config'
import { normalizeDirectoryPath } from '../../infra/filesystem-browse'
import { replaceDirectory } from '../../infra/backup/archive'
import { resolveSteamcmdContainerUidGid } from '../../infra/container/steamcmd-container-user'
import { getServerContainerConfig } from '../../shared/config/container'
import { LOCAL_NODE_ID } from '../../shared/dst/local-dst-instance'
import {
  deleteInstanceModsByInstanceId,
  getGameInstanceById,
  updateGameInstanceRuntime,
  upsertInstanceMod,
} from '../../shared/db/index'
import type { DbGameInstance } from '../../shared/db/index'
import { createInstanceBackupUnlocked } from './backup-service'
import { InstanceArchiveBusyError, withInstanceArchiveOperationLock } from './archive-lock'
import { isModDownloadAutoStartEnabled, startModDownloadQueue } from '../mod/mod-download-service'
import { syncInstanceModFilesFromDb } from '../mod/mod-file-sync-service'
import { MISSING_MOD_CONTENT_ERROR } from '../mod/mod-readiness-service'

/** 目录大小扫描上限：超出后停止累计（session 小文件可达数十万，防 probe/导入卡死） */
const SIZE_SCAN_MAX_FILES = 50_000
/** probe 最多返回的集群候选数 */
const PROBE_MAX_CANDIDATES = 10
/** 集群候选向下递归搜索的层数（覆盖用户 zip 包装目录与备份包 klei-storage 布局） */
const PROBE_MAX_SEARCH_DEPTH = 3

// ---------------------------------------------------------------------------
// 源目录探测（probe）
// ---------------------------------------------------------------------------

interface ClusterCandidate {
  dirName: string
  clusterPath: string
}

/** 目录含 cluster.ini 即视为 DST 集群存档（导入与上传识别共用） */
export function isClusterDirectory(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, 'cluster.ini'))
}

/** 在目录下寻找形如 Cluster_N 的子集群目录（官方存档固定命名，大小写不敏感匹配） */
function findClusterSubdirectories(parentDir: string): ClusterCandidate[] {
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true })
  }
  catch {
    return []
  }
  return entries
    .filter(entry => entry.isDirectory() && /^cluster_\d+$/i.test(entry.name))
    .map(entry => ({
      dirName: entry.name,
      clusterPath: path.join(parentDir, entry.name),
    }))
    .filter(candidate => isClusterDirectory(candidate.clusterPath))
}

/**
 * 识别源目录形态：集群目录本身 / Klei 根 / DoNotStarveTogether 目录 /
 * 客户端 DoNotStarveTogether/<userid>/Cluster_N / 面板备份包 klei-storage 布局。
 * 向下有界递归搜索，兼容用户本地压缩包的任意包装层级。
 */
function findClusterCandidates(sourcePath: string): ClusterCandidate[] {
  if (isClusterDirectory(sourcePath)) {
    return [{ dirName: path.basename(sourcePath), clusterPath: sourcePath }]
  }
  // 选中 DoNotStarveTogether 时优先在其下找
  const confDir = path.join(sourcePath, DST_CONF_DIR)
  if (fs.existsSync(confDir) && fs.statSync(confDir).isDirectory()) {
    const inConfDir = findClusterSubdirectories(confDir)
    if (inConfDir.length > 0) {
      return inConfDir
    }
  }
  const found: ClusterCandidate[] = []
  const visit = (dir: string, depth: number): boolean => {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    }
    catch {
      return false
    }
    for (const entry of entries) {
      if (found.length >= PROBE_MAX_CANDIDATES) {
        return true
      }
      if (!entry.isDirectory()) {
        continue
      }
      const childDir = path.join(dir, entry.name)
      if (/^cluster_\d+$/i.test(entry.name)) {
        if (isClusterDirectory(childDir)) {
          found.push({ dirName: entry.name, clusterPath: childDir })
        }
        continue
      }
      if (depth < PROBE_MAX_SEARCH_DEPTH && visit(childDir, depth + 1)) {
        return true
      }
    }
    return false
  }
  visit(sourcePath, 1)
  return found.slice(0, PROBE_MAX_CANDIDATES)
}

/** shard 的 save 目录非空即视为世界已生成 */
function isSaveDirectoryGenerated(shardDir: string | undefined): boolean {
  if (!shardDir) {
    return false
  }
  const saveDir = path.join(shardDir, 'save')
  if (!fs.existsSync(saveDir)) {
    return false
  }
  try {
    return fs.readdirSync(saveDir).length > 0
  }
  catch {
    return false
  }
}

interface DirectorySizeScan {
  bytes: number
  fileCount: number
  incomplete: boolean
}

/** 带文件数上限的目录大小统计（符号链接不跟随） */
function scanDirectorySize(dirPath: string): DirectorySizeScan {
  const scan: DirectorySizeScan = { bytes: 0, fileCount: 0, incomplete: false }
  const visit = (current: string) => {
    if (scan.incomplete) {
      return
    }
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    }
    catch {
      return
    }
    for (const entry of entries) {
      if (scan.incomplete) {
        return
      }
      const entryPath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        continue
      }
      if (entry.isDirectory()) {
        visit(entryPath)
        continue
      }
      if (entry.isFile()) {
        scan.fileCount += 1
        if (scan.fileCount > SIZE_SCAN_MAX_FILES) {
          scan.incomplete = true
          return
        }
        try {
          scan.bytes += fs.statSync(entryPath).size
        }
        catch {
          // 文件在扫描期间被删除：跳过
        }
      }
    }
  }
  visit(dirPath)
  return scan
}

function resolveShardDir(clusterPath: string, shard: 'Master' | 'Caves'): string | undefined {
  const shardDir = path.join(clusterPath, shard)
  return fs.existsSync(shardDir) ? shardDir : undefined
}

/**
 * 解析源 modoverrides.lua 的 Mod 条目：Master 优先，Master 缺失时退回 Caves。
 *
 * 面板内置的世界种子 Mod 会随源档一起出现在 modoverrides.lua 里，但它不是玩家订阅的
 * 创意工坊 Mod：留着会被当成一条"未下载"的订阅排进下载队列并永远失败，因此在源头滤掉。
 */
function readSourceModEntries(clusterPath: string) {
  const readEntries = (shard: 'Master' | 'Caves') =>
    parseModOverridesEntries(path.join(clusterPath, shard, 'modoverrides.lua'))
      .filter(entry => !isWorldSeedModId(entry.workshopId))
  const masterEntries = readEntries('Master')
  if (masterEntries.length > 0) {
    return masterEntries
  }
  return readEntries('Caves')
}

function buildCandidateDetail(candidate: ClusterCandidate): { detail: {
  dirName: string
  clusterPath: string
  clusterName: string | null
  shards: Array<'master' | 'caves'>
  worldGenerated: boolean
  modCount: number
  hasTokenFile: boolean
  sizeBytes: number
  sizeIncomplete: boolean
  warnings: string[]
} } {
  const warnings: string[] = []
  const masterDir = resolveShardDir(candidate.clusterPath, 'Master')
  const cavesDir = resolveShardDir(candidate.clusterPath, 'Caves')
  if (!masterDir) {
    warnings.push('未找到 Master 分片目录，导入后主世界无法启动')
  }

  let clusterName: string | null = null
  let shardEnabled = false
  const clusterIniPath = path.join(candidate.clusterPath, 'cluster.ini')
  try {
    const content = fs.readFileSync(clusterIniPath, 'utf8')
    const parsed = parseClusterIni(content)
    clusterName = parsed.fields.clusterName
    shardEnabled = parsed.fields.shardEnabled
  }
  catch {
    warnings.push('房间配置文件解析失败，未能识别房间名与包含的世界')
  }
  if (shardEnabled && !cavesDir) {
    warnings.push('源档包含洞穴但没找到洞穴目录，导入后请在「房间设置」重新保存以启用洞穴')
  }

  const extraShardDirs = fs
    .readdirSync(candidate.clusterPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'Master' && entry.name !== 'Caves')
    .map(entry => entry.name)
  if (extraShardDirs.length > 0) {
    warnings.push(`存在自定义分片目录（${extraShardDirs.slice(0, 3).join('、')}${extraShardDirs.length > 3 ? ' 等' : ''}），面板仅启动 Master/Caves，这些目录会原样复制`)
  }

  const sizeScan = scanDirectorySize(candidate.clusterPath)

  return {
    detail: {
      dirName: candidate.dirName,
      clusterPath: candidate.clusterPath,
      clusterName,
      shards: [
        ...(masterDir ? ['master' as const] : []),
        ...(cavesDir ? ['caves' as const] : []),
      ],
      worldGenerated: isSaveDirectoryGenerated(masterDir) || isSaveDirectoryGenerated(cavesDir),
      modCount: readSourceModEntries(candidate.clusterPath).length,
      hasTokenFile: fs.existsSync(path.join(candidate.clusterPath, 'cluster_token.txt')),
      sizeBytes: sizeScan.bytes,
      sizeIncomplete: sizeScan.incomplete,
      warnings,
    },
  }
}

export interface ProbeSaveImportResult {
  ok: boolean
  message?: string
  result?: {
    sourcePath: string
    candidates: ReturnType<typeof buildCandidateDetail>['detail'][]
    warnings: string[]
  }
}

/** 探测本地目录可识别出的 DST 集群存档候选（只读操作，不做导入） */
export function probeSaveImportSource(rawSourcePath: string): ProbeSaveImportResult {
  const sourcePath = normalizeDirectoryPath(rawSourcePath)
  if (!fs.existsSync(sourcePath)) {
    return { ok: false, message: '源目录不存在' }
  }
  if (!fs.statSync(sourcePath).isDirectory()) {
    return { ok: false, message: '源路径不是目录' }
  }
  const candidates = findClusterCandidates(sourcePath).slice(0, PROBE_MAX_CANDIDATES)
  if (candidates.length === 0) {
    return { ok: false, message: '未在该目录下找到存档（缺少房间配置文件或房间目录）' }
  }
  return {
    ok: true,
    result: {
      sourcePath,
      candidates: candidates.map(buildCandidateDetail).map(item => item.detail),
      warnings: [],
    },
  }
}

// ---------------------------------------------------------------------------
// 导入执行
// ---------------------------------------------------------------------------

export interface ImportSaveToInstanceOptions {
  app?: FastifyInstance
  instanceId: string
  /** 上传解压后识别出的集群目录绝对路径 */
  sourceClusterPath: string
  /** 可选：源档展示名（如上传的压缩包文件名），用于安全备份备注；缺省用目录名 */
  sourceLabel?: string
  /** 可选：导入时写入的 Klei 集群令牌 */
  clusterToken?: string
  createdBy?: string
}

export interface ImportSaveToInstanceResult {
  ok: boolean
  message?: string
  result?: {
    importedShards: Array<'master' | 'caves'>
    modCount: number
    missingWorkshopContent: string[]
    tokenSource: 'provided' | 'existing' | 'source' | 'none'
    safetyBackupId?: string
    gamePortSynced?: boolean
    warnings: string[]
  }
}

/** child 是否位于 dir 内部（跨盘符/不同根时必然为否，兼容上传源在系统临时目录的场景） */
function isInsideDir(childPath: string, dirPath: string): boolean {
  const rel = path.relative(path.resolve(dirPath), path.resolve(childPath))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 源路径不得与目标实例目录互相包含（防自我复制嵌套爆炸） */
export function validateSourceTargetDisjoint(sourcePath: string, installPath: string, clusterRoot: string): string | undefined {
  if (isInsideDir(installPath, sourcePath)) {
    return '源目录不能包含实例安装目录'
  }
  if (isInsideDir(sourcePath, clusterRoot)) {
    return '源目录不能位于实例存档目录内部'
  }
  return undefined
}

/**
 * 递归对齐存档目录属主（Docker 模式 best-effort）：
 * 导入的文件属主是面板进程用户，与安装链路 chown 到 SteamCMD 容器用户的约定对齐，
 * 防游戏镜像未来收紧权限或自定义 GSH_STEAMCMD_RUN_USER 后出现只读写入失败。
 */
function alignClusterOwnership(clusterRoot: string): void {
  if (getServerContainerConfig().runtimeMode !== 'docker') {
    return
  }
  const { uid, gid } = resolveSteamcmdContainerUidGid()
  const chownBestEffort = (targetPath: string, isDirectory: boolean) => {
    try {
      fs.chownSync(targetPath, uid, gid)
    }
    catch {
      // best-effort（Windows 为 no-op；宿主环境失败不阻断导入）
    }
    if (isDirectory) {
      try {
        fs.chmodSync(targetPath, 0o775)
      }
      catch {
        // best-effort
      }
    }
  }
  const visit = (current: string) => {
    chownBestEffort(current, true)
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    }
    catch {
      return
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        visit(entryPath)
      }
      else if (entry.isFile()) {
        chownBestEffort(entryPath, false)
      }
    }
  }
  visit(clusterRoot)
}

/** 读取实例当前磁盘 server.ini 的端口体系作为导入重写目标；无磁盘配置时从 DB gamePort 推导 */
function resolveTargetShardPorts(instance: DbGameInstance, installPath: string): {
  master: ReturnType<typeof defaultMasterServerIniFields>
  caves: ReturnType<typeof defaultCavesServerIniFields>
} {
  const masterIniPath = path.join(installPath, DST_STORAGE_DIR, DST_CONF_DIR, DST_CLUSTER_NAME, 'Master', 'server.ini')
  let masterFields = defaultMasterServerIniFields(instance.gamePort ?? undefined)
  if (fs.existsSync(masterIniPath)) {
    masterFields = parseServerIni(fs.readFileSync(masterIniPath, 'utf8'), 'master').fields
  }
  const cavesIniPath = path.join(installPath, DST_STORAGE_DIR, DST_CONF_DIR, DST_CLUSTER_NAME, 'Caves', 'server.ini')
  let cavesFields = defaultCavesServerIniFields(masterFields)
  if (fs.existsSync(cavesIniPath)) {
    cavesFields = parseServerIni(fs.readFileSync(cavesIniPath, 'utf8'), 'caves').fields
  }
  return { master: masterFields, caves: cavesFields }
}

/** 用目标端口体系重写 staging 中的 shard server.ini（保留 shardName，修正 is_master） */
function rewriteStagedServerIni(
  stagedCluster: string,
  shard: 'Master' | 'Caves',
  target: ReturnType<typeof defaultMasterServerIniFields>,
): boolean {
  const iniPath = path.join(stagedCluster, shard, 'server.ini')
  if (!fs.existsSync(iniPath)) {
    return false
  }
  const stagedFields = parseServerIni(fs.readFileSync(iniPath, 'utf8'), shard === 'Master' ? 'master' : 'caves')
  const next = {
    isMaster: shard === 'Master',
    shardName: stagedFields.fields.shardName,
    serverPort: target.serverPort,
    steamAuthPort: target.steamAuthPort,
    steamMasterPort: target.steamMasterPort,
  }
  fs.mkdirSync(path.dirname(iniPath), { recursive: true })
  fs.writeFileSync(iniPath, buildServerIni(next), 'utf8')
  return true
}

/** 清扫同实例历史导入/恢复残留 staging（进程崩溃遗留） */
function cleanStaleStagingDirectories(installPath: string): void {
  try {
    for (const entry of fs.readdirSync(installPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue
      }
      if (entry.name.startsWith('.import-staging-') || entry.name.startsWith('.restore-staging-')) {
        fs.rmSync(path.join(installPath, entry.name), { recursive: true, force: true, maxRetries: 1 })
      }
    }
  }
  catch {
    // best-effort
  }
}

/** 将实例现有 Mod 记录替换为源档 modoverrides 的内容，并探测缺失的 workshop 内容 */
async function syncImportedModsToDb(options: {
  app?: FastifyInstance
  instanceId: string
  installPath: string
  clusterRoot: string
}): Promise<{ modCount: number, missingWorkshopContent: string[], modSyncOk: boolean }> {
  const { app, instanceId, installPath, clusterRoot } = options
  const entries = readSourceModEntries(clusterRoot)
  const missingWorkshopContent: string[] = []
  try {
    await deleteInstanceModsByInstanceId(instanceId)
    for (const [index, entry] of entries.entries()) {
      // 源档 modoverrides.lua 只有创意工坊 ID，内容在不在本机必须按磁盘判定：
      // 把没下载的记成「已就绪」会让面板显示全部开启、游戏里却只加载出有文件的那几个。
      const contentPresent = isDstWorkshopModPresent(installPath, entry.workshopId)
      if (!contentPresent) {
        missingWorkshopContent.push(entry.workshopId)
      }
      await upsertInstanceMod({
        instanceId,
        workshopId: entry.workshopId,
        name: `workshop-${entry.workshopId}`,
        enabled: entry.enabled,
        loadOrder: index,
        installStatus: contentPresent ? 'ready' : 'pending',
        installError: contentPresent ? null : MISSING_MOD_CONTENT_ERROR,
        config: JSON.stringify(entry.configurationOptions),
      })
    }
    return { modCount: entries.length, missingWorkshopContent, modSyncOk: true }
  }
  catch (error) {
    app?.log.warn({ instanceId, error }, '导入后 Mod 入库失败，请到 Mod 页面手动核对')
    return { modCount: entries.length, missingWorkshopContent, modSyncOk: false }
  }
}

/** 将外部 Klei 集群存档导入为目标实例的世界存档（要求实例已停止且已完成游戏安装） */
export async function importSaveToInstance(options: ImportSaveToInstanceOptions): Promise<ImportSaveToInstanceResult> {
  const { app, instanceId, createdBy } = options
  try {
    return await withInstanceArchiveOperationLock(instanceId, async () => {
      return await importSaveToInstanceLocked(options)
    })
  }
  catch (error) {
    if (error instanceof InstanceArchiveBusyError) {
      return { ok: false, message: error.message }
    }
    const message = error instanceof Error ? error.message : '存档导入失败'
    app?.log.error({ instanceId, createdBy, error: message }, '存档导入失败')
    return { ok: false, message: `存档导入失败: ${message}` }
  }
}

async function importSaveToInstanceLocked(options: ImportSaveToInstanceOptions): Promise<ImportSaveToInstanceResult> {
  const { app, instanceId, createdBy } = options

  const instance = await getGameInstanceById(instanceId)
  if (!instance) {
    return { ok: false, message: '实例不存在' }
  }
  if (instance.nodeId !== LOCAL_NODE_ID) {
    return { ok: false, message: '当前仅支持本地节点实例导入存档' }
  }
  if (instance.gameCode !== DST_APP_ID) {
    return { ok: false, message: '当前仅支持 DST 实例导入存档' }
  }
  if (instance.status === 'running') {
    return { ok: false, message: '实例运行中，必须先停止实例再导入存档' }
  }

  const installPath = resolveInstanceInstallPath(instance)
  if (!fs.existsSync(installPath)) {
    return { ok: false, message: '实例安装目录不存在，请先完成游戏安装' }
  }
  if (!findDstServerBinary(installPath)) {
    return { ok: false, message: '实例尚未完成游戏安装，请先安装游戏再导入存档' }
  }

  const sourcePath = normalizeDirectoryPath(options.sourceClusterPath)
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
    return { ok: false, message: '源存档目录不存在' }
  }
  if (!isClusterDirectory(sourcePath)) {
    return { ok: false, message: '这不是有效的存档目录（缺少房间配置文件）' }
  }
  const { clusterRoot } = resolveClusterPaths(installPath)
  const disjointError = validateSourceTargetDisjoint(sourcePath, installPath, clusterRoot)
  if (disjointError) {
    return { ok: false, message: disjointError }
  }

  const stagedMasterDir = resolveShardDir(sourcePath, 'Master')
  const stagedCavesDir = resolveShardDir(sourcePath, 'Caves')
  if (!stagedMasterDir && !stagedCavesDir) {
    return { ok: false, message: '源存档缺少 Master/Caves 分片目录，无法导入' }
  }

  const warnings: string[] = []
  if (!stagedMasterDir) {
    warnings.push('源存档没有 Master 分片，导入后主世界无法启动')
  }

  // 导入前清扫历史残留 staging，避免堆积
  cleanStaleStagingDirectories(installPath)

  // 导入前安全备份：实例已有存档才创建
  let safetyBackupId: string | undefined
  if (fs.existsSync(path.join(installPath, DST_STORAGE_DIR))) {
    const safety = await createInstanceBackupUnlocked({
      app,
      instanceId,
      kind: 'pre_import',
      note: `导入 ${options.sourceLabel?.trim() || path.basename(sourcePath)} 前的自动安全备份`,
      createdBy: createdBy ?? '',
      saveBeforeArchive: false,
    })
    if (!safety.ok || !safety.backup) {
      return { ok: false, message: safety.message ?? '导入前安全备份失败，已中止导入' }
    }
    safetyBackupId = safety.backup.id
  }

  // staging 采用完整 klei-storage 布局，复用面板 meta 写入函数
  const stagingRoot = path.join(installPath, `.import-staging-${Date.now()}`)
  const stagedCluster = path.join(stagingRoot, DST_STORAGE_DIR, DST_CONF_DIR, DST_CLUSTER_NAME)
  try {
    fs.mkdirSync(stagedCluster, { recursive: true })
    fs.cpSync(sourcePath, stagedCluster, { recursive: true })
  }
  catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
    const message = error instanceof Error ? error.message : '复制源存档失败'
    app?.log.error({ instanceId, sourcePath, error: message }, '存档导入复制失败')
    return { ok: false, message: `复制源存档失败: ${message}` }
  }

  try {
    // 端口重写：世界数据与端口无关，统一为实例当前端口体系，避免与其它实例冲突
    const targetPorts = resolveTargetShardPorts(instance, installPath)
    const importedShards: Array<'master' | 'caves'> = []
    if (stagedMasterDir && rewriteStagedServerIni(stagedCluster, 'Master', targetPorts.master)) {
      importedShards.push('master')
    }
    if (stagedCavesDir && rewriteStagedServerIni(stagedCluster, 'Caves', targetPorts.caves)) {
      importedShards.push('caves')
    }

    // DB 端口对齐：磁盘目标端口与 DB 记录不一致时同步 DB
    let gamePortSynced = false
    if (instance.gamePort !== null && targetPorts.master.serverPort !== instance.gamePort) {
      await updateGameInstanceRuntime(instanceId, { gamePort: targetPorts.master.serverPort })
      gamePortSynced = true
      warnings.push(`实例游戏端口已按本机配置重写为 ${targetPorts.master.serverPort}（原档端口 ${instance.gamePort}）`)
    }

    // 集群令牌：表单提供 > 实例已有 > 源档自带
    const tokenPath = path.join(stagedCluster, 'cluster_token.txt')
    let tokenSource: 'provided' | 'existing' | 'source' | 'none' = 'none'
    const providedToken = options.clusterToken?.trim()
    if (providedToken) {
      const tokenError = validateClusterToken(providedToken)
      if (tokenError) {
        return { ok: false, message: tokenError }
      }
      writeClusterTokenFile(tokenPath, providedToken)
      tokenSource = 'provided'
    }
    else {
      const existingToken = readClusterTokenFile(path.join(clusterRoot, 'cluster_token.txt'))
      if (existingToken && !validateClusterToken(existingToken)) {
        writeClusterTokenFile(tokenPath, existingToken)
        tokenSource = 'existing'
      }
      else if (fs.existsSync(tokenPath)) {
        tokenSource = 'source'
      }
    }
    if (tokenSource === 'none') {
      warnings.push('未配置 Klei 集群令牌，公网游玩需在「房间设置」粘贴后才能被搜到')
    }

    // 面板元数据：房间与主世界均来自源档，标记后面板状态与导入档对齐
    markPanelRoomSaved(stagingRoot)
    markPanelMasterWorldSaved(stagingRoot)

    // 原子替换：staged Cluster_1 换入正式存档位（全新实例时目标父目录尚不存在，先补齐）
    fs.mkdirSync(path.dirname(clusterRoot), { recursive: true })
    replaceDirectory(clusterRoot, stagedCluster)
    fs.rmSync(stagingRoot, { recursive: true, force: true })

    alignClusterOwnership(clusterRoot)

    const modSync = await syncImportedModsToDb({
      app,
      instanceId,
      installPath,
      // 此时 stagedCluster 已改名就位为 clusterRoot，Mod 解析读正式存档
      clusterRoot,
    })
    if (!modSync.modSyncOk) {
      warnings.push('Mod 列表写入面板数据库失败，请到 Mod 页面手动核对，否则下次同步可能丢失导入 Mod 配置')
    }
    if (modSync.missingWorkshopContent.length > 0) {
      warnings.push(`${modSync.missingWorkshopContent.length} 个 Mod 的创意工坊内容尚未下载：面板不自动下载，请在「世界设置 → 模组」点「开始下载」按批补齐`)
    }
    if (modSync.modSyncOk) {
      try {
        // 只把真正就绪的 Mod 写进 modoverrides.lua：否则 DST 每次启动都会自行补下载，
        // legacy 包在容器网络下常超时失败，玩家进游戏只看到一部分 Mod。
        await syncInstanceModFilesFromDb(instanceId, installPath)
        // 缺失内容默认不在导入过程里开跑：几十个 Mod 一起下会长时间占住 SteamCMD 串行锁，
        // 由用户在 Mod 页显式点「开始下载」，队列再逐批处理（GSH_MOD_DOWNLOAD_AUTO_START=1 恢复自动）
        if (isModDownloadAutoStartEnabled()) {
          await startModDownloadQueue({ instanceId, installPath })
        }
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        app?.log.warn({ instanceId, error: message }, '导入后同步 Mod 文件失败')
        warnings.push('Mod 配置文件同步失败，请到 Mod 页面手动核对后再启动实例')
      }
    }

    app?.log.info({ instanceId, sourcePath, importedShards, modCount: modSync.modCount }, '存档导入完成')
    return {
      ok: true,
      result: {
        importedShards,
        modCount: modSync.modCount,
        missingWorkshopContent: modSync.missingWorkshopContent,
        tokenSource,
        safetyBackupId,
        gamePortSynced,
        warnings,
      },
    }
  }
  catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
    const message = error instanceof Error ? error.message : '存档导入失败'
    app?.log.error({ instanceId, sourcePath, error: message }, '存档导入整理失败')
    return { ok: false, message: `存档导入失败: ${message}` }
  }
}
