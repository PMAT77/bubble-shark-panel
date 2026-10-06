import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { DST_CLUSTER_NAME, DST_CONF_DIR, DST_STORAGE_DIR } from '../../infra/game-adapter/dst/constants'
import { loadServerConfig } from '../../shared/config'
import { createDirectoryArchive, extractArchive, replaceDirectory } from '../../infra/backup/archive'
import {
  getGameInstanceById,
  getSystemBackupSettings,
  createBackupRecord,
  deleteBackupRecord,
  getBackupById,
  listBackupsByKindAsc,
  newBackupId,
  updateBackupStatus,
} from '../../shared/db/index'
import type { DbBackup, DbBackupKind } from '../../shared/db/index'
import { sendInstanceContainerCommand, resolveDefaultInstanceInstallPath } from '../instance/container-lifecycle'
import { InstanceArchiveBusyError, withInstanceArchiveOperationLock } from './archive-lock'

const HOT_SAVE_DELAY_MS = 3000
const RETENTION_KINDS: DbBackupKind[] = ['manual', 'scheduled', 'pre_update', 'pre_delete', 'pre_restore', 'pre_import', 'pre_rollback', 'pre_reset']

function normalizeInstallPath(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

/** 实例存档根目录（klei-storage），DST 世界数据、房间配置与令牌都在其下 */
function resolveKleiStorageRoot(installPath: string): string {
  return path.join(installPath, DST_STORAGE_DIR)
}

function resolveInstanceStorageRoot(instanceId: string, recordedInstallPath: string | null): string {
  const installPath = normalizeInstallPath(recordedInstallPath) || resolveDefaultInstanceInstallPath(instanceId)
  return resolveKleiStorageRoot(installPath)
}

function formatTimestampForFile(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 打包时点的分片结构快照（恢复前用于提示结构差异） */
function snapshotShards(storageRoot: string): string | null {
  const clusterRoot = path.join(storageRoot, DST_CONF_DIR, DST_CLUSTER_NAME)
  const shards: string[] = []
  if (fs.existsSync(path.join(clusterRoot, 'Master'))) {
    shards.push('master')
  }
  if (fs.existsSync(path.join(clusterRoot, 'Caves'))) {
    shards.push('caves')
  }
  return shards.length > 0 ? JSON.stringify(shards) : null
}

export interface CreateInstanceBackupOptions {
  app?: FastifyInstance
  instanceId: string
  /** 缺省 manual；自动钩子传对应来源 */
  kind?: DbBackupKind
  note?: string
  createdBy?: string
  /**
   * 运行中实例打包前是否发送 c_save()（热备份）。
   * manual 缺省 true；自动钩子缺省 false（调用方负责保证实例已停止）。
   */
  saveBeforeArchive?: boolean
  /** 触发后等待游戏落盘的毫秒数，测试可传 0 */
  hotSaveDelayMs?: number
}

export interface CreateInstanceBackupResult {
  ok: boolean
  message?: string
  backup?: DbBackup
}

/**
 * 创建实例存档备份。
 *
 * 打包要遍历整个存档目录，必须与存档导入、恢复互斥：恢复会先把目录改名让位再重建，
 * 此时并发打包会读到半删除的目录，产出不完整的 tar 包却仍被记为成功。
 */
export async function createInstanceBackup(options: CreateInstanceBackupOptions): Promise<CreateInstanceBackupResult> {
  try {
    return await withInstanceArchiveOperationLock(options.instanceId, () => createInstanceBackupUnlocked(options))
  }
  catch (error) {
    if (error instanceof InstanceArchiveBusyError) {
      return { ok: false, message: error.message }
    }
    throw error
  }
}

/**
 * 备份主体，不含存档文件锁。
 * 只供已经在锁内的流程调用（恢复与存档导入的安全备份）；锁不可重入，直接调外层会自锁。
 */
export async function createInstanceBackupUnlocked(options: CreateInstanceBackupOptions, protectedBackupId?: string): Promise<CreateInstanceBackupResult> {
  const {
    app,
    instanceId,
    kind = 'manual',
    note = '',
    createdBy = '',
  } = options
  const saveBeforeArchive = options.saveBeforeArchive ?? kind === 'manual'
  const hotSaveDelayMs = options.hotSaveDelayMs ?? HOT_SAVE_DELAY_MS

  const instance = await getGameInstanceById(instanceId)
  if (!instance) {
    return { ok: false, message: '实例不存在' }
  }
  const storageRoot = resolveInstanceStorageRoot(instanceId, instance.installPath)
  if (!fs.existsSync(storageRoot)) {
    return { ok: false, message: '实例尚未生成存档目录，无法备份（首次启动实例后即可备份）' }
  }

  /**
   * 运行中才谈得上热备份：停止的实例没有可发送命令的进程，直接打包即可。
   * 此前不看状态、对 manual 一律「c_save 失败就报错」，结果是**已停止的实例反而
   * 无法手动备份**，提示还自相矛盾（「可停止实例后重试」，而它已经停止了）；
   * 定时备份与自动钩子本来就是「失败则按最近保存点打包」，这里统一成同一种口径。
   */
  if (saveBeforeArchive && instance.status === 'running') {
    const saveResult = await sendInstanceContainerCommand(instanceId, 'c_save()', 'master')
    if (!saveResult.ok && kind === 'manual') {
      return { ok: false, message: '实例运行中但让世界保存失败，无法创建一致的备份；请稍后重试' }
    }
    if (!saveResult.ok) {
      app?.log.warn({ instanceId, kind }, '自动备份前 c_save 失败，按最近保存点打包')
    }
    // 只有真的保存成功才值得等它落盘，失败时白等 3 秒没有意义
    if (saveResult.ok && hotSaveDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, hotSaveDelayMs))
    }
  }

  const settings = await getSystemBackupSettings()
  const backupsRoot = path.join(loadServerConfig().backupsRoot, instanceId)
  const backupId = newBackupId()
  const fileName = `${formatTimestampForFile(new Date())}-${kind}-${backupId}.tar.gz`
  const targetPath = path.join(backupsRoot, fileName)

  try {
    await createDirectoryArchive(storageRoot, targetPath)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : '打包存档失败'
    try { fs.rmSync(targetPath, { force: true }) }
    catch (cleanupError) { app?.log.warn({ targetPath, error: cleanupError }, '清理未完成备份失败') }
    app?.log.error({ instanceId, targetPath, error: message }, '备份打包失败')
    return { ok: false, message: `备份打包失败: ${message}` }
  }

  let sizeBytes = 0
  try {
    sizeBytes = fs.statSync(targetPath).size
  }
  catch {
    sizeBytes = 0
  }

  const backup = await createBackupRecord({
    id: backupId,
    instanceId,
    filePath: targetPath,
    sizeBytes,
    note,
    kind,
    status: 'completed',
    shards: snapshotShards(storageRoot),
    createdBy,
  })

  await enforceBackupRetention(app, instanceId, settings.perInstanceRetention, [backupId, ...(protectedBackupId ? [protectedBackupId] : [])])
  return { ok: true, backup }
}

/** 保留策略：按创建时间淘汰超出上限的最旧备份（文件删除失败仅保留记录并告警） */
async function enforceBackupRetention(
  app: FastifyInstance | undefined,
  instanceId: string,
  retention: number,
  protectedIds: string[] = [],
): Promise<void> {
  if (retention <= 0) {
    return
  }
  const rows = await listBackupsByKindAsc(instanceId, RETENTION_KINDS)
  if (rows.length <= retention) {
    return
  }
  const excess = rows.filter(row => !protectedIds.includes(row.id)).slice(0, rows.length - retention)
  for (const item of excess) {
    try {
      if (fs.existsSync(item.filePath)) {
        fs.rmSync(item.filePath, { force: true })
      }
      await deleteBackupRecord(item.id)
      app?.log.info({ instanceId, backupId: item.id }, '保留策略淘汰旧备份')
    }
    catch (error) {
      app?.log.warn({ instanceId, backupId: item.id, error }, '淘汰旧备份失败')
    }
  }
}

export interface RestoreInstanceBackupOptions {
  app: FastifyInstance
  backupId: string
}

export interface RestoreInstanceBackupResult {
  ok: boolean
  message?: string
  /** 恢复前自动创建的安全备份（恢复失败时可用它回退） */
  safetyBackup?: DbBackup
}

export async function restoreInstanceBackup(options: RestoreInstanceBackupOptions): Promise<RestoreInstanceBackupResult> {
  const { app, backupId } = options

  const record = await getBackupById(backupId)
  if (!record) {
    return { ok: false, message: '备份记录不存在' }
  }
  if (record.kind === 'database') {
    return { ok: false, message: '数据库快照不支持实例存档恢复流程' }
  }
  if (record.status === 'failed') {
    return { ok: false, message: '该备份创建失败，不可用于恢复' }
  }
  if (!fs.existsSync(record.filePath)) {
    await updateBackupStatus(record.id, 'stale')
    return { ok: false, message: '备份包文件已丢失，无法恢复' }
  }

  const instanceId = record.instanceId
  try {
    return await withInstanceArchiveOperationLock(instanceId, () => restoreInstanceBackupLocked(app, record, instanceId))
  }
  catch (error) {
    if (error instanceof InstanceArchiveBusyError) {
      return { ok: false, message: error.message }
    }
    throw error
  }
}

/** 恢复主体：须在实例存档文件锁内执行（与存档导入互斥） */
async function restoreInstanceBackupLocked(
  app: FastifyInstance,
  record: DbBackup,
  instanceId: string,
): Promise<RestoreInstanceBackupResult> {
  const backupId = record.id
  const instance = await getGameInstanceById(instanceId)
  if (!instance) {
    return { ok: false, message: '实例不存在' }
  }
  if (instance.status === 'running') {
    return { ok: false, message: '实例运行中，必须先停止实例再恢复存档' }
  }

  const storageRoot = resolveInstanceStorageRoot(instanceId, instance.installPath)
  const installPath = path.dirname(storageRoot)

  // 恢复前先给当前存档做一次安全备份（当前无存档则跳过）
  let safetyBackup: DbBackup | undefined
  if (fs.existsSync(storageRoot)) {
    const safety = await createInstanceBackupUnlocked({
      app,
      instanceId,
      kind: 'pre_restore',
      note: `恢复 ${record.createdAt} 备份前的自动安全备份`,
      createdBy: record.createdBy,
      saveBeforeArchive: false,
    }, record.id)
    if (!safety.ok || !safety.backup) {
      return { ok: false, message: safety.message ?? '恢复前安全备份失败，已中止恢复' }
    }
    safetyBackup = safety.backup
  }

  // 解包到与存档同卷的 staging，保证后续目录替换是同卷原子改名
  const stagingRoot = path.join(installPath, `.restore-staging-${Date.now()}`)
  try {
    await extractArchive(record.filePath, stagingRoot)
  }
  catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
    const message = error instanceof Error ? error.message : '解包备份失败'
    app?.log.error({ instanceId, backupId, error: message }, '恢复解包失败')
    return { ok: false, message: `解包备份失败: ${message}` }
  }

  // 包内顶层为 klei-storage；校验结构与存档根对齐
  const prepared = path.join(stagingRoot, DST_STORAGE_DIR)
  if (!fs.existsSync(prepared)) {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
    return { ok: false, message: '备份包结构异常（缺少 klei-storage 顶层目录）' }
  }

  try {
    replaceDirectory(storageRoot, prepared)
  }
  catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
    const message = error instanceof Error ? error.message : '替换存档目录失败'
    app?.log.error({ instanceId, backupId, error: message }, '恢复替换存档失败')
    return { ok: false, message: `替换存档失败: ${message}` }
  }
  fs.rmSync(stagingRoot, { recursive: true, force: true })

  const settings = await getSystemBackupSettings()
  await enforceBackupRetention(app, instanceId, settings.perInstanceRetention, safetyBackup ? [safetyBackup.id] : [])
  app?.log.info({ instanceId, backupId }, '实例存档恢复完成')
  return { ok: true, safetyBackup }
}

export { RETENTION_KINDS }
