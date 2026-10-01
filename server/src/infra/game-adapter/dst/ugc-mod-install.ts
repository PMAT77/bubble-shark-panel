import fs from 'node:fs'
import path from 'node:path'
import { extractZipArchive } from '../../backup/zip-extract'
import { DST_CLUSTER_NAME, DST_WORKSHOP_APP_ID, resolveDstSteamWorkshopModDir } from './constants'
import { isCavesShardConfigured } from './shard-layout'

export type DstShardFolder = 'Master' | 'Caves'

export interface UgcModInstallOutcome {
  workshopId: string
  /** installed=本次落位；skipped=DST 目录已就绪；failed=落位失败（DST 将无法加载该 Mod） */
  status: 'installed' | 'skipped' | 'failed'
  error?: string
}

const MOD_INFO_FILE_NAME = 'modinfo.lua'
const MOD_MAIN_FILE_NAME = 'modmain.lua'
const MOD_MANIFEST_FILE_NAME = 'mod.manifest'
const LEGACY_ARCHIVE_SUFFIX = '_legacy.bin'

/**
 * DST 专用服只从 ugc_mods 读取创意工坊 Mod（启动日志「already have IDs」来自该目录扫描），
 * SteamCMD 的 steamapps/workshop/content 下载位置它完全不看。因此下载完成后必须把内容
 * 复制/解包到本函数给出的目录，否则 DST 会自己联网重下，legacy 包（ugchandle）常因超时失败。
 */
export function resolveDstUgcModDir(installPath: string, shardFolder: DstShardFolder, workshopId: string): string {
  return path.join(
    installPath,
    'ugc_mods',
    DST_CLUSTER_NAME,
    shardFolder,
    'content',
    DST_WORKSHOP_APP_ID,
    workshopId,
  )
}

/**
 * DST 传统的「v1」布局：`<install>/mods/workshop-<id>`（不分分片）。
 *
 * 实测（Native systemd 部署）：DST 只在这个目录有内容时才真正加载 Mod——日志里
 * `Mod: workshop-<id> ... Registering prefabs` 的行数会从 0 跳到数千；而同一个实例里
 * `ugc_mods/.../content/322330/<id>` 内容齐全、`modoverrides.lua` 也写好了 `enabled=true`，
 * DST 依然一个都不加载，也不会打印扫描 ugc 目录的 `Already have IDs`。
 * 因为 `-skip_update_server_mods` 同时禁止了游戏自己补下载，表现就是「面板全部已就绪、
 * 游戏里一个 Mod 都没有」，且没有任何报错。
 */
export function resolveDstLegacyModDir(installPath: string, workshopId: string): string {
  return path.join(installPath, 'mods', `workshop-${workshopId}`)
}

/** 需要落位的分片：洞穴未配置时只处理地上，与 DST 实际运行的分片保持一致 */
export function resolveDstUgcShardFolders(installPath: string): DstShardFolder[] {
  return isCavesShardConfigured(installPath) ? ['Master', 'Caves'] : ['Master']
}

function hasModInfoFile(dir: string): boolean {
  return fs.existsSync(path.join(dir, MOD_INFO_FILE_NAME))
}

/** DST 可加载的判定：目标目录存在 modinfo.lua */
export function isDstUgcModReady(
  installPath: string,
  workshopId: string,
  shardFolders: DstShardFolder[] = resolveDstUgcShardFolders(installPath),
): boolean {
  const normalizedId = workshopId.trim()
  if (!normalizedId || !installPath) {
    return false
  }
  return shardFolders.every(shardFolder => hasModInfoFile(resolveDstUgcModDir(installPath, shardFolder, normalizedId)))
}

/** SteamCMD 与历史布局下的 Mod 来源目录（按优先级） */
export function resolveDstWorkshopSourceDirs(installPath: string, workshopId: string): string[] {
  return [
    resolveDstSteamWorkshopModDir(installPath, workshopId),
    resolveDstLegacyModDir(installPath, workshopId),
  ]
}

/**
 * 该路径是不是「面板为 ugc_mods 落位结果建立的接入」（软链接，或链接不可用时的带标记副本）。
 *
 * 这类目录不是下载来源：跟随它等于把 ugc_mods 里的内容再复制回 ugc_mods（自己复制自己），
 * 内容更新时还会把旧副本当成"已下载的新内容"。
 */
function isLegacyEntryToUgcLayout(installPath: string, dir: string): boolean {
  if (readSymlinkTarget(dir)) {
    return isInsideUgcMods(installPath, dir)
  }
  const record = readLegacyCopyRecord(dir)
  return Boolean(record && isInsideUgcMods(installPath, record.source))
}

/** 路径是否落在本实例的 ugc_mods 落位目录内（软链接按其真实位置判定） */
function isInsideUgcMods(installPath: string, target: string): boolean {
  try {
    const real = fs.realpathSync(target)
    const rel = path.relative(path.resolve(installPath, 'ugc_mods'), path.resolve(real))
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }
  catch {
    return false
  }
}

type ModSource = { kind: 'dir', dir: string } | { kind: 'legacy', dir: string, archivePath: string }

/** 目标路径的软链接指向（不是软链接时返回 null，断链也算软链接） */
function readSymlinkTarget(targetPath: string): string | null {
  try {
    return fs.readlinkSync(targetPath)
  }
  catch {
    return null
  }
}

function findLegacyArchive(dir: string): string | null {
  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  }
  catch {
    return null
  }
  const archiveName = entries.find(name => name.toLowerCase().endsWith(LEGACY_ARCHIVE_SUFFIX))
  return archiveName ? path.join(dir, archiveName) : null
}

/** 解析可用来源：完整目录优先，其次 legacy 压缩包 */
export function resolveDstWorkshopModSource(installPath: string, workshopId: string): ModSource | null {
  for (const dir of resolveDstWorkshopSourceDirs(installPath, workshopId)) {
    if (!fs.existsSync(dir)) {
      continue
    }
    // 面板为 ugc_mods 结果建立的接入不是来源，见 isLegacyEntryToUgcLayout 的说明
    if (isLegacyEntryToUgcLayout(installPath, dir)) {
      continue
    }
    if (hasModInfoFile(dir)) {
      return { kind: 'dir', dir }
    }
    const legacyArchive = findLegacyArchive(dir)
    if (legacyArchive) {
      return { kind: 'legacy', dir, archivePath: legacyArchive }
    }
    if (fs.existsSync(path.join(dir, MOD_MAIN_FILE_NAME)) || fs.existsSync(path.join(dir, MOD_MANIFEST_FILE_NAME))) {
      return { kind: 'dir', dir }
    }
  }
  return null
}

function describeSource(source: ModSource): string {
  return source.kind === 'legacy' ? source.archivePath : source.dir
}

/** 先写临时目录再原子改名，保证 DST 不会读到半成品目录 */
async function installModIntoDirectory(source: ModSource, targetDir: string): Promise<void> {
  const tempDir = `${targetDir}.tmp-${process.pid}-${Date.now().toString(36)}`
  fs.rmSync(tempDir, { recursive: true, force: true })
  try {
    if (source.kind === 'legacy') {
      // legacy 包（*_legacy.bin）实测为标准 zip；解压失败即视为损坏包
      await extractZipArchive(source.archivePath, tempDir)
    }
    else {
      fs.mkdirSync(path.dirname(tempDir), { recursive: true })
      fs.cpSync(source.dir, tempDir, { recursive: true })
    }
    if (!hasModInfoFile(tempDir)) {
      throw new Error(`Mod 内容缺少 ${MOD_INFO_FILE_NAME}（来源：${describeSource(source)}）`)
    }
    fs.rmSync(targetDir, { recursive: true, force: true })
    fs.renameSync(tempDir, targetDir)
  }
  catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true })
    throw error
  }
}

/**
 * 将已下载的创意工坊 Mod 落位到 DST 的 ugc_mods 目录（幂等）。
 * 单个 Mod 失败只影响该 Mod，不抛出异常。
 *
 * `refresh` 用于「更新已订阅 Mod」：SteamCMD 刚下载了新版本，目标目录里还是旧内容，
 * 此时必须重新落位，否则 DST 加载的仍是旧版本（源目录与目标目录都在本地，重新复制
 * 比再下一次便宜得多）。落位依旧是「临时目录 + 原子改名」，DST 不会读到半成品。
 */
export async function ensureDstUgcModLayout(
  installPath: string,
  workshopIds: string[],
  options: { shardFolders?: DstShardFolder[], refresh?: boolean } = {},
): Promise<UgcModInstallOutcome[]> {
  const normalizedIds = [...new Set(workshopIds.map(id => id.trim()).filter(Boolean))]
  if (normalizedIds.length === 0) {
    return []
  }
  if (!installPath || !fs.existsSync(installPath)) {
    return normalizedIds.map(workshopId => ({
      workshopId,
      status: 'failed' as const,
      error: `实例安装目录不存在：${installPath || '(空)'}`,
    }))
  }

  const shardFolders = options.shardFolders ?? resolveDstUgcShardFolders(installPath)
  const outcomes: UgcModInstallOutcome[] = []
  const sourceCache = new Map<string, ModSource | null>()

  for (const workshopId of normalizedIds) {
    const pendingShards = options.refresh
      ? shardFolders
      : shardFolders.filter(
          shardFolder => !hasModInfoFile(resolveDstUgcModDir(installPath, shardFolder, workshopId)),
        )
    if (pendingShards.length === 0) {
      outcomes.push({ workshopId, status: 'skipped' })
      continue
    }
    if (!sourceCache.has(workshopId)) {
      sourceCache.set(workshopId, resolveDstWorkshopModSource(installPath, workshopId))
    }
    const source = sourceCache.get(workshopId) ?? null
    if (!source) {
      outcomes.push({
        workshopId,
        status: 'failed',
        error: `未找到已下载的 Mod 文件：${resolveDstWorkshopSourceDirs(installPath, workshopId).join(' 或 ')}`,
      })
      continue
    }
    try {
      for (const shardFolder of pendingShards) {
        await installModIntoDirectory(source, resolveDstUgcModDir(installPath, shardFolder, workshopId))
      }
      outcomes.push({ workshopId, status: 'installed' })
    }
    catch (error) {
      outcomes.push({
        workshopId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 内容落到 ugc_mods 之后，同步维护 DST 真正读取的 mods/workshop-<id>：
  // 只落位 ugc_mods 时游戏侧一个 Mod 都加载不到（见 resolveDstLegacyModDir 的说明）。
  const settledIds = outcomes
    .filter(outcome => outcome.status !== 'failed')
    .map(outcome => outcome.workshopId)
  const legacyById = new Map(
    (await ensureDstLegacyModLinks(installPath, settledIds, { shardFolders }))
      .map(outcome => [outcome.workshopId, outcome]),
  )
  return outcomes.map((outcome) => {
    const legacy = legacyById.get(outcome.workshopId)
    if (outcome.status === 'failed' || legacy?.status !== 'failed') {
      return outcome
    }
    return { workshopId: outcome.workshopId, status: 'failed' as const, error: legacy.error }
  })
}

// ---------------------------------------------------------------------------
// DST 实际加载的布局：mods/workshop-<id>
// ---------------------------------------------------------------------------

/**
 * 把已落位到 ugc_mods 的内容接入 `<install>/mods/workshop-<id>`。
 *
 * 用**相对软链接**而不是复制：同一份内容不占两份磁盘，实例目录整体搬迁后链接依然有效；
 * 且 ugc_mods 里的目录被「临时目录 + 原子改名」整体替换后，链接在下一次读取时自动指向新内容，
 * 不需要在更新流程里额外重建。
 *
 * 链接不可用（文件系统或权限限制）时退化为复制，保证游戏侧仍能加载。
 * 单个 Mod 失败不影响其余；返回的 outcome 由 ensureDstUgcModLayout 合并。
 */
export async function ensureDstLegacyModLinks(
  installPath: string,
  workshopIds: string[],
  options: { shardFolders?: DstShardFolder[] } = {},
): Promise<UgcModInstallOutcome[]> {
  const normalizedIds = [...new Set(workshopIds.map(id => id.trim()).filter(Boolean))]
  if (normalizedIds.length === 0 || !installPath || !fs.existsSync(installPath)) {
    return []
  }
  const shardFolders = options.shardFolders ?? resolveDstUgcShardFolders(installPath)
  const outcomes: UgcModInstallOutcome[] = []
  for (const workshopId of normalizedIds) {
    // 分片之间内容一致，取第一个有内容的即可；两个分片都不在才算失败
    const sourceDir = shardFolders
      .map(shardFolder => resolveDstUgcModDir(installPath, shardFolder, workshopId))
      .find(dir => hasModInfoFile(dir))
    if (!sourceDir) {
      outcomes.push({
        workshopId,
        status: 'failed',
        error: 'Mod 内容尚未落位到服务器目录',
      })
      continue
    }
    try {
      outcomes.push({ workshopId, status: ensureDstLegacyModLink(installPath, workshopId, sourceDir) })
    }
    catch (error) {
      outcomes.push({
        workshopId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return outcomes
}

/**
 * 把一份已经落位的内容接入 `mods/workshop-<id>`，返回 installed（新建或替换）或 skipped（无需改动）。
 *
 * 优先用符号链接（ugc_mods 换内容走目录级替换，链接自动指向新内容，无需重建）；
 * 链接不可用（Windows 开发机、受限文件系统）时退化为复制，并在目标目录里留下标记，
 * 这样下次内容更新时能重建、删除 Mod 时也不会误删外部手工放置的目录。
 */
export function ensureDstLegacyModLink(
  installPath: string,
  workshopId: string,
  sourceDir: string,
): 'installed' | 'skipped' {
  const targetDir = resolveDstLegacyModDir(installPath, workshopId)
  const sourceMtimeMs = readDirMtimeMs(sourceDir)
  if (readSymlinkTarget(targetDir) && isSameRealPath(targetDir, sourceDir)) {
    return 'skipped'
  }
  const copyRecord = readLegacyCopyRecord(targetDir)
  if (copyRecord) {
    const sameSource = path.resolve(copyRecord.source) === path.resolve(sourceDir)
    if (sameSource && copyRecord.sourceMtimeMs === sourceMtimeMs) {
      return 'skipped'
    }
  }
  // 真实目录且内容完整、又不是面板生成的，才视为外部放置；指向别处的链接必须重建
  else if (!readSymlinkTarget(targetDir) && fs.existsSync(targetDir) && hasModInfoFile(targetDir)) {
    return 'skipped'
  }
  fs.mkdirSync(path.dirname(targetDir), { recursive: true })
  try {
    writeSymlinkAtomically(targetDir, sourceDir)
  }
  catch {
    copyDirectoryAtomically(sourceDir, targetDir)
    writeLegacyCopyRecord(targetDir, sourceDir, sourceMtimeMs)
  }
  return 'installed'
}

/** 删除 Mod 时的接入清理：只删自己建的链接与带标记的副本，不动外部放置的真实目录 */
export function removeDstLegacyModLinks(installPath: string, workshopIds: string[]): void {
  if (!installPath || !fs.existsSync(installPath)) {
    return
  }
  for (const workshopId of new Set(workshopIds.map(id => id.trim()).filter(Boolean))) {
    const targetDir = resolveDstLegacyModDir(installPath, workshopId)
    const owned = Boolean(readSymlinkTarget(targetDir)) || Boolean(readLegacyCopyRecord(targetDir))
    if (!owned) {
      continue
    }
    try {
      removeLegacyEntry(targetDir)
    }
    catch {
      // best-effort：残留的接入在内容被删后指向不存在的位置，游戏侧读不到该 Mod
    }
  }
}

/** 复制退化时写入目标目录的标记：证明这个目录是面板生成的，可安全重建与删除 */
const LEGACY_COPY_MARKER = '.gsh-legacy-copy.json'

interface LegacyCopyRecord {
  /** 源目录（ugc_mods 里的落位结果）绝对路径 */
  source: string
  /** 记录时的源目录 mtime；内容更新后它会变，据此判断需要重建副本 */
  sourceMtimeMs: number
}

function readLegacyCopyRecord(targetDir: string): LegacyCopyRecord | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(targetDir, LEGACY_COPY_MARKER), 'utf8'),
    ) as LegacyCopyRecord
    return typeof parsed?.source === 'string' && typeof parsed?.sourceMtimeMs === 'number' ? parsed : null
  }
  catch {
    return null
  }
}

function writeLegacyCopyRecord(targetDir: string, sourceDir: string, sourceMtimeMs: number): void {
  const record: LegacyCopyRecord = { source: path.resolve(sourceDir), sourceMtimeMs }
  fs.writeFileSync(path.join(targetDir, LEGACY_COPY_MARKER), `${JSON.stringify(record)}\n`, 'utf8')
}

function readDirMtimeMs(dir: string): number {
  try {
    return fs.statSync(dir).mtimeMs
  }
  catch {
    return 0
  }
}

/**
 * 删掉一个接入产物：软链接按链接删（不让 recursive 误删链接指向的落位内容），
 * 真实目录才递归删。断链的链接同样走 unlink。
 */
function removeLegacyEntry(targetPath: string): void {
  if (readSymlinkTarget(targetPath)) {
    fs.unlinkSync(targetPath)
    return
  }
  fs.rmSync(targetPath, { recursive: true, force: true })
}

function isSameRealPath(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b)
  }
  catch {
    return false
  }
}

/** 先建临时链接再原子改名，DST 不会读到半成品 */
function writeSymlinkAtomically(targetDir: string, sourceDir: string): void {
  const relativeSource = path.relative(path.dirname(targetDir), sourceDir)
  const tempLink = `${targetDir}.link-${process.pid}-${Date.now().toString(36)}`
  removeLegacyEntry(tempLink)
  try {
    fs.symlinkSync(relativeSource, tempLink, 'dir')
    removeLegacyEntry(targetDir)
    fs.renameSync(tempLink, targetDir)
  }
  catch (error) {
    removeLegacyEntry(tempLink)
    throw error
  }
}

function copyDirectoryAtomically(sourceDir: string, targetDir: string): void {
  const tempDir = `${targetDir}.tmp-${process.pid}-${Date.now().toString(36)}`
  fs.rmSync(tempDir, { recursive: true, force: true })
  try {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true })
    fs.cpSync(sourceDir, tempDir, { recursive: true })
    removeLegacyEntry(targetDir)
    fs.renameSync(tempDir, targetDir)
  }
  catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true })
    throw error
  }
}
