import { randomUUID } from 'node:crypto'
import { assertInstanceRuntimeStopped } from '../../infra/container/instance-stopped'
import type { MigrationContentSummary, MigrationMod } from '../../../../shared/contracts/migration'
import { listInstanceMods, getGameInstanceById } from '../../shared/db/index'
import { withInstanceContentOperation } from '../../shared/instance-content/operation'
import { inspectMigrationContents, resolveInstanceMigrationModSource, writeMigrationBundle } from '../../infra/game-adapter/dst/migration-bundle'
import { parseStoredModConfig } from '../../infra/game-adapter/dst/mod-config'
import { readModDependencies } from '../../infra/game-adapter/dst/mod-service'
import { sha256File } from '../../infra/game-adapter/dst/mod-content'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  buildMigrationReportText,
  inspectClusterForMigration,
  sanitizeArchiveBaseName,
} from '../../infra/game-adapter/dst/cluster-migration'
import { resolveClusterPaths } from '../../infra/game-adapter/dst/cluster-service'
import { loadServerConfig } from '../../shared/config'
import { probeSaveImportSource } from '../backup/import-service'

/**
 * 迁移包导出：把本面板实例的存档整理成「另一台机器能直接导入」的包。
 *
 * 与 `scripts/export-cluster-archive.ts` 的分工：那个脚本用于从**别的机器**上整理存档
 * （没有安装本面板也一样能用）；这里用于从**本面板管理的实例**导出。两者共用
 * `cluster-migration.ts` 的识别、体检与报告实现，避免包与报告对不上。
 *
 * 产物落盘而不是边打边流：tar 打包要几十秒到几分钟，先落盘才能让下载断点重试、
 * 也才能把「包大小」写回界面。落盘位置在面板数据目录下，按实例 ID 前缀清理旧包。
 */

const MIGRATION_EXPORT_DIR_NAME = 'migration-exports'
/** 同一实例的旧导出包保留时长：超过即视为残留（下载是即时的，不需要长期留档） */
const STALE_EXPORT_MS = 24 * 60 * 60 * 1000

export interface MigrationExportOutcome {
  ok: true
  /** 迁移包绝对路径；reportOnly 时为 null */
  archivePath: string | null
  fileName: string
  sizeBytes: number
  reportText: string
  warnings: string[]
  modContent: MigrationContentSummary
}

export type MigrationExportResult = MigrationExportOutcome | { ok: false, message: string }

/** 导出根目录：与数据库同级，随面板数据目录一起被备份或迁移 */
export function resolveMigrationExportRoot(): string {
  const configured = process.env.GSH_MIGRATION_EXPORT_ROOT?.trim()
  if (configured) {
    return path.resolve(configured)
  }
  return path.join(path.dirname(loadServerConfig().dbPath), MIGRATION_EXPORT_DIR_NAME)
}

/** 清理同一实例的旧导出包与报告，避免数据目录里越堆越多 */
function cleanupStaleExports(root: string, instanceId: string): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  }
  catch {
    return
  }
  const prefix = `migration-${instanceId}-`
  const now = Date.now()
  for (const name of entries) {
    if (!name.startsWith(prefix)) {
      continue
    }
    const target = path.join(root, name)
    try {
      const stat = fs.statSync(target)
      if (now - stat.mtimeMs > STALE_EXPORT_MS) {
        fs.rmSync(target, { force: true })
      }
    }
    catch {
      // 文件已在别处被删除：忽略
    }
  }
}

export interface ExportInstanceMigrationOptions {
  instanceId: string
  installPath: string
  /** true 时只体检与出报告，不打包 */
  reportOnly?: boolean
  includeMods?: boolean
}

/**
 * 导出某个实例的迁移包。
 *
 * 关键边界：**只导出实例自己的集群目录**（`<installPath>/klei-storage/DoNotStarveTogether/Cluster_1`），
 * 不遍历实例目录下的其它内容——实例目录里有游戏本体与 Mod 内容，全部打包会得到几十 GB
 * 的无用包；而集群目录恰好就是面板导入侧要求的顶层结构。
 */
async function exportInstanceMigrationPackUnlocked(
  options: ExportInstanceMigrationOptions,
): Promise<MigrationExportResult> {
  const { clusterRoot } = resolveClusterPaths(options.installPath)
  const clusterIniPath = path.join(clusterRoot, 'cluster.ini')
  if (!fs.existsSync(clusterIniPath)) {
    return {
      ok: false,
      message: '实例还没有房间配置文件，无法导出迁移包：请先创建实例并至少启动过一次，让世界生成完成',
    }
  }

  const report = inspectClusterForMigration(clusterRoot)
  const probe = probeSaveImportSource(clusterRoot)
  const probed = probe.result?.candidates[0]
  const importProbe = probe.ok && probed
    ? { ok: true, clusterName: probed.clusterName, dirName: probed.dirName }
    : { ok: false, message: probe.message }

  const nextSteps = [
    '在目标机器的面板上创建同名实例（不要启动），并确认端口与源实例一致或按目标机器实际端口重排；',
    '打开「备份与恢复 → 导入存档」，上传本压缩包，确认识别出的集群后导入；',
    '按目标机器的实际端口核对主世界与洞穴的 6 个 UDP 端口（外部端口必须与内部一致）；',
    '启动实例，等世界就绪后进服确认：能读档、Mod 全部生效、名单正确；',
    '保留本压缩包作为回滚包，确认无误后再清理源实例。',
  ]

  /**
   * 文件名只用 ASCII 安全字符，房间名（可能全是中文）留在报告里。
   *
   * 这不是洁癖：文件名要经过 HTTP 头、浏览器下载、以及客户在目标机器上的 `ls` 与上传框。
   * 中文名在每一段都可能被转义或替换（早先版本直接让 `Content-Disposition`
   * 抛 `ERR_INVALID_CHAR`，接口 500），而 `migration-<实例后缀>-Cluster_1.tar.gz`
   * 在导入侧、`tar` 与 `scp` 里都不会被改写；房间名在报告第一行，人不会看错。
   */
  const instanceSuffix = options.instanceId.replace(/[^0-9a-zA-Z]/g, '').slice(-8) || 'instance'
  const baseName = sanitizeArchiveBaseName(`migration-${instanceSuffix}-${report.dirName}${options.reportOnly ? '' : `-${randomUUID().slice(0, 8)}`}`)
  const reportFileName = `${baseName}.report.txt`
  const archiveFileName = `${baseName}.tar.gz`

  const records = await listInstanceMods(options.instanceId)
  const mods: MigrationMod[] = records.map(mod => ({
    workshopId: mod.workshopId, name: mod.name, enabled: mod.enabled, loadOrder: mod.loadOrder,
    configurationOptions: parseStoredModConfig(mod.config) ?? {},
    dependencyIds: readModDependencies(options.installPath, mod.workshopId),
    version: mod.version, localUpdatedAt: mod.contentSource === 'local' ? null : mod.localUpdatedAt,
    content: null,
  }))
  const inspected = await inspectMigrationContents(mods, options.includeMods === true, id => resolveInstanceMigrationModSource(options.installPath, id))
  const contentReport = `\nMod 文件：${options.includeMods ? '包含' : '不包含'}；包含 ${inspected.summary.includedModCount} 个，预计 ${inspected.summary.estimatedContentBytes} 字节。\n`
    + (inspected.summary.missingRequiredMods.length ? `缺少必需 Mod，无法完整导出：${inspected.summary.missingRequiredMods.join('、')}\n` : '')
    + (inspected.summary.missingOptionalMods.length ? `禁用且缺少文件，仅迁移配置：${inspected.summary.missingOptionalMods.join('、')}\n` : '')
  const extraWarnings = [
    ...(inspected.summary.missingOptionalMods.length ? ['部分禁用 Mod 不含文件，恢复后需手动补齐才能启用'] : []),
    ...(inspected.summary.missingRequiredMods.length ? ['缺少启用 Mod 或必要依赖的文件，无法完整导出'] : []),
  ]
  if (options.reportOnly) {

    return {
      ok: true,
      archivePath: null,
      fileName: archiveFileName,
      sizeBytes: 0,
      reportText: buildMigrationReportText(report, {
        archiveName: archiveFileName,
        importProbe,
        nextSteps,
      }) + contentReport,
      warnings: [...report.warnings, ...extraWarnings],
      modContent: inspected.summary,
    }
  }

  const root = resolveMigrationExportRoot()
  fs.mkdirSync(root, { recursive: true })
  // 清理前缀按实例后缀：与文件名前缀一致，才能把同一实例上一次的包清掉
  cleanupStaleExports(root, instanceSuffix)

  const archivePath = path.join(root, archiveFileName)
  try {
    const text = buildMigrationReportText(report, { archiveName: archiveFileName, importProbe, nextSteps }) + contentReport
    await writeMigrationBundle({ clusterPath: clusterRoot, archivePath, reportText: text, inspected, includeMods: options.includeMods === true })
    const digest = await sha256File(archivePath)
    fs.writeFileSync(`${archivePath}.owner.json`, JSON.stringify({ instanceId: options.instanceId }))
    fs.writeFileSync(`${archivePath}.sha256`, `${digest}  ${archiveFileName}\n`, 'utf8')
    const reportText = buildMigrationReportText(report, {
      archiveName: archiveFileName,
      importProbe,
      nextSteps,
    }) + contentReport
    fs.writeFileSync(path.join(root, reportFileName), reportText, 'utf8')

    return {
      ok: true,
      archivePath,
      fileName: archiveFileName,
      sizeBytes: fs.statSync(archivePath).size,
      reportText,
      warnings: [...report.warnings, ...extraWarnings],
      modContent: inspected.summary,
    }
  }
  catch (error) {
    for (const file of [archivePath, `${archivePath}.owner.json`, `${archivePath}.sha256`, path.join(root, reportFileName)]) {
      try { fs.rmSync(file, { force: true }) } catch { /* best-effort cleanup */ }
    }
    return { ok: false, message: `打包失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function exportInstanceMigrationPack(options: ExportInstanceMigrationOptions): Promise<MigrationExportResult> {
  const action = async () => {
    if (options.includeMods && !options.reportOnly) {
      const instance = await getGameInstanceById(options.instanceId)
      if (instance?.status !== 'stopped') return { ok: false as const, message: '请先停止实例再导出含 Mod 的迁移包' }
      await assertInstanceRuntimeStopped(options.instanceId)
    }
    return exportInstanceMigrationPackUnlocked(options)
  }
  try { return options.reportOnly ? await action() : await withInstanceContentOperation(options.instanceId, action) }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : '迁移导出失败' } }
}
