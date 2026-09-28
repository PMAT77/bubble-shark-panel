import type { FastifyInstance } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import type { BackupItem, BackupMutationResult } from '../../../../shared/contracts/backup'
import path from 'node:path'
import process from 'node:process'
import {
  DB_SNAPSHOT_RESTORE_CONFIRM_TEXT,
  dbSnapshotRestoreRequestSchema,
} from '../../../../shared/contracts/backup'
import { ErrorCode } from '../../../../shared/constants/error-code'
import { listBackupsByKindAsc } from '../../shared/db/index'
import { businessError, success } from '../../shared/http/response'
import { resolveAuthorizedContext } from './auth'
import { DB_BACKUP_INSTANCE_ID, createDatabaseSnapshot } from './db-snapshot-service'
import { requestDatabaseRestore } from './db-restore-service'

/**
 * 面板数据库快照路由：创建、列表与恢复。
 * 快照记录 kind=database，由 backup 模块的 list/download/delete 统一管理。
 */
export function registerDatabaseBackupRoutes(app: FastifyInstance) {
  app.post('/app/system/db/backup', async (request): Promise<ApiSuccessResponse<BackupMutationResult> | ApiErrorResponse> => {
    // 面板数据库快照是全局资源（不属于任何实例），所以只要权限点、不要实例授权
    const auth = await resolveAuthorizedContext(request, { permissions: 'backup:create' })
    if (auth.error || !auth.context) {
      return auth.error ?? businessError('登录状态失效，请重新登录', request)
    }

    const result = await createDatabaseSnapshot(app, auth.context.user.account)
    if (!result.ok || !result.backupId) {
      return businessError(result.message ?? '数据库快照创建失败', request, ErrorCode.BACKUP_CREATE_FAILED)
    }
    return success({ isSuccess: true, backupId: result.backupId }, request)
  })

  app.get('/app/system/db/backup', async (request): Promise<ApiSuccessResponse<BackupItem[]> | ApiErrorResponse> => {
    const auth = await resolveAuthorizedContext(request, { permissions: 'backup:read' })
    if (auth.error || !auth.context) {
      return auth.error ?? businessError('登录状态失效，请重新登录', request)
    }
    const rows = await listBackupsByKindAsc(DB_BACKUP_INSTANCE_ID, ['database'])
    return success(rows.reverse().map(record => ({
      id: record.id,
      instanceId: record.instanceId,
      kind: record.kind,
      status: record.status,
      fileName: path.basename(record.filePath),
      sizeBytes: record.sizeBytes,
      note: record.note,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
    })), request)
  })

  /**
   * 用快照恢复面板数据。
   *
   * 这是全站唯一会替换面板自身数据库的操作：服务端先留退路（当前库快照 + 旧库改名保留），
   * 再把新库就位，然后退出进程由部署侧拉起。要求请求体带上确认短语——前端据此让用户
   * 手工输入一次，避免误点。
   */
  app.post('/app/system/db/backup/restore', async (request, reply): Promise<ApiSuccessResponse<BackupMutationResult> | ApiErrorResponse> => {
    // 恢复会把整套面板数据回退，是这里最有破坏力的动作，所以单给 backup:restore
    const auth = await resolveAuthorizedContext(request, { permissions: 'backup:restore' })
    if (auth.error || !auth.context) {
      return auth.error ?? businessError('登录状态失效，请重新登录', request)
    }
    const body = dbSnapshotRestoreRequestSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    if (body.data.confirmText.trim() !== DB_SNAPSHOT_RESTORE_CONFIRM_TEXT) {
      return businessError(`请手工输入「${DB_SNAPSHOT_RESTORE_CONFIRM_TEXT}」以确认`, request)
    }

    const result = await requestDatabaseRestore({
      app,
      backupId: body.data.backupId,
      createdBy: auth.context.user.account,
    })
    if (!result.ok) {
      return businessError(result.message ?? '恢复面板数据失败', request, ErrorCode.BACKUP_RESTORE_FAILED)
    }

    /**
     * 响应发完之后再退出：立刻退出会让前端只看到一次网络中断，拿不到「恢复已开始」的确认。
     * 退出码必须非零——Docker 的 restart 策略与 Native 的 systemd（Restart=on-failure）
     * 才会把面板拉起来；开发环境跑的是 tsx watch，需要手动重启。
     */
    reply.raw.once('finish', () => {
      setTimeout(() => process.exit(1), 200)
    })
    return success({
      isSuccess: true,
      ...(result.preRestoreBackupId ? { backupId: result.preRestoreBackupId } : {}),
    }, request)
  })
}
