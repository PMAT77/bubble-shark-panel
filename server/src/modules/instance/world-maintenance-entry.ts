import type { FastifyInstance } from 'fastify'
let start: ((app: FastifyInstance, instanceId: string) => Promise<void>) | null = null
/** 仅由已鉴权的世界维护用例调用；启动仍执行现有端口、资源和生命周期检查。 */
export function registerWorldMaintenanceStart(handler: typeof start): void { start = handler }
export async function startAfterWorldMaintenance(app: FastifyInstance, instanceId: string): Promise<void> {
  if (!start) throw new Error('实例启动用例尚未初始化')
  await start(app, instanceId)
}
