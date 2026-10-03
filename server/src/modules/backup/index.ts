import { assertMigrationBundleLayout, readMigrationBundle } from '../../infra/game-adapter/dst/migration-bundle'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import type {
  BackupItem,
  BackupMutationResult,
  BackupRestoreResult,
  SaveImportResult,
} from '../../../../shared/contracts/backup'
import {
  backupCreateRequestSchema,
  backupIdRequestSchema,
  backupListRequestSchema,
  backupRestoreRequestSchema,
  saveImportRequestSchema,
} from '../../../../shared/contracts/backup'
import type { Readable } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { ErrorCode } from '../../../../shared/constants/error-code'
import type { PermissionKey } from '../../../../shared/constants/permissions'
import {
  createBackupRecord,
  deleteBackupRecord,
  getBackupById,
  getGameInstanceById,
  listBackups,
  newBackupId,
  updateBackupStatus,
} from '../../shared/db/index'
import type { DbBackup } from '../../shared/db/index'
import { loadServerConfig } from '../../shared/config'
import { sendFileDownload } from '../../shared/http/file-download'
import { businessError, success } from '../../shared/http/response'
import { authorizeInstance, requirePermission, resolveAuthorizedContext, resolveInstanceScope } from '../system/auth'
import { DB_BACKUP_INSTANCE_ID, formatTimestampForFile } from '../system/db-snapshot-service'
import { resolveMigrationsFolder } from '../system/db-restore-service'
import { verifyPanelDatabaseFile } from '../system/db-snapshot-verify'
import { createInstanceBackup, restoreInstanceBackup } from './backup-service'
import { isInsideBackupsRoot } from './backup-ops'
import { importSaveToInstance, probeSaveImportSource } from './import-service'
import {
  cleanStaleSaveImportUploads,
  readUploadSourceName,
  receiveUploadToTempFile,
  removeUploadDirectory,
  resolveMaxUploadBytes,
  resolveUploadDirectory,
  sanitizeUploadFileName,
  unpackSaveImportArchive,
  validateUploadClusterPath,
  writeUploadMeta,
} from './upload-service'
import type { ReceiveUploadResult } from './upload-service'

function toBackupItem(record: DbBackup): BackupItem {
  return {
    id: record.id,
    instanceId: record.instanceId,
    kind: record.kind,
    status: record.status,
    fileName: path.basename(record.filePath),
    sizeBytes: record.sizeBytes,
    note: record.note,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
  }
}

interface BackupAuth {
  error?: ApiErrorResponse
  operatorAccount: string
}

async function authorize(
  request: FastifyRequest,
  permission: PermissionKey = 'backup:read',
): Promise<BackupAuth> {
  const auth = await resolveAuthorizedContext(request, { permissions: permission })
  if (auth.error || !auth.context) {
    return { error: auth.error ?? businessError('登录状态失效，请重新登录', request), operatorAccount: '' }
  }
  return { operatorAccount: auth.context.user.account }
}

/**
 * 备份资源的实例归属校验。
 *
 * 面板数据库快照（哨兵实例 id）是面板全局资源、不属于任何实例，因此跳过实例授权，
 * 只要求权限点——它本来就该由拥有面板管理权限的人操作。
 *
 * download / delete / restore 都是**先按 backupId 查到记录、再用记录里的 instanceId
 * 校验**：这三个接口原先只看"有没有 ops:manage"，等于任何持有该权限的账号都能下载、
 * 删除、恢复别人实例的存档。
 */
async function authorizeBackupInstance(
  request: FastifyRequest,
  instanceId: string,
  permission: PermissionKey,
): Promise<ApiErrorResponse | undefined> {
  if (instanceId === DB_BACKUP_INSTANCE_ID) {
    return requirePermission(request, permission)
  }
  const authorized = await authorizeInstance(request, instanceId, permission)
  return authorized.error
}

/**
 * backup 模块：实例存档备份与恢复、备份文件管理。
 * 存档备份覆盖 klei-storage（世界数据、房间配置、集群令牌），
 * 数据库快照（kind=database）由 system 模块创建、此处统一管理。
 */
export function registerBackupModule(app: FastifyInstance) {
  const maxUploadBytes = resolveMaxUploadBytes()
  // 存档导入上传：以原始二进制体接收（前端固定 application/octet-stream），流式落盘控制内存占用
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    void receiveUploadToTempFile(payload as Readable, maxUploadBytes).then((received) => {
      done(null, received)
    })
  })

  app.post('/app/instance/backup/create', async (request): Promise<ApiSuccessResponse<BackupMutationResult> | ApiErrorResponse> => {
    const body = backupCreateRequestSchema.safeParse(request.body)
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, body.data.instanceId, 'backup:create')
    if (authorized.error) {
      return authorized.error
    }
    const auth = await authorize(request, 'backup:create')
    if (auth.error) {
      return auth.error
    }
    const result = await createInstanceBackup({
      app,
      instanceId: body.data.instanceId,
      kind: 'manual',
      note: body.data.note ?? '',
      createdBy: auth.operatorAccount,
    })
    if (!result.ok || !result.backup) {
      return businessError(result.message ?? '备份创建失败', request, ErrorCode.BACKUP_CREATE_FAILED)
    }
    return success({ isSuccess: true, backupId: result.backup.id }, request)
  })

  app.post('/app/instance/backup/list', async (request): Promise<ApiSuccessResponse<BackupItem[]> | ApiErrorResponse> => {
    const scope = await resolveInstanceScope(request, 'backup:read')
    if (scope.error || !scope.instanceIds) {
      return scope.error ?? businessError('无法确定可见实例范围', request)
    }
    const body = backupListRequestSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    /**
     * 面板数据库快照（instanceId 为哨兵值 panel-db）不属于任何实例，有独立的接口与列表，
     * 这里必须排除：否则「备份与恢复」页上方那张实例存档表会把同一条快照再列一遍，
     * 用户看到的是「面板快照」混在一堆实例存档里、且与下方区块重复。
     */
    const visible = new Set(scope.instanceIds)
    const records = (await listBackups(body.data.instanceId))
      .filter(record => record.instanceId !== DB_BACKUP_INSTANCE_ID)
      .filter(record => visible.has(record.instanceId))
    const items: BackupItem[] = []
    for (const record of records) {
      // 磁盘对账：文件丢失的已完成备份标记 stale
      if (record.status === 'completed' && !fs.existsSync(record.filePath)) {
        await updateBackupStatus(record.id, 'stale')
        items.push(toBackupItem({ ...record, status: 'stale' }))
        continue
      }
      items.push(toBackupItem(record))
    }
    return success(items, request)
  })

  app.post('/app/instance/backup/download', async (request, reply): Promise<void | FastifyReply> => {
    const body = backupIdRequestSchema.safeParse(request.body)
    if (!body.success) {
      reply.status(400).send(businessError('请求参数无效', request))
      return
    }
    const record = await getBackupById(body.data.backupId)
    if (!record) {
      reply.status(404).send(businessError('备份记录不存在', request, ErrorCode.BACKUP_NOT_FOUND))
      return
    }
    const authorized = await authorizeBackupInstance(request, record.instanceId, 'backup:read')
    if (authorized) {
      reply.status(403).send(authorized)
      return
    }
    if (!isInsideBackupsRoot(record.filePath)) {
      reply.status(400).send(businessError('备份路径异常，已拒绝下载', request))
      return
    }
    if (!fs.existsSync(record.filePath)) {
      await updateBackupStatus(record.id, 'stale')
      reply.status(404).send(businessError('备份包文件已丢失', request, ErrorCode.BACKUP_FILE_MISSING))
      return
    }
    const fileName = path.basename(record.filePath)
    return sendFileDownload(reply, {
      filePath: record.filePath,
      contentType: record.kind === 'database' ? 'application/x-sqlite3' : 'application/gzip',
      fileName,
    })
  })

  app.post('/app/instance/backup/delete', async (request): Promise<ApiSuccessResponse<BackupMutationResult> | ApiErrorResponse> => {
    const body = backupIdRequestSchema.safeParse(request.body)
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const record = await getBackupById(body.data.backupId)
    if (!record) {
      return businessError('备份记录不存在', request, ErrorCode.BACKUP_NOT_FOUND)
    }
    const authorized = await authorizeBackupInstance(request, record.instanceId, 'backup:delete')
    if (authorized) {
      return authorized
    }
    // 与实例删除同序：先删记录再删文件，文件删除失败仅告警（记录已删，下次列表自然消失）
    await deleteBackupRecord(record.id)
    if (isInsideBackupsRoot(record.filePath) && fs.existsSync(record.filePath)) {
      try {
        fs.rmSync(record.filePath, { force: true })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : '删除备份文件失败'
        app.log.warn({ backupId: record.id, error: message }, '备份记录已删除，但文件清理失败，请手动处理')
      }
    }
    return success({ isSuccess: true, backupId: record.id }, request)
  })

  app.post('/app/instance/backup/restore', async (request): Promise<ApiSuccessResponse<BackupRestoreResult> | ApiErrorResponse> => {
    const body = backupRestoreRequestSchema.safeParse(request.body)
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const record = await getBackupById(body.data.backupId)
    if (!record) {
      return businessError('备份记录不存在', request, ErrorCode.BACKUP_NOT_FOUND)
    }
    const authorized = await authorizeBackupInstance(request, record.instanceId, 'backup:restore')
    if (authorized) {
      return authorized
    }
    const instance = await getGameInstanceById(record.instanceId)
    if (!instance) {
      return businessError('实例不存在', request, ErrorCode.BACKUP_NOT_FOUND)
    }
    if (instance.status === 'running') {
      return businessError('实例运行中，必须先停止实例再恢复存档', request, ErrorCode.BACKUP_REQUIRES_STOPPED)
    }
    const result = await restoreInstanceBackup({ app, backupId: record.id })
    if (!result.ok) {
      return businessError(result.message ?? '恢复失败', request, ErrorCode.BACKUP_RESTORE_FAILED)
    }
    return success({
      isSuccess: true,
      safetyBackupId: result.safetyBackup?.id,
    }, request)
  })
  /** 接收本地上传的存档压缩包（zip / tar.gz），解压后识别集群候选（只读识别，不导入） */
  app.post('/app/instance/backup/import/upload', { bodyLimit: maxUploadBytes }, async (request, reply): Promise<void> => {
    // 上传阶段还没有目标实例（先上传识别、再选实例导入），所以只校验权限点
    const auth = await authorize(request, 'backup:import')
    if (auth.error) {
      reply.status(401).send(auth.error)
      return
    }
    const received = request.body as ReceiveUploadResult | undefined
    if (!received?.ok || !received.uploadId || !received.filePath) {
      reply.status(received?.tooLarge === true ? 413 : 400).send(businessError(received?.error ?? '存档包上传失败', request, ErrorCode.BACKUP_IMPORT_UPLOAD_INVALID))
      return
    }
    // 上传时顺手清理过期记录（进程长期运行、上传后放弃导入的兜底）
    cleanStaleSaveImportUploads()
    const query = request.query as { fileName?: string }
    const sourceName = sanitizeUploadFileName(query.fileName)
    const uploadDir = resolveUploadDirectory(received.uploadId)
    writeUploadMeta(uploadDir, sourceName)
    const extractDir = path.join(uploadDir, 'extract')
    try {
      await unpackSaveImportArchive(received.filePath, extractDir)
    }
    catch (error) {
      removeUploadDirectory(received.uploadId)
      const message = error instanceof Error ? error.message : '存档包解压失败'
      reply.status(400).send(businessError(`存档包解压失败：${message}`, request, ErrorCode.BACKUP_IMPORT_UPLOAD_INVALID))
      return
    }
    const probed = probeSaveImportSource(extractDir)
    if (!probed.ok || !probed.result) {
      removeUploadDirectory(received.uploadId)
      reply.status(400).send(businessError(probed.message ?? '未在压缩包中找到存档', request, ErrorCode.BACKUP_IMPORT_SOURCE_INVALID))
      return
    }
    try {
      assertMigrationBundleLayout(extractDir, probed.result.candidates.map(candidate => candidate.clusterPath))
      for (const candidate of probed.result.candidates) {
        const bundle = await readMigrationBundle(candidate.clusterPath)
        if (bundle) {
          candidate.modCount = bundle.manifest.mods.length
          candidate.migration = {
            includeMods: bundle.manifest.includeMods,
            includedModCount: bundle.manifest.mods.filter(mod => mod.content).length,
            missingModIds: bundle.manifest.mods.filter(mod => !mod.content).map(mod => mod.workshopId),
          }
        }
      }
    }
    catch (error) {
      removeUploadDirectory(received.uploadId)
      return reply.status(400).send(businessError(error instanceof Error ? error.message : '迁移包校验失败', request, ErrorCode.BACKUP_IMPORT_UPLOAD_INVALID))
    }
    return reply.send(success({
      uploadId: received.uploadId,
      sourceName,
      sourcePath: probed.result.sourcePath,
      candidates: probed.result.candidates,
      warnings: probed.result.warnings,
    }, request))
  })
  /** 导入上传的外部 Klei 集群存档到指定实例（要求实例已停止且已完成游戏安装） */
  app.post('/app/instance/backup/import', async (request): Promise<ApiSuccessResponse<SaveImportResult> | ApiErrorResponse> => {
    const body = saveImportRequestSchema.safeParse(request.body)
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, body.data.instanceId, 'backup:import')
    if (authorized.error) {
      return authorized.error
    }
    const auth = await authorize(request, 'backup:import')
    if (auth.error) {
      return auth.error
    }
    // 源目录必须来自本会话上传的解压产物（防路径穿越与伪造源路径）
    const validated = validateUploadClusterPath(body.data.uploadId, body.data.sourceClusterPath)
    if (!validated.ok) {
      return businessError(validated.message, request, ErrorCode.BACKUP_IMPORT_UPLOAD_INVALID)
    }
    const result = await importSaveToInstance({
      app,
      instanceId: body.data.instanceId,
      sourceClusterPath: validated.clusterPath,
      sourceLabel: readUploadSourceName(resolveUploadDirectory(body.data.uploadId)),
      clusterToken: body.data.clusterToken,
      createdBy: auth.operatorAccount,
    })
    if (!result.ok || !result.result) {
      // 导入失败保留上传记录供重试，由过期清理兜底
      return businessError(result.message ?? '存档导入失败', request, ErrorCode.BACKUP_IMPORT_FAILED)
    }
    // 导入成功后清理上传记录（压缩包本体 + 解压目录）
    removeUploadDirectory(body.data.uploadId)
    return success(result.result, request)
  })

  /**
   * 导入外部的面板数据库快照（.sqlite）。
   *
   * 只入库、不自动恢复：快照一旦生效就是整套面板数据回退，必须由用户在列表里确认后
   * 再单独点「恢复」。放在 backup 模块是因为这里已经注册了 octet-stream 的接收器与
   * 临时目录，另起一套只会多出一份相似但细节不同的上传实现。
   */
  app.post('/app/system/db/backup/import', { bodyLimit: maxUploadBytes }, async (request, reply): Promise<void> => {
    // 面板数据库快照是全局资源（不属于任何实例），只需权限点
    const auth = await authorize(request, 'backup:import')
    if (auth.error) {
      reply.status(401).send(auth.error)
      return
    }
    const received = request.body as ReceiveUploadResult | undefined
    if (!received?.ok || !received.filePath) {
      reply.status(received?.tooLarge === true ? 413 : 400).send(businessError(received?.error ?? '快照上传失败', request, ErrorCode.BACKUP_IMPORT_UPLOAD_INVALID))
      return
    }
    const uploadId = received.uploadId ?? ''
    const verified = verifyPanelDatabaseFile(received.filePath, resolveMigrationsFolder())
    if (!verified.ok) {
      removeUploadDirectory(uploadId)
      reply.status(400).send(businessError(verified.message ?? '快照校验未通过', request, ErrorCode.BACKUP_IMPORT_SOURCE_INVALID))
      return
    }

    const query = request.query as { fileName?: string }
    const sourceName = sanitizeUploadFileName(query.fileName)
    const dbDir = path.join(loadServerConfig().backupsRoot, 'db')
    fs.mkdirSync(dbDir, { recursive: true })
    const targetPath = path.join(dbDir, `db-${formatTimestampForFile(new Date())}-${Math.random().toString(36).slice(2, 8)}.sqlite`)
    try {
      // 上传临时目录在系统 temp 下，与备份目录多半不同卷，因此不用 rename（会 EXDEV）
      fs.copyFileSync(received.filePath, targetPath)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      removeUploadDirectory(uploadId)
      reply.status(400).send(businessError(`保存快照失败：${message}`, request, ErrorCode.BACKUP_IMPORT_FAILED))
      return
    }
    removeUploadDirectory(uploadId)

    let sizeBytes = 0
    try {
      sizeBytes = fs.statSync(targetPath).size
    }
    catch {
      sizeBytes = 0
    }
    const record = await createBackupRecord({
      id: newBackupId(),
      instanceId: DB_BACKUP_INSTANCE_ID,
      filePath: targetPath,
      sizeBytes,
      note: `导入自 ${sourceName}`,
      kind: 'database',
      status: 'completed',
      createdBy: auth.operatorAccount,
    })
    app.log.info({ backupId: record.id, sourceName, sizeBytes }, '外部面板数据库快照已导入')
    return reply.send(success({ isSuccess: true, backupId: record.id }, request))
  })
}
