import { AsyncLocalStorage } from 'node:async_hooks'

/** 同一个内部调用链可升级为独占；其他请求/后台任务仍然互斥。 */
const context = new AsyncLocalStorage<symbol>()
const exclusive = new Map<string, symbol>()
const activities = new Map<string, Map<symbol, number>>()
const recoveryFailures = new Set<string>()
const cleanupFailures = new Set<string>()

export function markInstanceContentCleanupPending(id: string, pending: boolean) {
  if (pending) cleanupFailures.add(id)
  else cleanupFailures.delete(id)
}

export class InstanceContentBusyError extends Error {
  constructor() { super('该实例正在执行文件操作、启动或下载，请稍后再试'); this.name = 'InstanceContentBusyError' }
}
export function assertInstanceContentAvailable(instanceId: string): void {
  if (cleanupFailures.has(instanceId)) throw new Error('安装任务清理未完成，已禁止启动和写入；请恢复运行环境后再次停止实例')
  if (recoveryFailures.has(instanceId)) throw new Error('实例存在未完成的内容恢复，已禁止启动和写入；请保留 .bsp-content-transaction 目录并修复权限或日志后重启面板')
  if (exclusive.has(instanceId) && exclusive.get(instanceId) !== context.getStore()) throw new InstanceContentBusyError()
}
export function markContentRecoveryFailed(instanceId: string, failed: boolean): void {
  if (failed) recoveryFailures.add(instanceId)
  else recoveryFailures.delete(instanceId)
}
export function hasContentRecoveryFailure(instanceId: string): boolean { return recoveryFailures.has(instanceId) }
export function beginInstanceContentActivity(instanceId: string): () => void {
  assertInstanceContentAvailable(instanceId)
  const owner = context.getStore() ?? Symbol('instance activity')
  const owners = activities.get(instanceId) ?? new Map<symbol, number>()
  owners.set(owner, (owners.get(owner) ?? 0) + 1)
  activities.set(instanceId, owners)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (owners.get(owner) ?? 1) - 1
    if (remaining) owners.set(owner, remaining)
    else owners.delete(owner)
    if (!owners.size) activities.delete(instanceId)
  }
}
export async function withInstanceContentActivity<T>(instanceId: string, action: () => Promise<T>): Promise<T> {
  return context.run(context.getStore() ?? Symbol('instance request'), async () => {
    const release = beginInstanceContentActivity(instanceId)
    try { return await action() } finally { release() }
  })
}
export async function withInstanceContentOperation<T>(instanceId: string, action: () => Promise<T>): Promise<T> {
  return context.run(context.getStore() ?? Symbol('content transaction'), async () => {
    const owner = context.getStore()!
    assertInstanceContentAvailable(instanceId)
    if ([...(activities.get(instanceId)?.keys() ?? [])].some(token => token !== owner)) throw new InstanceContentBusyError()
    if (exclusive.has(instanceId)) throw new InstanceContentBusyError()
    exclusive.set(instanceId, owner)
    try { return await action() } finally { exclusive.delete(instanceId) }
  })
}
