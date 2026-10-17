import type { InstanceItem } from '@/api/modules/instance'
import { computed, type Ref } from 'vue'
import { useTaskRowProgress } from '@/composables/useTaskRowProgress'
import { isInstanceInstallingStatus } from '../instanceDisplay'

export function useInstallRowProgress(instances: Ref<InstanceItem[]>) {
  const progress = useTaskRowProgress(computed(() => instances.value.map(row => ({
    id: row.id,
    taskId: row.installTask?.taskId ?? row.installTaskId,
    percent: Math.min(99, row.installTask?.overallPercent ?? row.installPercent ?? 1),
    state: isInstanceInstallingStatus(row.status)
      ? (row.installTask?.phaseCode === 'cancelling' ? 'paused' as const : 'active' as const)
      : row.installLogStatus === 'success' ? 'success' as const : 'inactive' as const,
  }))))
  return { surface: progress.surface, rowProps: (row: InstanceItem) => progress.rowProps(row.id),
    trackAccepted: (id: string, taskId: string) => progress.trackAccepted(id, taskId, 1) }
}