import type { ShardSavePayload, ShardSummaryDto } from '@/api/modules/shard'

/** 表单草稿与服务器基线分开保存；已生成世界的种子不属于普通保存。 */
export interface WorldDraft {
  form: Pick<ShardSavePayload, 'serverPort' | 'steamAuthPort' | 'steamMasterPort' | 'worldgenPreset'>
  rules: Record<string, string>
  worldgen: Record<string, string>
  seed: string
}

export function worldDraftChanged(draft: WorldDraft, saved: WorldDraft | undefined, generated = false, configOnly = false): boolean {
  if (!saved) return false
  const snapshot = (value: WorldDraft) => JSON.stringify(configOnly && generated
    ? { form: value.form, rules: value.rules }
    : value)
  return snapshot(draft) !== snapshot(saved)
}

export function savedWorldDraft(submitted: WorldDraft, previous: WorldDraft, generated: boolean): WorldDraft {
  return {
    form: { ...submitted.form },
    rules: { ...submitted.rules },
    worldgen: { ...(generated ? previous.worldgen : submitted.worldgen) },
    seed: generated ? previous.seed : submitted.seed,
  }
}

/** 重启时自动避让端口：同步未编辑字段，仍保留用户另写的端口草稿。 */
export function refreshWorldPorts(current: WorldDraft['form'], saved: WorldDraft['form'], remote: Pick<ShardSummaryDto, 'serverPort' | 'steamAuthPort' | 'steamMasterPort'>) {
  for (const key of ['serverPort', 'steamAuthPort', 'steamMasterPort'] as const) {
    const value = remote[key]
    if (value == null) continue
    if (current[key] === saved[key]) current[key] = value
    saved[key] = value
  }
}
