import type { FastifyInstance } from 'fastify'
import { withInstanceContentActivity } from './operation'
import { businessError } from '../http/response'

/** 覆盖整段 handler 的 await 窗口，避免鉴权与写入之间被内容事务插入。 */
export function registerInstanceContentRouteGuards(app: FastifyInstance): void {
  app.addHook('onRoute', (route) => {
    const modRoute = route.url.startsWith('/app/instances/:instanceId/mods') && !route.url.includes('/import')
    const otherWrite = !['GET', 'HEAD'].includes(String(route.method)) && /^\/app\/instance\/(files|cluster|shards)(\/|$)/.test(route.url)
    const lifecycleWrite = /^\/app\/instance\/(start|restart|update|allocate-ports|delete)$/.test(route.url)
    if (!modRoute && !otherWrite && !lifecycleWrite) return
    const handler = route.handler
    route.handler = async function (request, reply) {
      const params = request.params as { instanceId?: string }
      const body = request.body as { instanceId?: string, id?: string } | undefined
      const query = request.query as { instanceId?: string }
      const id = params?.instanceId ?? body?.instanceId ?? body?.id ?? query?.instanceId
      if (!id) return handler.call(this, request, reply)
      try { return await withInstanceContentActivity(id, async () => handler.call(this, request, reply)) }
      catch (error) { return businessError(error instanceof Error ? error.message : '实例文件操作失败', request) }
    }
  })
}
