import type { FastifyInstance } from 'fastify'
import type { PermissionKey } from '../../../../shared/constants/permissions'
import { worldMaintenancePayloadSchema, worldMaintenanceQuerySchema, worldMaintenanceContinueSchema, type WorldMaintenanceAction } from '../../../../shared/contracts/world-maintenance'
import { listGameInstances } from '../../shared/db'
import { resolveLocalDstInstance } from '../../shared/dst/local-dst-instance'
import { success, businessError } from '../../shared/http/response'
import { authorizeInstance } from '../system/auth'
import { beginWorldMaintenance, continueWorldMaintenance, recoverWorldMaintenance, recheckWorldMaintenance } from './world-maintenance-service'
import { maintenanceRecords, publicMaintenance } from './world-maintenance-store'

export const maintenancePermission: Record<WorldMaintenanceAction, PermissionKey> = {
  save: 'console:command', rollback: 'world:rollback', reset: 'world:reset', regenerate: 'world:reset',
}
export function registerWorldMaintenanceRoutes(app: FastifyInstance): void {
  app.post('/app/instance/world-maintenance', async (request) => {
    const parsed = worldMaintenancePayloadSchema.safeParse(request.body)
    if (!parsed.success) return businessError('世界维护参数无效', request)
    const auth = await authorizeInstance(request, parsed.data.instanceId, maintenancePermission[parsed.data.action])
    if (auth.error || !auth.context) return auth.error
    const resolved = await resolveLocalDstInstance(parsed.data.instanceId, request)
    if (!resolved.ok) return resolved.error
    try {
      recoverWorldMaintenance(app, resolved.instance)
      return success(beginWorldMaintenance({ app, instance: resolved.instance, actor: auth.context.user, payload: parsed.data }), request)
    }
    catch (error) { return businessError(error instanceof Error ? error.message : '无法发起世界维护', request) }
  })
  app.get('/app/instance/world-maintenance', async (request) => {
    const parsed = worldMaintenanceQuerySchema.safeParse(request.query)
    if (!parsed.success) return businessError('请求参数无效', request)
    // 先校验实例授权，再读取检查点；任务状态不依赖控制台读取权限。
    let authorized = await authorizeInstance(request, parsed.data.instanceId, 'world:read')
    if (authorized.error) {
      for (const permission of ['console:command', 'world:rollback', 'world:reset'] as const) {
        authorized = await authorizeInstance(request, parsed.data.instanceId, permission)
        if (!authorized.error) break
      }
    }
    if (authorized.error || !authorized.context) return authorized.error
    const resolved = await resolveLocalDstInstance(parsed.data.instanceId, request)
    if (!resolved.ok) return resolved.error
    try {
      recoverWorldMaintenance(app, resolved.instance)
      const records = maintenanceRecords(resolved.instance.installPath)
      const op = parsed.data.operationId ? records.find(item => item.id === parsed.data.operationId) : [...records].reverse().find(item => item.actorId === authorized.context!.user.id)
      if (!op) return success(null, request)
      const auth = await authorizeInstance(request, parsed.data.instanceId, maintenancePermission[op.action])
      if (auth.error || auth.context?.user.id !== op.actorId) return auth.error ?? businessError('只能查看自己发起的维护操作', request)
      return success(publicMaintenance(op), request)
    }
    catch (error) { return businessError(error instanceof Error ? error.message : '无法读取维护状态', request) }
  })
  app.post('/app/instance/world-maintenance/continue', async (request) => {
    const parsed = worldMaintenanceContinueSchema.safeParse(request.body)
    if (!parsed.success) return businessError('请求参数无效', request)
    let initialAuth = await authorizeInstance(request, parsed.data.instanceId, 'world:reset')
    if (initialAuth.error) initialAuth = await authorizeInstance(request, parsed.data.instanceId, 'world:rollback')
    if (initialAuth.error) return initialAuth.error
    // 最终按原操作权限鉴权；保存/回档账号不需要重置权限。
    const resolved = await resolveLocalDstInstance(parsed.data.instanceId, request)
    if (!resolved.ok) return resolved.error
    try {
      const op = maintenanceRecords(resolved.instance.installPath).find(item => item.id === parsed.data.operationId)
      if (!op) return initialAuth.error ?? businessError('维护操作不存在', request)
      const auth = await authorizeInstance(request, parsed.data.instanceId, maintenancePermission[op.action])
      if (auth.error || auth.context?.user.id !== op.actorId) return auth.error ?? businessError('只能由原操作人确认继续', request)
      return success(continueWorldMaintenance(resolved.instance, op, parsed.data.withoutBackup), request)
    }
    catch (error) { return businessError(error instanceof Error ? error.message : '无法继续维护操作', request) }
  })
  app.post('/app/instance/world-maintenance/verify', async (request) => {
    const parsed = worldMaintenanceQuerySchema.safeParse(request.body)
    if (!parsed.success || !parsed.data.operationId) return businessError('请求参数无效', request)
    let initialAuth = await authorizeInstance(request, parsed.data.instanceId, 'world:reset')
    if (initialAuth.error) initialAuth = await authorizeInstance(request, parsed.data.instanceId, 'world:rollback')
    if (initialAuth.error) return initialAuth.error
    const resolved = await resolveLocalDstInstance(parsed.data.instanceId, request)
    if (!resolved.ok) return resolved.error
    try {
      const op = maintenanceRecords(resolved.instance.installPath).find(item => item.id === parsed.data.operationId)
      if (!op) return businessError('维护操作不存在', request)
      const auth = await authorizeInstance(request, parsed.data.instanceId, maintenancePermission[op.action])
      if (auth.error || auth.context?.user.id !== op.actorId) return auth.error ?? businessError('只能由原操作人重新核验', request)
      return success(recheckWorldMaintenance(app, resolved.instance, op), request)
    }
    catch (error) { return businessError(error instanceof Error ? error.message : '无法重新核验', request) }
  })
  app.addHook('onReady', async () => {
    for (const instance of await listGameInstances()) {
      if (instance.gameCode !== '343050' || instance.nodeId !== 'local-node' || !instance.installPath) continue
      try { recoverWorldMaintenance(app, { ...instance, installPath: instance.installPath }) }
      catch (error) { app.log.error({ instanceId: instance.id, error }, '世界维护检查点恢复失败，禁止自动重发') }
    }
  })
}
