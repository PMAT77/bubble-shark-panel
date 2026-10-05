import { readBrandEnv } from '../../../../shared/brand-env'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { ModImportCommit, ModImportSingleCommit, ModImportInspection, ModImportItemInspection, ModImportItemResult } from '../../../../shared/contracts/mod'
import { cleanStaleSaveImportUploads, detectArchiveFormat, receiveUploadToTempFile } from '../../infra/backup/upload'
import { extractZipArchive } from '../../infra/backup/zip-extract'
import { assertWorkshopId, findModDirectories, inspectContentTree } from '../../infra/game-adapter/dst/mod-content'
import { prepareDstModContent } from '../../infra/game-adapter/dst/mod-content-install'
import { readLocalModInfo, parseStoredModConfig } from '../../infra/game-adapter/dst/mod-config'
import { BSP_WORLD_SEED_MOD_ID, isWorldSeedModId } from '../../infra/game-adapter/dst/world-seed'
import { writeFileAtomic } from '../../infra/game-adapter/dst/atomic-write'
import { CONTENT_TRANSACTION_DIRECTORY } from '../../infra/backup/content-transaction'
import { assertInstanceRuntimeStopped } from '../../infra/container/instance-stopped'
import { readModDependencies, readModDependencyMap, writeModDependencyMap, writeInstanceModFiles } from '../../infra/game-adapter/dst/mod-service'
import { resolveInstanceUploadMaxBytes } from '../../infra/game-adapter/dst/instance-files'
import { getGameInstanceById, listInstanceMods, replaceInstanceModRecords } from '../../shared/db/index'
import type { DbInstanceMod } from '../../shared/db/types'
import { withInstanceContentOperation, markContentRecoveryFailed } from '../../shared/instance-content/operation'
import { beginContentTransaction, makeModRecord, protectModConfiguration, rollbackContentSnapshot } from '../../shared/instance-content/state'

const TTL = 60 * 60 * 1000
interface ImportRecordItem { itemId: string, sha256: string, modDirectory: string, installedWorkshopId?: string }
interface ImportRecord {
  ownerId: string, instanceId: string, createdAt: number, sourceName: string,
  archiveSha256?: string, items: ImportRecordItem[], state?: 'preview' | 'committing' | 'consumed'
}
const consuming = new Set<string>()
export function resolveModImportRoot(): string { return path.resolve(readBrandEnv('BSP_MOD_IMPORT_ROOT') || path.join(os.tmpdir(), 'bsp-mod-import')) }
function positive(name: string, fallback: number): number {
  const value = Number(readBrandEnv(name))
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}
export function modImportLimits() {
  return {
    maxArchiveBytes: positive('BSP_MOD_IMPORT_MAX_ARCHIVE_BYTES', resolveInstanceUploadMaxBytes()),
    maxTotalUncompressedBytes: positive('BSP_MOD_IMPORT_MAX_EXTRACTED_BYTES', 1024 ** 3),
    maxEntries: positive('BSP_MOD_IMPORT_MAX_FILES', 50_000),
    maxDepth: positive('BSP_MOD_IMPORT_MAX_DEPTH', 32),
  }
}
function directory(importId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(importId)) throw new Error('导入记录无效，请重新上传')
  return path.join(resolveModImportRoot(), importId)
}
function loadRecord(importId: string, ownerId: string, instanceId: string): ImportRecord {
  let record: ImportRecord
  try { record = JSON.parse(fs.readFileSync(path.join(directory(importId), 'record.json'), 'utf8')) as ImportRecord }
  catch { throw new Error('导入记录已过期或不存在，请重新上传') }
  if (record.ownerId !== ownerId || record.instanceId !== instanceId) throw new Error('导入记录不属于当前用户或实例')
  if (Date.now() - record.createdAt > TTL) throw new Error('导入记录已过期，请重新上传')
  if (record.state === 'committing') throw new Error('上次导入未完成，请重新上传；已安装项会保留')
  if (record.state === 'consumed') throw new Error('导入记录已被消费，请重新上传')
  // 已上传的旧单项预览仍可通过原请求提交。
  if (!record.items) {
    const legacy = record as unknown as { sha256: string, modDirectory: string }
    if (!legacy.sha256 || typeof legacy.modDirectory !== 'string') throw new Error('导入记录无效，请重新上传')
    record.items = [{ itemId: randomUUID(), sha256: legacy.sha256, modDirectory: legacy.modDirectory }]
  }
  return record
}
function saveRecord(root: string, record: ImportRecord): void {
  const file = path.join(root, 'record.json')
  writeFileAtomic(file, JSON.stringify(record))
  fs.chmodSync(file, 0o600)
}
function stripMetadata(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.name === '.DS_Store' || entry.name === '__MACOSX') fs.rmSync(file, { recursive: true, force: true })
    else if (entry.isDirectory()) stripMetadata(file)
  }
}
function contentOptions() {
  const limits = modImportLimits()
  return { maxBytes: limits.maxTotalUncompressedBytes, maxEntries: limits.maxEntries, maxDepth: limits.maxDepth }
}
function itemSource(root: string, item: ImportRecordItem): string {
  const extract = path.join(root, 'extract')
  const source = path.resolve(extract, item.modDirectory)
  if (source !== extract && !source.startsWith(extract + path.sep)) throw new Error('导入记录路径无效')
  return source
}
export async function inspectLocalMod(payload: Readable, instanceId: string, ownerId: string, sourceName: string): Promise<ModImportInspection> {
  cleanStaleSaveImportUploads(TTL, resolveModImportRoot(), consuming)
  const limits = modImportLimits()
  const received = await receiveUploadToTempFile(payload, limits.maxArchiveBytes, resolveModImportRoot())
  if (!received.ok || !received.uploadId || !received.filePath) throw new Error(received.error ?? '上传失败')
  const root = directory(received.uploadId)
  try {
    if (detectArchiveFormat(received.filePath) !== 'zip') throw new Error('本地 Mod 仅支持 ZIP')
    const extract = path.join(root, 'extract')
    await extractZipArchive(received.filePath, extract, limits)
    stripMetadata(extract)
    const archive = await inspectContentTree(extract, contentOptions())
    const directories = findModDirectories(archive.files)
    const existingIds = new Set((await listInstanceMods(instanceId)).map(mod => mod.workshopId))
    const record: ImportRecord = { ownerId, instanceId, createdAt: Date.now(), sourceName, archiveSha256: archive.sha256, items: [] }
    const items: ModImportItemInspection[] = []
    for (const modDirectory of directories) {
      const modDir = path.resolve(extract, modDirectory)
      const tree = await inspectContentTree(modDir, { ...contentOptions(), requireModInfo: true })
      const info = readLocalModInfo(path.join(modDir, 'modinfo.lua'))
      const idCandidates: ModImportItemInspection['idCandidates'] = []
      const names: Array<[string, 'directory' | 'filename']> = [[modDirectory === '.' ? '' : path.basename(modDir), 'directory']]
      if (directories.length === 1) names.push([sourceName.replace(/\.zip$/i, ''), 'filename'])
      for (const [name, source] of names) {
        const id = /^(?:workshop-)?([1-9]\d{0,19})$/.exec(name)?.[1]
        if (id) idCandidates.push({ workshopId: id, source })
      }
      const ids = [...new Set(idCandidates.map(item => item.workshopId))]
      const workshopId = ids.length === 1 ? ids[0]! : null
      const warnings = info.name ? [] : ['Mod 名称未能静态解析，将使用 Workshop ID 作为名称']
      if (!info.version) warnings.push('Mod 版本未能静态解析；Workshop 更新时间为未知')
      if (ids.length > 1) warnings.push('文件名与目录的 Workshop ID 不一致，请确认要安装的 ID')
      const itemId = randomUUID()
      record.items.push({ itemId, sha256: tree.sha256, modDirectory })
      items.push({ itemId, directory: modDirectory, workshopId, idCandidates, name: info.name, version: info.version,
        fileCount: tree.fileCount, sizeBytes: tree.sizeBytes, warnings, existing: workshopId ? existingIds.has(workshopId) : false })
    }
    const outside = archive.fileCount - items.reduce((count, item) => count + item.fileCount, 0)
    const warnings = outside ? [`有 ${outside} 个文件位于 Mod 目录之外，不会安装`] : []
    saveRecord(root, record)
    const single = items.length === 1 ? items[0]! : null
    return { importId: received.uploadId, items, reservedWorkshopIds: [BSP_WORLD_SEED_MOD_ID],
      workshopId: single?.workshopId ?? null, idCandidates: single?.idCandidates ?? [], name: single?.name ?? null,
      version: single?.version ?? null, fileCount: archive.fileCount, sizeBytes: archive.sizeBytes,
      warnings: [...warnings, ...(single?.warnings ?? [])], existing: single?.existing ?? false }
  }
  catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error }
}
export function discardLocalMod(importId: string, ownerId: string, instanceId: string): void {
  loadRecord(importId, ownerId, instanceId)
  if (consuming.has(importId)) throw new Error('该导入正在提交')
  fs.rmSync(directory(importId), { recursive: true, force: true })
}

async function installItem(source: string, workshopId: string, instanceId: string, installPath: string): Promise<{ mod?: DbInstanceMod, error?: string, blocked?: boolean }> {
  let transaction: Awaited<ReturnType<typeof beginContentTransaction>> | undefined
  try {
    const mods = await listInstanceMods(instanceId)
    const previous = mods.find(mod => mod.workshopId === workshopId)
    transaction = await beginContentTransaction(instanceId, installPath)
    const info = readLocalModInfo(path.join(source, 'modinfo.lua'))
    const mod = makeModRecord(instanceId, workshopId, {
      ...previous, name: info.name ?? previous?.name ?? `workshop-${workshopId}`,
      loadOrder: previous?.loadOrder ?? Math.max(-1, ...mods.map(item => item.loadOrder)) + 1,
      version: info.version, contentSource: 'local', installStatus: 'ready', installError: null,
      downloadIntent: null, localUpdatedAt: null, remoteUpdatedAt: null, updateCheckedAt: null, loadedCopyStale: false,
      retryCount: 0, nextRetryAt: null, updatedAt: new Date().toISOString(),
    })
    const next = [...mods.filter(item => item.workshopId !== workshopId), mod]
    await prepareDstModContent(transaction, installPath, workshopId, source)
    transaction.apply()
    protectModConfiguration(transaction, installPath)
    const dependencies = readModDependencyMap(installPath)
    dependencies[workshopId] = info.dependencyIds
    writeModDependencyMap(installPath, dependencies, false)
    writeInstanceModFiles(installPath, next.filter(item => item.installStatus === 'ready').map(item => ({
      workshopId: item.workshopId, enabled: item.enabled, loadOrder: item.loadOrder, configurationOptions: parseStoredModConfig(item.config),
    })), { backup: false })
    replaceInstanceModRecords(instanceId, next)
    transaction.commit()
    return { mod }
  }
  catch (error) {
    try {
      if (transaction) transaction.rollback(rollbackContentSnapshot)
      else if (fs.existsSync(path.join(installPath, CONTENT_TRANSACTION_DIRECTORY))) throw error
    }
    catch (rollbackError) {
      markContentRecoveryFailed(instanceId, true)
      return { error: `导入失败且回滚未完成，请重启面板恢复：${String(rollbackError)}`, blocked: true }
    }
    return { error: error instanceof Error ? error.message : 'Mod 导入失败' }
  }
}

export async function commitLocalMods(input: ModImportCommit, instanceId: string, ownerId: string, installPath: string) {
  return withInstanceContentOperation(instanceId, async () => {
    if (consuming.has(input.importId)) throw new Error('该导入正在提交')
    const record = loadRecord(input.importId, ownerId, instanceId)
    if (!('items' in input) && record.items.length !== 1) throw new Error('ZIP 包含多个 Mod，请使用批量导入')
    const requested = 'items' in input ? input.items : [{ itemId: record.items[0]!.itemId, workshopId: input.workshopId }]
    const byId = new Map(record.items.map(item => [item.itemId, item]))
    const seen = new Set<string>()
    const seenIds = new Set<string>()
    for (const item of requested) {
      assertWorkshopId(item.workshopId)
      if (isWorldSeedModId(item.workshopId)) throw new Error('此 ID 为面板内置 Mod 保留 ID，不能导入')
      const stored = byId.get(item.itemId)
      if (!stored || seen.has(item.itemId)) throw new Error('导入条目无效或重复')
      if (seenIds.has(item.workshopId)) throw new Error(`Workshop ID 重复：${item.workshopId}`)
      if (stored.installedWorkshopId && stored.installedWorkshopId !== item.workshopId) throw new Error('已安装条目不能修改 Workshop ID')
      if (record.items.some(other => other.itemId !== item.itemId && other.installedWorkshopId === item.workshopId)) throw new Error(`Workshop ID 重复：${item.workshopId}`)
      seen.add(item.itemId)
      seenIds.add(item.workshopId)
    }
    if (record.items.some(item => !item.installedWorkshopId && !seen.has(item.itemId))) throw new Error('请提交全部未完成的 Mod')
    const instance = await getGameInstanceById(instanceId)
    if (!instance || instance.status !== 'stopped') throw new Error('请先停止实例再导入 Mod')
    await assertInstanceRuntimeStopped(instanceId)
    const root = directory(input.importId)
    if (record.archiveSha256 && (await inspectContentTree(path.join(root, 'extract'), contentOptions())).sha256 !== record.archiveSha256) {
      throw new Error('预览后的 Mod 内容发生变化，请重新上传')
    }
    const mods = await listInstanceMods(instanceId)
    const pending = record.items.filter(item => !item.installedWorkshopId).map(item => ({
      stored: item, workshopId: requested.find(value => value.itemId === item.itemId)!.workshopId, source: itemSource(root, item),
    }))
    for (const item of pending) {
      if (mods.some(mod => mod.workshopId === item.workshopId) && !input.overwrite) throw new Error('该 Mod 已存在，请明确选择覆盖现有 Mod')
      const tree = await inspectContentTree(item.source, { ...contentOptions(), requireModInfo: true })
      if (tree.sha256 !== item.stored.sha256) throw new Error('预览后的 Mod 内容发生变化，请重新上传')
    }
    const results: ModImportItemResult[] = record.items.filter(item => item.installedWorkshopId).map(item => ({
      itemId: item.itemId, workshopId: item.installedWorkshopId!, status: 'installed', error: null,
    }))
    let retryBlocked = false
    let stopReason: string | null = null
    consuming.add(input.importId)
    try {
      record.state = 'committing'
      saveRecord(root, record)
      for (const item of pending) {
        if (retryBlocked) {
          results.push({ itemId: item.stored.itemId, workshopId: item.workshopId, status: 'not_processed', error: stopReason })
          continue
        }
        const outcome = await installItem(item.source, item.workshopId, instanceId, installPath)
        results.push({ itemId: item.stored.itemId, workshopId: item.workshopId, status: outcome.mod ? 'installed' : 'failed', error: outcome.error ?? null })
        retryBlocked = outcome.blocked ?? false
        if (retryBlocked) stopReason = outcome.error ?? '本次导入已停止，请重新上传'
        if (outcome.mod) item.stored.installedWorkshopId = item.workshopId
        try { saveRecord(root, record) }
        catch { retryBlocked = true; stopReason = '导入进度记录保存失败，已安装内容保留，请重新上传' }
      }
      const installed = results.filter(item => item.status === 'installed').length
      const remaining = record.items.length - installed
      if (!retryBlocked) {
        record.state = remaining ? 'preview' : 'consumed'
        try { saveRecord(root, record) }
        catch { retryBlocked = true; stopReason = '导入进度记录保存失败，已安装内容保留，请重新上传' }
      }
      if (!remaining && !retryBlocked) {
        try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* consumed; TTL cleanup later */ }
      }
      const installedIds = new Set(results.filter(item => item.status === 'installed').map(item => item.workshopId))
      const currentMods = await listInstanceMods(instanceId)
      const installedMods = currentMods.filter(mod => installedIds.has(mod.workshopId))
      const readyIds = new Set(currentMods.filter(mod => mod.installStatus === 'ready').map(mod => mod.workshopId))
      const dependencies = readModDependencyMap(installPath)
      const missing = new Set(installedMods.flatMap(mod => readModDependencies(installPath, mod.workshopId, dependencies)).filter(id => !readyIds.has(id)))
      return { results, installedMods, riskTip: missing.size ? `缺少依赖 ${[...missing].join('、')}，请手动补齐` : null,
        summary: { installed, failed: results.filter(item => item.status === 'failed').length, remaining }, retryBlocked, error: stopReason }
    }
    finally { consuming.delete(input.importId) }
  })
}

/** 保持原单项 service 和 API 的成功返回及失败语义。 */
export async function commitLocalMod(input: ModImportSingleCommit, instanceId: string, ownerId: string, installPath: string): Promise<DbInstanceMod> {
  const result = await commitLocalMods(input, instanceId, ownerId, installPath)
  const mod = result.installedMods[0]
  if (!mod) throw new Error(result.results[0]?.error ?? 'Mod 导入失败')
  return mod
}
