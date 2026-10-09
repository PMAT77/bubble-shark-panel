import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import type { InstanceInstallLogPayload } from '../../../../shared/contracts/instance'
import { instanceInstallLogQuerySchema } from '../../../../shared/contracts/instance'
import { getGameInstanceById } from '../../shared/db'
import { readInstallLogTail, resolveInstallLogFilePath } from '../../shared/instance-install/log-store'
import { formatInstallLogContent, summarizeInstallFailure } from '../../shared/instance-install/log-format'
import { sendFileDownload } from '../../shared/http/file-download'
import { businessError, success } from '../../shared/http/response'
import { authorizeInstance } from '../system/auth'
import { getInstallLogsDirPath, getInstanceInstallProgress, isInstallJobActive, mapDbInstallLogStatusToResponse } from './install-service'

export function registerInstanceInstallLogRoutes(app: FastifyInstance) {
  app.get('/app/instance/install-log', async (request) => {
    const query = instanceInstallLogQuerySchema.safeParse(request.query ?? {})
    if (!query.success) return businessError('请求参数无效', request)
    const { id, view } = query.data
    const authorized = await authorizeInstance(request, id, 'instance.install-log:read')
    if (authorized.error) return authorized.error
    const instance = await getGameInstanceById(id)
    if (!instance) return businessError('实例不存在', request)
    const dir = getInstallLogsDirPath()
    const progress = getInstanceInstallProgress(instance)
    const rawAvailable = fs.existsSync(resolveInstallLogFilePath(dir, id))
    // 新日志的摘要只读取小型快照，原始日志按需读取有限尾部。
    const tail = view === 'raw' ? readInstallLogTail(dir, id) : null
    const summary = [instance.lastCommand, instance.lastError].filter(Boolean).join('\n').trim()
    const status = mapDbInstallLogStatusToResponse(instance.installLogStatus, instance.status)
    const legacyFailure = status === 'failed' && instance.lastError ? summarizeInstallFailure(instance.lastError) : null
    const legacySummary = legacyFailure ? `${legacyFailure.message}\n${legacyFailure.advice}`
      : instance.lastCommand || '暂无阶段记录，请展开原始日志查看。'
    const fallback = tail?.content || (isInstallJobActive(id)
      ? '安装任务已启动，等待 SteamCMD 输出...'
      : summary ? `【最近状态摘要，非完整 SteamCMD 输出】\n\n${summary}` : '暂无 SteamCMD 安装输出。')
    // 数据库终态优先，旧快照不会把失败或成功显示成仍在安装。
    if (progress && status !== 'unknown') {
      progress.status = status
      if (status === 'success') { progress.phaseCode = 'complete'; progress.phase = '安装完成' }
      if (status === 'failed' && !progress.failure) progress.failure = summarizeInstallFailure(instance.lastError ?? '安装已中断')
      if (status !== 'running') { progress.percent = null; progress.retryAt = null }
    }
    return success<InstanceInstallLogPayload>({
      content: view === 'summary' ? progress ? '' : legacySummary : formatInstallLogContent(fallback),
      status,
      updatedAt: progress?.updatedAt ?? instance.installLogUpdatedAt ?? instance.updatedAt,
      source: rawAvailable || progress ? 'install_log' : summary ? 'status_summary' : 'empty',
      phase: progress?.phase ?? (instance.status === 'installing' ? instance.lastCommand : null),
      progress,
      rawAvailable,
      rawTruncated: tail?.truncated ?? false,
    }, request)
  })

  app.get('/app/instance/install-log/download', async (request, reply) => {
    const query = instanceInstallLogQuerySchema.safeParse(request.query ?? {})
    if (!query.success) return reply.status(400).send(businessError('请求参数无效', request))
    const { id } = query.data
    const authorized = await authorizeInstance(request, id, 'instance.install-log:read')
    if (authorized.error) return reply.status(403).send(authorized.error)
    const instance = await getGameInstanceById(id)
    if (!instance) return reply.status(404).send(businessError('实例不存在', request))
    const filePath = resolveInstallLogFilePath(getInstallLogsDirPath(), id)
    if (!fs.existsSync(filePath)) return reply.status(404).send(businessError('暂无可下载的安装日志', request))
    return sendFileDownload(reply, { filePath, contentType: 'text/plain; charset=utf-8', fileName: `${instance.name}-install.log` })
  })
}
