#!/usr/bin/env node
import { inspectMigrationContents, writeMigrationBundle } from '../server/src/infra/game-adapter/dst/migration-bundle.ts'
import { parseModOverridesEntries, readLocalModInfo } from '../server/src/infra/game-adapter/dst/mod-config.ts'
import { isWorldSeedModId } from '../server/src/infra/game-adapter/dst/world-seed.ts'
import type { MigrationMod } from '../shared/contracts/migration.ts'
/**
 * 迁移导出工具：把源机器上的饥荒（DST）集群存档整理成「能直接交给 Game Server Hub 导入」的包。
 *
 * 为什么需要它：付费迁移服务里最费时间的不是安装面板，而是从旧机器或旧面板上把存档、
 * 配置、Mod 清单和端口对照关系理清楚。手工做这件事要在几个目录之间来回找，
 * 且很容易漏掉「洞穴端口和主世界必须一一对应」这类只有踩过才知道的坑。
 *
 * 产出（每个集群一份）：
 *   1. `<集群名>.tar.gz`：包内顶层就是集群目录（含 cluster.ini），面板「导入存档」直接可用；
 *   2. `<集群名>.report.txt`：分片、端口、Mod 清单与迁移前必须确认的事项；
 *   3. `<集群名>.sha256`：压缩包校验和，传输后先核对再导入。
 *
 * 用法：
 *   tsx scripts/export-cluster-archive.ts --source <源目录> --out <输出目录> [--name <包名前缀>]
 *
 * 只读源目录，不修改任何源文件；不打印集群令牌与房间密码。
 *
 * 识别、体检与报告文本来自 `server/src/infra/game-adapter/dst/cluster-migration.ts`，
 * 与面板内的「导出迁移包」共用同一份实现——两处各写一遍的结局是报告与包对不上。
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createDirectoryArchive } from '../server/src/infra/backup/archive.ts'
import {
  buildMigrationReportText,
  discoverClusters,
  formatBytesForReport,
  inspectClusterForMigration,
  sanitizeArchiveBaseName,
} from '../server/src/infra/game-adapter/dst/cluster-migration.ts'
import { probeSaveImportSource } from '../server/src/modules/backup/import-service.ts'

function fail(message: string): never {
  console.error(`[export] ${message}`)
  process.exit(1)
}

function parseArgs(argv: string[]): { source: string, out: string, name?: string, includeMods: boolean, modsSource?: string } {
  let source = ''
  let out = ''
  let name: string | undefined
  let includeMods = false
  let modsSource: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--source') {
      source = argv[index + 1] ?? ''
      index += 1
      continue
    }
    if (arg === '--out') {
      out = argv[index + 1] ?? ''
      index += 1
      continue
    }
    if (arg === '--name') {
      name = argv[index + 1]
      index += 1
      continue
    }
    if (arg === '--include-mods') { includeMods = true; continue }
    if (arg === '--mods-source') { modsSource = argv[++index]; continue }
    if (arg === '--help' || arg === '-h') {
      console.log('用法：tsx scripts/export-cluster-archive.ts --source <源目录> --out <输出目录> [--name <包名前缀>] [--include-mods --mods-source <Mod 目录>]')
      process.exit(0)
    }
    fail(`无法识别的参数：${arg}`)
  }
  if (!source || !out) {
    fail('必须同时指定 --source 与 --out（--help 查看用法）')
  }
  if (includeMods && !modsSource) fail('--include-mods 必须同时指定 --mods-source；请先停止源服务器')
  return { source: path.resolve(source), out: path.resolve(out), name, includeMods, modsSource: modsSource ? path.resolve(modsSource) : undefined }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

async function main() {
  const { source, out, name, includeMods, modsSource } = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    fail(`源目录不存在或不是目录：${source}`)
  }
  const clusters = discoverClusters(source)
  if (clusters.length === 0) {
    fail(`在 ${source} 下没有找到任何含 cluster.ini 的集群目录。请把 --source 指向实例安装目录、klei-storage 或其上层目录。`)
  }

  fs.mkdirSync(out, { recursive: true })
  console.log(`[export] 找到 ${clusters.length} 个集群，输出到 ${out}`)

  for (const clusterPath of clusters) {
    const report = inspectClusterForMigration(clusterPath)
    const baseName = sanitizeArchiveBaseName(name ? `${name}-${report.clusterName}` : report.clusterName) + (includeMods ? `-${randomUUID().slice(0, 8)}` : '')
    const archivePath = path.join(out, `${baseName}.tar.gz`)
    let inspected: Awaited<ReturnType<typeof inspectMigrationContents>> | undefined
    if (includeMods) {
      if (!modsSource || !fs.existsSync(modsSource)) fail('Mod 来源目录不存在')
      console.log('[export] 包含 Mod：源服务器必须已停止，复制期间变化会导致导出失败')
      const sources = new Map<string, string>()
      for (const entry of fs.readdirSync(modsSource, { withFileTypes: true })) {
        const id = /^(?:workshop-)?([1-9]\d{0,19})$/.exec(entry.name)?.[1]
        if (!id) continue
        if (!entry.isDirectory()) fail(`Mod 来源 ${entry.name} 必须为真实目录`)
        if (sources.has(id)) fail(`Mod ${id} 有两份来源，请整理 --mods-source 目录`)
        sources.set(id, path.join(modsSource, entry.name))
      }
      const master = path.join(clusterPath, 'Master', 'modoverrides.lua')
      const entries = parseModOverridesEntries(fs.existsSync(master) ? master : path.join(clusterPath, 'Caves', 'modoverrides.lua')).filter(entry => !isWorldSeedModId(entry.workshopId))
      const metaFile = path.join(clusterPath, '.gsh-mod-meta.json')
      const dependencies = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Record<string, string[]> : {}
      const mods: MigrationMod[] = entries.map((entry, index) => {
        const dir = sources.get(entry.workshopId)
        const info = dir ? readLocalModInfo(path.join(dir, 'modinfo.lua')) : null
        return { workshopId: entry.workshopId, name: info?.name ?? `workshop-${entry.workshopId}`, enabled: entry.enabled, loadOrder: index, configurationOptions: entry.configurationOptions, dependencyIds: dependencies[entry.workshopId] ?? [], version: info?.version ?? null, localUpdatedAt: null, content: null }
      })
      inspected = await inspectMigrationContents(mods, true, async id => {
        const dir = sources.get(id)
        return dir && fs.existsSync(path.join(dir, 'modinfo.lua')) ? dir : null
      })
      if (!inspected.summary.canExport) fail(`缺少启用项或必要依赖的 Mod 文件：${inspected.summary.missingRequiredMods.join('、')}`)
      const text = buildMigrationReportText(report, { archiveName: path.basename(archivePath) })
        + `\n包含 ${inspected.summary.includedModCount} 个 Mod；禁用且缺文件：${inspected.summary.missingOptionalMods.join('、') || '无'}\n`
      await writeMigrationBundle({ clusterPath, archivePath, reportText: text, inspected, includeMods: true })
    }
    else await createDirectoryArchive(clusterPath, archivePath)
    const digest = await sha256File(archivePath)
    fs.writeFileSync(`${archivePath}.sha256`, `${digest}  ${path.basename(archivePath)}\n`, 'utf8')

    /**
     * 用面板导入侧真正使用的探测函数确认这份包能被识别。
     * 生产端（本脚本）与消费端（面板导入）是两套代码，只靠"看起来对"不够——
     * 导出的包交到客户手里才发现识别不了，返工成本远高于在这里多跑一次只读探测。
     */
    const probe = probeSaveImportSource(clusterPath)
    const probed = probe.result?.candidates[0]
    let reportText = buildMigrationReportText(report, {
      archiveName: path.basename(archivePath),
      importProbe: probe.ok && probed
        ? { ok: true, clusterName: probed.clusterName, dirName: probed.dirName }
        : { ok: false, message: probe.message },
    })
    if (inspected) reportText += `\n包含 ${inspected.summary.includedModCount} 个 Mod；禁用且缺文件：${inspected.summary.missingOptionalMods.join('、') || '无'}\n`
    fs.writeFileSync(path.join(out, `${baseName}.report.txt`), reportText, 'utf8')

    const archiveBytes = fs.statSync(archivePath).size
    console.log(`\n[export] ${report.clusterName}（${report.dirName}）`)
    console.log(`  压缩包：${path.basename(archivePath)}（${formatBytesForReport(archiveBytes)}，源 ${formatBytesForReport(report.totalBytes)}）`)
    console.log(`  sha256：${digest.slice(0, 16)}…（已写入同名 .sha256）`)
    console.log(`  报告：${baseName}.report.txt`)
    if (probe.ok && probed) {
      console.log(`  导入识别自检：通过（房间名「${probed.clusterName ?? '未解析'}」，Mod ${probed.modCount ?? '未知'} 个）`)
    }
    else {
      console.log(`  导入识别自检：**未通过**（${probe.message ?? '未知原因'}）——先人工核对再导入`)
    }
    for (const warning of report.warnings) {
      console.log(`  注意：${warning}`)
    }
  }
  console.log('\n[export] 完成。先核对 .sha256 再上传到面板的「导入存档」。')
}

main().catch((error) => {
  console.error(`[export] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
