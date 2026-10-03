import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import type { MigrationExportResult } from '../../../../shared/contracts/backup'
import fs from 'node:fs'
import path from 'node:path'
import { ErrorCode } from '../../../../shared/constants/error-code'
import {
  migrationExportRequestSchema,
} from '../../../../shared/contracts/backup'
import { getGameInstanceById } from '../../shared/db/index'
import { sendFileDownload } from '../../shared/http/file-download'
import { businessError, success } from '../../shared/http/response'
import { resolveLocalDstInstance } from '../../shared/dst/local-dst-instance'
import { authorizeInstance } from '../system/auth'
import {
  exportInstanceMigrationPack,
  resolveMigrationExportRoot,
} from './migration-export-service'

/**
 * 迁移包导出路由。
 *
 * 为什么单开两个接口而不是复用备份下载：迁移包不是备份记录——它不进备份列表、
 * 不受备份保留策略淘汰，产物只在面板数据目录下按实例前缀保留 24 小时。
 * 混进 backups 表会让「备份」这个列表里出现一类无法恢复的记录。
 */

/** 文件名来自服务端生成，这里仍然做一次白名单校验：它会被拼进文件路径 */
const ARCHIVE_NAME_PATTERN = /^[^\\/]+\.tar\.gz$/

function resolveArchivePath(fileName: string): string | undefined {
  if (!ARCHIVE_NAME_PATTERN.test(fileName) || fileName.includes('..')) {
    return undefined
  }
  const root = resolveMigrationExportRoot()
  const resolved = path.resolve(root, fileName)
  if (resolved !== path.join(root, fileName)) {
    return undefined
  }
  return resolved
}

export function registerMigrationExportRoutes(app: FastifyInstance): void {
  /**
   * 生成迁移包并直接下载。
   * 实例必须存在、属于本地节点且已完成游戏安装；打包耗时取决于存档大小，前端需关掉请求超时。
   */
  app.post('/app/instance/migration/export', async (request, reply): Promise<void | FastifyReply> => {
    const parsed = migrationExportRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      reply.status(400).send(businessError('请求参数无效', request))
      return
    }
    // 迁移包会把存档整体带走，所以它算"导出"而不只是"读"
    const authorized = await authorizeInstance(request, parsed.data.instanceId, 'instance.migration:export')
    if (authorized.error) {
      reply.status(403).send(authorized.error)
      return
    }
    const resolved = await resolveLocalDstInstance(parsed.data.instanceId, request, {
      // 不在这里创建集群目录：没有房间配置就是「还没开过服」，应当明确拒绝而不是造一个空目录
      ensureClusterDirectory: false,
    })
    if (!resolved.ok) {
      return reply.status(404).send(resolved.error)
    }

    const outcome = await exportInstanceMigrationPack({
      instanceId: resolved.instance.id,
      installPath: resolved.instance.installPath,
      reportOnly: parsed.data.reportOnly,
      includeMods: parsed.data.includeMods,
    })
    if (!outcome.ok) {
      return reply.status(400).send(businessError(outcome.message, request))
    }
    if (!outcome.archivePath) {
      reply.status(400).send(businessError('报告模式下没有可下载的迁移包', request))
      return
    }
    app.log.info({
      instanceId: resolved.instance.id,
      fileName: outcome.fileName,
      sizeBytes: outcome.sizeBytes,
    }, '迁移包导出完成')
    return sendFileDownload(reply, {
      filePath: outcome.archivePath,
      contentType: 'application/gzip',
      fileName: outcome.fileName,
    })
  })

  /** 迁移报告（不打包）：界面先展示风险项，用户确认后再触发导出 */
  app.post('/app/instance/migration/report', async (request): Promise<ApiSuccessResponse<MigrationExportResult> | ApiErrorResponse> => {
    const parsed = migrationExportRequestSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      return businessError('请求参数无效', request)
    }
    // 报告只读：只给"查看迁移报告"权限的账号也能看风险项
    const authorized = await authorizeInstance(request, parsed.data.instanceId, 'instance.migration:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(parsed.data.instanceId, request, {
      ensureClusterDirectory: false,
    })
    if (!resolved.ok) {
      return resolved.error
    }
    const outcome = await exportInstanceMigrationPack({
      instanceId: resolved.instance.id,
      installPath: resolved.instance.installPath,
      reportOnly: true,
      includeMods: parsed.data.includeMods,
    })
    if (!outcome.ok) {
      return businessError(outcome.message, request)
    }
    return success({
      fileName: outcome.fileName,
      sizeBytes: outcome.sizeBytes,
      reportText: outcome.reportText,
      warnings: outcome.warnings,
      packaged: false,
      modContent: outcome.modContent,
    }, request)
  })

  /** 下载已生成的迁移包（导出接口已回传文件流，这里用于失败后重试下载） */
  app.post('/app/instance/migration/download', async (request, reply): Promise<void | FastifyReply> => {
    const body = request.body as { instanceId?: string, fileName?: string } | undefined
    const instanceId = typeof body?.instanceId === 'string' ? body.instanceId.trim() : ''
    const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : ''
    if (!instanceId || !fileName) {
      reply.status(400).send(businessError('请求参数无效', request))
      return
    }
    // 能重下迁移包 = 能拿到整份存档，按导出对待
    const authorized = await authorizeInstance(request, instanceId, 'instance.migration:export')
    if (authorized.error) {
      reply.status(403).send(authorized.error)
      return
    }
    const instance = await getGameInstanceById(instanceId)
    if (!instance) {
      reply.status(404).send(businessError('实例不存在', request))
      return
    }
    const archivePath = resolveArchivePath(fileName)
    if (!archivePath) {
      reply.status(400).send(businessError('迁移包文件名无效', request))
      return
    }
    if (!fs.existsSync(archivePath)) {
      reply.status(404).send(businessError(
        '迁移包已不存在：它只保留 24 小时，请重新导出',
        request,
        ErrorCode.BACKUP_FILE_MISSING,
      ))
      return
    }
    try {
      const owner = JSON.parse(fs.readFileSync(`${archivePath}.owner.json`, 'utf8')) as { instanceId: string }
      if (owner.instanceId !== instanceId || Date.now() - fs.statSync(archivePath).mtimeMs > 24 * 60 * 60 * 1000) {
        return reply.status(403).send(businessError('迁移包不属于该实例或已过期，请重新导出', request))
      }
    }
    catch { return reply.status(403).send(businessError('迁移包归属记录缺失，请重新导出', request)) }
    return sendFileDownload(reply, {
      filePath: archivePath,
      contentType: 'application/gzip',
      fileName,
    })
  })
}
