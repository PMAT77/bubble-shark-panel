import type { FastifyInstance, FastifyReply } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import {
  instanceFileContentQuerySchema,
  instanceFileDeletePayloadSchema,
  instanceFileDownloadQuerySchema,
  instanceFileListQuerySchema,
  instanceFileRenamePayloadSchema,
  instanceFileUploadQuerySchema,
  instanceFileWritePayloadSchema,
} from '../../../../shared/contracts/instance-file'
import type {
  InstanceFileContentDto,
  InstanceFileDeleteResult,
  InstanceFileListDto,
  InstanceFileRenameResult,
  InstanceFileUploadResult,
  InstanceFileWriteResult,
  InstanceKeyFileListDto,
} from '../../../../shared/contracts/instance-file'
import { instanceKeyFileListQuerySchema } from '../../../../shared/contracts/instance-file'
import { resolveLocalDstInstance } from '../../shared/dst/local-dst-instance'
import {
  deleteInstancePath,
  backupExistingInstanceFile,
  listInstanceDirectory,
  listInstanceKeyFiles,
  readInstanceTextFile,
  renameInstancePath,
  resolveInstanceDownloadPath,
  resolveInstanceUploadMaxBytes,
  resolveInstanceUploadTarget,
  writeInstanceTextFile,
  writeInstanceUploadFile,
} from '../../infra/game-adapter/dst/instance-files'
import { sendFileDownload } from '../../shared/http/file-download'
import { businessError, success } from '../../shared/http/response'
import { authorizeInstance } from '../system/auth'

const FILE_RESOLVE_MESSAGES = {
  wrongNode: '当前仅支持本地节点实例的文件管理',
  wrongGame: '当前仅支持 DST 实例的文件管理',
  missingInstallPath: '实例安装目录不存在，请先在实例管理中完成安装',
  clusterDirFailed: '无法创建房间配置目录',
}

/**
 * files 模块：实例目录内的文件浏览与文本编辑。
 *
 * 写操作只允许已知文本类型；敏感文件（集群令牌）不提供内容、写入、重命名与删除；
 * 越权与写入动作都记日志，便于回溯谁在什么时候改了哪个文件。
 */
export function registerFilesModule(app: FastifyInstance) {
  const maxUploadBytes = resolveInstanceUploadMaxBytes()
  // 实例文件上传：以原始二进制体接收并流式落盘（与存档导入同一个思路，内容类型刻意区分，
  // 避免与存档导入的解析器冲突）。解析器只把流交给路由，落盘位置由路由决定。
  app.addContentTypeParser('application/x-gsh-instance-file', (_request, payload, done) => {
    done(null, payload)
  })

  app.get('/app/instance/files', async (request): Promise<ApiSuccessResponse<InstanceFileListDto> | ApiErrorResponse> => {
    const query = instanceFileListQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, query.data.instanceId, 'file:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(query.data.instanceId, request, { messages: FILE_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    const relativePath = query.data.path ?? ''
    try {
      const entries = listInstanceDirectory(resolved.instance.installPath, relativePath)
      return success({
        instanceId: resolved.instance.id,
        path: relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
        entries,
      }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '读取目录失败'
      return businessError(message, request)
    }
  })

  app.get('/app/instance/files/key-files', async (request): Promise<ApiSuccessResponse<InstanceKeyFileListDto> | ApiErrorResponse> => {
    const query = instanceKeyFileListQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, query.data.instanceId, 'file:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(query.data.instanceId, request, { messages: FILE_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    return success({
      instanceId: resolved.instance.id,
      files: listInstanceKeyFiles(resolved.instance.installPath),
    }, request)
  })

  app.get('/app/instance/files/content', async (request): Promise<ApiSuccessResponse<InstanceFileContentDto> | ApiErrorResponse> => {
    const query = instanceFileContentQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, query.data.instanceId, 'file:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(query.data.instanceId, request, { messages: FILE_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const file = readInstanceTextFile(resolved.instance.installPath, query.data.path)
      return success({
        instanceId: resolved.instance.id,
        path: query.data.path,
        content: file.content,
        sizeBytes: file.sizeBytes,
        truncated: file.truncated,
        modifiedAt: file.modifiedAt,
      }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '读取文件失败'
      return businessError(message, request)
    }
  })

  app.put('/app/instance/files/content', async (request): Promise<ApiSuccessResponse<InstanceFileWriteResult> | ApiErrorResponse> => {
    const body = instanceFileWritePayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const payload = body.data
    const authorized = await authorizeInstance(request, payload.instanceId, 'file:write')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(payload.instanceId, request, { messages: FILE_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const result = writeInstanceTextFile(resolved.instance.installPath, payload.path, payload.content)
      app.log.info({
        instanceId: resolved.instance.id,
        path: payload.path,
        sizeBytes: result.sizeBytes,
        operator: authorized.context?.user.account ?? '',
      }, '实例文件已写入')
      return success({
        saved: true,
        path: payload.path,
        sizeBytes: result.sizeBytes,
      }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '写入文件失败'
      return businessError(message, request)
    }
  })

  app.post('/app/instance/files/delete', async (request): Promise<ApiSuccessResponse<InstanceFileDeleteResult> | ApiErrorResponse> => {
    const body = instanceFileDeletePayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const payload = body.data
    const authorized = await authorizeInstance(request, payload.instanceId, 'file:delete')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(payload.instanceId, request, { messages: FILE_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const result = deleteInstancePath(resolved.instance.installPath, payload.path)
      app.log.warn({
        instanceId: resolved.instance.id,
        path: payload.path,
        removed: result.removed,
        operator: authorized.context?.user.account ?? '',
      }, '实例文件已删除')
      return success({
        removed: result.removed,
        path: payload.path,
      }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '删除失败'
      return businessError(message, request)
    }
  })

  app.get('/app/instance/files/download', async (request, reply): Promise<void | FastifyReply> => {
    const query = instanceFileDownloadQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      reply.status(400).send(businessError('请求参数无效', request))
      return
    }
    const authorized = await authorizeInstance(request, query.data.instanceId, 'file:download')
    if (authorized.error) {
      reply.status(403).send(authorized.error)
      return
    }
    const resolved = await resolveLocalDstInstance(query.data.instanceId, request, { messages: FILE_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      reply.status(400).send(resolved.error)
      return
    }
    const target = resolveInstanceDownloadPath(resolved.instance.installPath, query.data.path)
    if (!target.ok) {
      reply.status(400).send(businessError(target.message, request))
      return
    }
    const fileName = path.basename(target.absolutePath)
    return sendFileDownload(reply, {
      filePath: target.absolutePath,
      contentType: 'application/octet-stream',
      fileName,
    })
  })

  app.post('/app/instance/files/upload', { bodyLimit: maxUploadBytes }, async (request): Promise<ApiSuccessResponse<InstanceFileUploadResult> | ApiErrorResponse> => {
    const query = instanceFileUploadQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const { instanceId, fileName } = query.data
    const overwrite = query.data.overwrite === '1'
    const authorized = await authorizeInstance(request, instanceId, 'file:upload')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(instanceId, request, { messages: FILE_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    const target = resolveInstanceUploadTarget(
      resolved.instance.installPath,
      query.data.path ?? '',
      fileName,
    )
    if (!target.ok) {
      return businessError(target.message, request)
    }
    if (!overwrite && fs.existsSync(target.absolutePath)) {
      return businessError('同名文件已存在；确认覆盖请重试', request)
    }
    try {
      fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true })
      const backup = backupExistingInstanceFile(target.absolutePath)
      const sizeBytes = await writeInstanceUploadFile(target.absolutePath, request.body as NodeJS.ReadableStream)
      app.log.info({
        instanceId: resolved.instance.id,
        path: target.relativePath,
        sizeBytes,
        overwritten: backup.overwritten,
        operator: authorized.context?.user.account ?? '',
      }, '实例文件已上传')
      return success({
        path: target.relativePath,
        sizeBytes,
        overwritten: backup.overwritten,
      }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '上传失败'
      return businessError(message, request)
    }
  })

  app.post('/app/instance/files/rename', async (request): Promise<ApiSuccessResponse<InstanceFileRenameResult> | ApiErrorResponse> => {
    const body = instanceFileRenamePayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const payload = body.data
    const authorized = await authorizeInstance(request, payload.instanceId, 'file:write')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(payload.instanceId, request, { messages: FILE_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const result = renameInstancePath(resolved.instance.installPath, payload.path, payload.newName)
      app.log.info({
        instanceId: resolved.instance.id,
        path: payload.path,
        nextPath: result.path,
        operator: authorized.context?.user.account ?? '',
      }, '实例文件已重命名')
      return success({ path: result.path }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '重命名失败'
      return businessError(message, request)
    }
  })
}
