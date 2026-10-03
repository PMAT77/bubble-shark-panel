import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { ModImportCommit, ModImportInspection } from '../../../../shared/contracts/mod'
import { cleanStaleSaveImportUploads, detectArchiveFormat, receiveUploadToTempFile } from '../../infra/backup/upload'
import { extractZipArchive } from '../../infra/backup/zip-extract'
import { inspectContentTree } from '../../infra/game-adapter/dst/mod-content'
import { prepareDstModContent } from '../../infra/game-adapter/dst/mod-content-install'
import { readLocalModInfo, parseStoredModConfig } from '../../infra/game-adapter/dst/mod-config'
import { isWorldSeedModId } from '../../infra/game-adapter/dst/world-seed'
import { assertInstanceRuntimeStopped } from '../../infra/container/instance-stopped'
import { readModDependencyMap, writeModDependencyMap, writeInstanceModFiles } from '../../infra/game-adapter/dst/mod-service'
import { resolveInstanceUploadMaxBytes } from '../../infra/game-adapter/dst/instance-files'
import { getGameInstanceById, getInstanceModByWorkshopId, listInstanceMods, replaceInstanceModRecords } from '../../shared/db/index'
import { withInstanceContentOperation, markContentRecoveryFailed } from '../../shared/instance-content/operation'
import { beginContentTransaction, makeModRecord, protectModConfiguration, rollbackContentSnapshot } from '../../shared/instance-content/state'

const TTL = 60 * 60 * 1000
interface ImportRecord { ownerId: string, instanceId: string, createdAt: number, sourceName: string, sha256: string, modDirectory: string, state?: 'preview' | 'committing' | 'consumed' }
const consuming = new Set<string>()
export function resolveModImportRoot(): string { return path.resolve(process.env.GSH_MOD_IMPORT_ROOT || path.join(os.tmpdir(), 'gsh-mod-import')) }
function positive(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}
export function modImportLimits() {
  return {
    maxArchiveBytes: positive('GSH_MOD_IMPORT_MAX_ARCHIVE_BYTES', resolveInstanceUploadMaxBytes()),
    maxTotalUncompressedBytes: positive('GSH_MOD_IMPORT_MAX_EXTRACTED_BYTES', 1024 ** 3),
    maxEntries: positive('GSH_MOD_IMPORT_MAX_FILES', 50_000),
    maxDepth: positive('GSH_MOD_IMPORT_MAX_DEPTH', 32),
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
  if (record.state && record.state !== 'preview') throw new Error('导入记录已被消费，请重新上传')
  return record
}
function stripMetadata(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.name === '.DS_Store' || entry.name === '__MACOSX') fs.rmSync(file, { recursive: true, force: true })
    else if (entry.isDirectory()) stripMetadata(file)
  }
}
function locateMod(root: string): string {
  if (fs.existsSync(path.join(root, 'modinfo.lua'))) return root
  const entries = fs.readdirSync(root, { withFileTypes: true })
  if (entries.length === 1 && entries[0]?.isDirectory()) {
    const child = path.join(root, entries[0].name)
    if (fs.existsSync(path.join(child, 'modinfo.lua'))) return child
  }
  throw new Error('ZIP 必须包含一个 Mod：根目录或一层外目录中应有 modinfo.lua')
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
    const modDir = locateMod(extract)
    const tree = await inspectContentTree(modDir, { requireModInfo: true, maxBytes: limits.maxTotalUncompressedBytes, maxEntries: limits.maxEntries, maxDepth: limits.maxDepth })
    if (tree.files.filter(file => path.posix.basename(file) === 'modinfo.lua').length !== 1) throw new Error('ZIP 包含多个 Mod，请只上传一个 Mod')
    const info = readLocalModInfo(path.join(modDir, 'modinfo.lua'))
    const idCandidates: ModImportInspection['idCandidates'] = []
    for (const [name, source] of [[path.basename(modDir === extract ? '' : modDir), 'directory'], [sourceName.replace(/\.zip$/i, ''), 'filename']] as const) {
      const id = /^(?:workshop-)?([1-9]\d{0,19})$/.exec(name)?.[1]
      if (id) idCandidates.push({ workshopId: id, source })
    }
    const ids = [...new Set(idCandidates.map(item => item.workshopId))]
    const workshopId = ids.length === 1 ? ids[0]! : null
    const warnings = info.name ? [] : ['Mod 名称未能静态解析，将使用 Workshop ID 作为名称']
    if (!info.version) warnings.push('Mod 版本未能静态解析；Workshop 更新时间为未知')
    if (ids.length > 1) warnings.push('文件名与目录的 Workshop ID 不一致，请确认要安装的 ID')
    const record: ImportRecord = { ownerId, instanceId, createdAt: Date.now(), sourceName, sha256: tree.sha256, modDirectory: path.relative(extract, modDir) }
    fs.writeFileSync(path.join(root, 'record.json'), JSON.stringify(record), { mode: 0o600 })
    return { importId: received.uploadId, workshopId, idCandidates, name: info.name, version: info.version, fileCount: tree.fileCount, sizeBytes: tree.sizeBytes, warnings, existing: workshopId ? Boolean(await getInstanceModByWorkshopId(instanceId, workshopId)) : false }
  }
  catch (error) { fs.rmSync(root, { recursive: true, force: true }); throw error }
}
export function discardLocalMod(importId: string, ownerId: string, instanceId: string): void {
  loadRecord(importId, ownerId, instanceId)
  if (consuming.has(importId)) throw new Error('该导入正在提交')
  fs.rmSync(directory(importId), { recursive: true, force: true })
}

export async function commitLocalMod(input: ModImportCommit, instanceId: string, ownerId: string, installPath: string) {
  return withInstanceContentOperation(instanceId, async () => {
    if (consuming.has(input.importId)) throw new Error('该导入正在提交')
    const record = loadRecord(input.importId, ownerId, instanceId)
    if (isWorldSeedModId(input.workshopId)) throw new Error('此 ID 为面板内置 Mod 保留 ID，不能导入')
    const instance = await getGameInstanceById(instanceId)
    if (!instance || instance.status !== 'stopped') throw new Error('请先停止实例再导入 Mod')
    await assertInstanceRuntimeStopped(instanceId)
    const root = directory(input.importId)
    const source = path.resolve(root, 'extract', record.modDirectory)
    const extract = path.join(root, 'extract')
    if (source !== extract && !source.startsWith(extract + path.sep)) throw new Error('导入记录路径无效')
    const limits = modImportLimits()
    const tree = await inspectContentTree(source, { requireModInfo: true, maxBytes: limits.maxTotalUncompressedBytes, maxEntries: limits.maxEntries, maxDepth: limits.maxDepth })
    if (tree.sha256 !== record.sha256) throw new Error('预览后的 Mod 内容发生变化，请重新上传')
    const mods = await listInstanceMods(instanceId)
    const previous = mods.find(mod => mod.workshopId === input.workshopId)
    if (previous && !input.overwrite) throw new Error('该 Mod 已存在，请明确选择覆盖现有 Mod')
    const transaction = await beginContentTransaction(instanceId, installPath)
    consuming.add(input.importId)
    try {
      fs.writeFileSync(path.join(root, 'record.json'), JSON.stringify({ ...record, state: 'committing' }), { mode: 0o600 })
      const info = readLocalModInfo(path.join(source, 'modinfo.lua'))
      const mod = makeModRecord(instanceId, input.workshopId, {
        ...previous, name: info.name ?? previous?.name ?? `workshop-${input.workshopId}`,
        loadOrder: previous?.loadOrder ?? Math.max(-1, ...mods.map(item => item.loadOrder)) + 1,
        version: info.version, contentSource: 'local', installStatus: 'ready', installError: null,
        localUpdatedAt: null, remoteUpdatedAt: null, updateCheckedAt: null, loadedCopyStale: false,
        retryCount: 0, nextRetryAt: null, updatedAt: new Date().toISOString(),
      })
      const next = [...mods.filter(item => item.workshopId !== input.workshopId), mod]
      await prepareDstModContent(transaction, installPath, mod.workshopId, source)
      transaction.apply()
      protectModConfiguration(transaction, installPath)
      const dependencies = readModDependencyMap(installPath)
      dependencies[mod.workshopId] = info.dependencyIds
      writeModDependencyMap(installPath, dependencies, false)
      writeInstanceModFiles(installPath, next.filter(item => item.installStatus === 'ready').map(item => ({ workshopId: item.workshopId, enabled: item.enabled, loadOrder: item.loadOrder, configurationOptions: parseStoredModConfig(item.config) })), { backup: false })
      replaceInstanceModRecords(instanceId, next)
      fs.writeFileSync(path.join(root, 'record.json'), JSON.stringify({ ...record, state: 'consumed' }), { mode: 0o600 })
      transaction.commit()
      try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* consumed; TTL cleanup later */ }
      return mod
    }
    catch (error) {
      try { transaction.rollback(rollbackContentSnapshot) }
      catch (rollbackError) { markContentRecoveryFailed(instanceId, true); throw new Error(`导入失败且回滚未完成，请重启面板恢复：${String(rollbackError)}`) }
      fs.writeFileSync(path.join(root, 'record.json'), JSON.stringify({ ...record, state: 'preview' }), { mode: 0o600 })
      throw error
    }
    finally { consuming.delete(input.importId) }
  })
}
