import { readBrandEnv } from '../../../shared/brand-env'
import type { Readable } from 'node:stream'
import type { PluginCapability, PluginImportResult, PluginManifest } from '../../../shared/contracts/plugin'
import type { ZipExtractLimits } from '../infra/backup/zip-extract'
import fs from 'node:fs'
import path from 'node:path'
import {
  cleanStaleSaveImportUploads,
  receiveUploadToTempFile,
  removeUploadDirectory,
  resolveSaveImportUploadRoot,
  unpackSaveImportArchive,
} from '../modules/backup/upload-service'
import { loadPluginDirectory, summarizePluginCapabilities } from './manifest'
import { resolveLicenseGap, resolvePluginsRoot } from './registry'

/**
 * 插件包导入。
 *
 * 这一段的核心纪律是**校验先于落盘**：解压到临时目录 → 走一遍与宿主启动时
 * 完全相同的装载校验（清单、入口、接口版本、签名）→ 全部通过后才改名进插件目录。
 * 这样做的收益很具体：签名不对、清单损坏、接口版本不兼容的包**永远不会**污染插件目录，
 * 也就不会在插件列表里留下一个只能人工去删的 `invalid` 条目。
 *
 * 复用的是存档导入那套已经验证过的地基（`modules/backup/upload-service.ts`）：
 * 流式落盘 + 超限即断、按文件头魔数识别格式（不信任 Content-Type）、
 * 解压时的 zip-slip 与 zip bomb 防护、过期临时目录清理。插件包比存档包小得多
 * （几十 KB 量级），所以只把体积上限收紧，其余防护原样继承。
 *
 * 刻意**不做**的事：
 * - 不联网、不下载：包从哪来是面板之外的事，这里只接受用户已经拿到的文件；
 * - 不导入许可（`license.json`）：许可与插件包是两道独立校验，
 *   「有包没许可」和「有许可没包」都是合法中间态，合并校验会把它们都卡死；
 * - 不自动启用：导入只负责把文件放对位置，是否运行由管理员决定（与 `setPluginEnabled` 一致）。
 */

/** 插件包体积上限：64 MB。插件是脚本与清单，几十 KB 量级，给足余量但不沿用存档的 2 GB */
const PLUGIN_PACKAGE_LIMIT_BYTES = 64 * 1024 * 1024

/** 定位插件目录时的递归深度上限：防构造极深的嵌套目录把扫描拖住 */
const MAX_DIRECTORY_DEPTH = 4

/** UUID 形态的 uploadId：服务端自己签发，固定格式天然防路径穿越 */
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 一次导入最多占用临时目录的时间：确认导入要在此之前完成，之后目录会被清理 */
const IMPORT_UPLOAD_STALE_MS = 60 * 60 * 1000

export type ImportUploadResult
  = | { ok: true, uploadId: string, analysis: PluginPackageAnalysis }
    | { ok: false, message: string }

/** 一次性上传 + 解压 + 校验的结果：给用户看「这个包里到底是什么」 */
export interface PluginPackageAnalysis {
  pluginId: string
  name: string
  version: string
  apiVersion: number
  signed: boolean
  publisher: string | null
  capabilities: PluginCapability[]
  hasDangerousCapabilities: boolean
  /** 命名空间与商店卡片一致：装机后会缺哪个授权，这里就报哪个 */
  requiredLicenseGap: string | null
}

/** 导入体积上限（测试与小内存部署可用环境变量收紧，与存档导入同一套习惯） */
export function resolvePluginPackageLimitBytes(): number {
  const parsed = Number(readBrandEnv('BSP_PLUGIN_IMPORT_MAX_BYTES'))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : PLUGIN_PACKAGE_LIMIT_BYTES
}

/**
 * 第一步：接收上传、解压到临时目录，并立刻做一次装载校验。
 *
 * 为什么要把「校验结论」和「确认导入」拆成两次请求，而不是一次做完：
 * 用户需要在**写盘之前**看到「这是谁签的、装完还缺哪项授权」，才谈得上确认；
 * 而如果上传后就把临时目录丢掉，用户点确认时还得再传一遍同一个文件。
 * 所以这里保留临时目录，把 `uploadId` 交给前端，确认时凭它继续。
 *
 * 上传文件名不参与任何磁盘命名——插件目录名一律取自清单里的 `id`，
 * 用户把包命名为「远程备份.zip」还是 `remote-backup-v1.2.0.zip` 都不影响结果。
 */
export async function receivePluginPackage(payload: Readable): Promise<ImportUploadResult> {
  // 顺手清理以往放弃或失败的导入留下的临时目录，避免长期运行的机器上越堆越多
  cleanStaleSaveImportUploads(IMPORT_UPLOAD_STALE_MS, resolveSaveImportUploadRoot())

  const received = await receiveUploadToTempFile(payload, resolvePluginPackageLimitBytes())
  if (!received.ok || !received.uploadId || !received.filePath) {
    return { ok: false, message: received.error ?? '插件包上传失败。' }
  }

  const uploadId = received.uploadId
  const extractRoot = path.join(path.dirname(received.filePath), 'extract')

  /**
   * 格式识别交给 `unpackSaveImportArchive` 内部做（按文件头魔数，不信任 Content-Type）：
   * 它认不出格式时抛错，由下面的 catch 翻成用户能照着做的说明。
   * 这里不再单独调一次 `detectArchiveFormat`——同一个判断做两遍，两处迟早会不一致。
   */
  try {
    await unpackSaveImportArchive(received.filePath, extractRoot, pluginExtractLimits())
  }
  catch (error) {
    removeUploadDirectory(uploadId)
    return {
      ok: false,
      message: `插件包无法解压：${error instanceof Error ? error.message : String(error)}。插件包应当是 .zip 或 .tar.gz 文件。`,
    }
  }

  const analyzed = analyzeExtractedPackage(uploadId)
  if (!analyzed.ok) {
    removeUploadDirectory(uploadId)
    return { ok: false, message: analyzed.message }
  }
  return { ok: true, uploadId, analysis: summarizeForUser(analyzed) }
}

type ExtractedAnalysis
  = | { ok: true, pluginDir: string, manifest: PluginManifest, signed: boolean, publisher: string | null }
    | { ok: false, message: string }

/**
 * 在解压结果里定位插件目录并做装载校验（**不写插件目录**）。
 *
 * 校验顺序由 `loadPluginDirectory` 决定（清单 → 入口 → 接口版本 → 签名），
 * 这里不重复实现任何一条：宿主启动插件时走的是同一个函数，
 * 于是「导入时校验通过」与「启用时能装载」必然一致，不会出现两套结论。
 *
 * 为什么允许自动钻几层子目录：从群里或网盘拿到的包，十有八九是
 * `remote-backup-1.2.0/plugin.json` 这一层，而不是根目录直接放清单。
 * 直接报「缺少 plugin.json」会把最常见的一次成功导入变成一次求助。
 */
function analyzeExtractedPackage(uploadId: string): ExtractedAnalysis {
  const pluginDir = locatePluginDir(resolveExtractRoot(uploadId))
  if (!pluginDir) {
    return {
      ok: false,
      message: '插件包里找不到 plugin.json：确认拿到的不是源码目录或文档包，或重新获取插件包。',
    }
  }

  const loaded = loadPluginDirectory(pluginDir)
  if (!loaded.ok) {
    return { ok: false, message: loaded.message }
  }

  /**
   * 命中同名插件时在**写盘之前**拒绝。
   * 放在这里而不是落位前一步，是因为此时用户还没点「确认导入」，
   * 报错更像一次前置校验，而不是一次失败操作。
   */
  if (fs.existsSync(path.join(resolvePluginsRoot(), loaded.manifest.id))) {
    return {
      ok: false,
      message: `插件目录里已经有「${loaded.manifest.name}」了：请先停用它，或删掉该目录后重试。`,
    }
  }

  return {
    ok: true,
    pluginDir,
    manifest: loaded.manifest,
    signed: loaded.signed,
    publisher: loaded.publisher,
  }
}

/** 把一次校验结果翻成给用户看的结论 */
function summarizeForUser(loaded: Extract<ExtractedAnalysis, { ok: true }>): PluginPackageAnalysis {
  const summary = summarizePluginCapabilities(loaded.manifest)
  return {
    pluginId: loaded.manifest.id,
    name: loaded.manifest.name,
    version: loaded.manifest.version,
    apiVersion: loaded.manifest.apiVersion,
    signed: loaded.signed,
    publisher: loaded.publisher,
    capabilities: summary.capabilities,
    hasDangerousCapabilities: summary.hasDangerousCapabilities,
    requiredLicenseGap: loaded.manifest.kind === 'commercial'
      ? resolveLicenseGap(loaded.manifest.capabilities)
      : null,
  }
}

function resolveExtractRoot(uploadId: string): string {
  return path.join(resolveSaveImportUploadRoot(), uploadId, 'extract')
}

/**
 * 第三步：把校验通过的插件目录移入插件根目录。
 *
 * **校验在这里重跑一遍，而不是复用第一步的结论。** 这不只是防御性编程：
 * 两阶段提交之间隔着用户思考的时间，临时目录里的内容理论上可以被替换，
 * 而复用一份「之前校验过」的结果正好会把这个窗口漏掉。重跑成本极低
 * （读一个 JSON、验一次签名），换来的是一条干净的规则：
 * **真正被写进插件目录的内容，一定是刚刚校验过的那些字节。**
 *
 * 用 `rename` 而不是复制：两者同一卷时是原子操作，不会出现「复制到一半」的半个插件。
 * 临时目录位于系统临时目录，跨卷时 `fs.renameSync` 会抛 `EXDEV`，
 * 所以下面显式兜底成复制 + 删除，而不是把失败抛给用户。
 */
export type InstallPluginResult
  = | { ok: true, result: PluginImportResult }
    | { ok: false, message: string }

export function installPluginPackage(uploadId: string): InstallPluginResult {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    return { ok: false, message: '导入记录无效，请重新选择插件包。' }
  }

  const verified = analyzeExtractedPackage(uploadId)
  if (!verified.ok) {
    removeUploadDirectory(uploadId)
    return { ok: false, message: verified.message }
  }

  const { manifest, pluginDir } = verified
  const pluginsRoot = resolvePluginsRoot()
  const targetDir = path.join(pluginsRoot, manifest.id)

  try {
    fs.mkdirSync(pluginsRoot, { recursive: true })
    moveDirectory(pluginDir, targetDir)
    // 落位后立刻确保它是「停用」状态，理由见 clearEnabledFlag 的注释
    clearEnabledFlag(pluginsRoot, manifest.id)
  }
  catch (error) {
    return {
      ok: false,
      message: `写入插件目录失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  finally {
    // 无论成败都清掉临时目录：失败时留着它只会在临时目录里积垃圾
    removeUploadDirectory(uploadId)
  }

  const analysis = summarizeForUser(verified)
  const permissions = ensureEntryReadable(path.join(targetDir, manifest.entry))

  /**
   * 导入成功不等于可以启用：商业插件还缺授权时如实报 `missing_license`，
   * 复用 `pluginStateSchema`，让界面与列表页用同一套语义解释这个状态。
   * 这里**不**返回「导入成功」这种含糊结论——用户真正要知道的是「还差什么」。
   */
  const state = analysis.requiredLicenseGap ? 'missing_license' : 'disabled'
  const baseMessage = analysis.requiredLicenseGap
    ? `已导入，但还不能启用：${analysis.requiredLicenseGap}`
    : '已导入并默认停用；确认无误后在「已安装」里启用它即可运行。'

  return {
    ok: true,
    result: {
      pluginId: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      signed: analysis.signed,
      publisher: analysis.publisher,
      capabilities: analysis.capabilities,
      hasDangerousCapabilities: analysis.hasDangerousCapabilities,
      state,
      message: permissions.ok
        ? baseMessage
        : `${baseMessage} 另外：入口文件的读权限设置失败（${permissions.message}），启用后若启动失败请检查文件权限。`,
      directory: targetDir,
    },
  }
}

/** 解压上限：条目数与总字节沿用存档那一套，额外把单包体积限得更小 */
function pluginExtractLimits(): ZipExtractLimits {
  return {
    maxEntries: 5_000,
    maxTotalUncompressedBytes: PLUGIN_PACKAGE_LIMIT_BYTES * 4,
  }
}

/**
 * 把插件从启用名单里摘掉。
 *
 * 为什么需要这一步：启用状态存在 `plugins.state.json` 里，它与插件目录是**两份数据**。
 * 管理员停用后手工删掉目录、过一阵再导入同一个插件时，那份状态文件里可能还留着它的
 * 启用记录——于是新导入的包一落盘就被宿主 `sync()` 拉起来，
 * 「导入后默认停用」这句承诺当场失效。用户对一份还没看过的代码失去一次确认机会，
 * 这不是小事，所以要显式清掉。
 *
 * 状态文件损坏或不可写时**不阻断导入**：插件已经落位是既成事实，
 * 这时报失败反而让用户以为没装上。状态不一致由列表页如实显示（显示为已启用）。
 */
function clearEnabledFlag(pluginsRoot: string, pluginId: string): void {
  const statePath = path.join(pluginsRoot, 'plugins.state.json')
  try {
    if (!fs.existsSync(statePath)) {
      return
    }
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { enabled?: unknown }
    if (!Array.isArray(parsed.enabled)) {
      return
    }
    const remaining = parsed.enabled.filter(item => item !== pluginId)
    if (remaining.length === parsed.enabled.length) {
      return
    }
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({ version: 1, enabled: [...remaining].sort() }, null, 2)}\n`,
      'utf8',
    )
  }
  catch {
    // best-effort：状态文件的问题不该让一次成功的导入变成失败
  }
}

/**
 * 在解压结果里找到真正含 `plugin.json` 的那一层。
 *
 * 广度优先、深度受限：先看根，再逐层下钻。找不到就返回 null，由调用方给出
 * 「包里没有 plugin.json」的说明——而不是猜一个目录往下走。
 */
function locatePluginDir(root: string): string | null {
  let level: string[] = [root]
  for (let depth = 0; depth <= MAX_DIRECTORY_DEPTH; depth += 1) {
    const next: string[] = []
    for (const dir of level) {
      if (fs.existsSync(path.join(dir, 'plugin.json'))) {
        return dir
      }
      for (const entry of readSubdirectories(dir)) {
        next.push(entry)
      }
    }
    if (next.length === 0) {
      return null
    }
    level = next
  }
  return null
}

function readSubdirectories(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => path.join(dir, entry.name))
  }
  catch {
    return []
  }
}

/**
 * 确保入口文件可读。
 *
 * 宿主用 `spawn(process.execPath, [entry])` 启动插件，Node 只需要**读**权限即可执行；
 * 但解包会丢掉原来的权限位（tar/zip 都不保证保留），因此这里补上读位。
 * Windows 上权限模型不同且 `chmod` 基本是空操作，直接跳过。
 */
function ensureEntryReadable(entryPath: string): { ok: true } | { ok: false, message: string } {
  if (process.platform === 'win32') {
    return { ok: true }
  }
  try {
    const stat = fs.statSync(entryPath)
    if (!stat.isFile()) {
      return { ok: false, message: '入口不是一个文件' }
    }
    if ((stat.mode & 0o444) !== 0o444) {
      fs.chmodSync(entryPath, stat.mode | 0o444)
    }
    return { ok: true }
  }
  catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 目录移动：同卷用 rename（原子），跨卷退化为复制后删除 */
function moveDirectory(from: string, to: string): void {
  try {
    fs.renameSync(from, to)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw error
    }
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true, maxRetries: 2 })
  }
}
