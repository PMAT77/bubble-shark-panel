import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { worldMaintenanceOperationSchema, worldMaintenancePayloadSchema, type WorldMaintenanceOperation } from '../../../../shared/contracts/world-maintenance'
import { writeFileAtomic } from '../../infra/game-adapter/dst/atomic-write'
import type { WorldProbeByShard } from '../../infra/game-adapter/dst/maintenance-probe'

const checkpointSchema = worldMaintenanceOperationSchema.extend({
  actorId: z.string(), actorAccount: z.string(), payload: worldMaintenancePayloadSchema,
  baseline: z.record(z.string(), z.any()), commandAttempted: z.boolean(), configChanged: z.boolean(),
  previousSeed: z.string().nullable(),
})
export type MaintenanceCheckpoint = z.infer<typeof checkpointSchema> & { baseline: WorldProbeByShard }
const records = new Map<string, MaintenanceCheckpoint[]>()
const filePath = (installPath: string) => path.join(installPath, '.bsp-world-maintenance.json')
export const isPendingMaintenance = (op: WorldMaintenanceOperation) => ['running', 'awaiting_confirmation'].includes(op.state)
export function maintenanceRecords(installPath: string): MaintenanceCheckpoint[] {
  if (!records.has(installPath)) {
    let loaded: MaintenanceCheckpoint[] = []
    if (fs.existsSync(filePath(installPath))) {
      const raw = fs.readFileSync(filePath(installPath), 'utf8')
      if (raw.length > 4_000_000) throw new Error('世界维护检查点文件过大，已禁止重复执行，请检查该文件')
      // 损坏检查点不能当成没有任务，否则可能重复执行危险命令。
      loaded = z.array(checkpointSchema).parse(JSON.parse(raw)) as MaintenanceCheckpoint[]
    }
    records.set(installPath, loaded)
  }
  return records.get(installPath)!
}
export function persistMaintenance(installPath: string, operation: MaintenanceCheckpoint): void {
  const all = maintenanceRecords(installPath)
  const index = all.findIndex(op => op.id === operation.id)
  if (index < 0) all.push(operation)
  else all[index] = operation
  const retained = all.filter(op => isPendingMaintenance(op) || op.state === 'unknown' || Date.parse(op.updatedAt) > Date.now() - 86400000)
  writeFileAtomic(filePath(installPath), `${JSON.stringify(retained)}\n`)
  records.set(installPath, retained)
}
export function publicMaintenance(op: MaintenanceCheckpoint): WorldMaintenanceOperation {
  return worldMaintenanceOperationSchema.parse(op)
}
/** 只有活动生成任务会阻止旧会话的种子回读；历史 stale 标记可自行恢复。 */
export function generationSeedGuard(installPath: string, shard: 'master' | 'caves', session: string | null): string | null {
  const op = [...maintenanceRecords(installPath)].reverse().find(item => (item.action === 'reset' || item.action === 'regenerate') && item.shards.includes(shard) && (isPendingMaintenance(item) || item.state === 'unknown'))
  if (!op?.commandAttempted || op.baseline[shard]?.sessionId !== session) return null
  return op.state === 'unknown' || (op.deadlineAt && Date.parse(op.deadlineAt) < Date.now())
    ? '未确认生成完成，请查看世界维护操作结果'
    : '世界正在重新生成，稍后会自动更新当前世界种子'
}
export function resetMaintenanceStoreForTest(): void { records.clear() }
