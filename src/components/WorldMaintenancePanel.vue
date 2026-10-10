<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NCheckbox, NInput, NInputNumber, NModal, NSpace, useDialog } from 'naive-ui'
import apiShard from '@/api/modules/shard'
import type { ShardSnapshotsDto, ShardSnapshotDto } from '@/api/modules/shard'
import { useWorldMaintenance } from '@/composables/useWorldMaintenance'
import WorldMaintenanceStatus from '@/components/WorldMaintenanceStatus.vue'
const props = defineProps<{ instanceId: string, instanceName: string, running: boolean }>()
const emit = defineEmits<{ refreshed: [], busy: [value: boolean] }>()
const { auth: hasPermission } = useAppAuth()
const canMaintain = computed(() => hasPermission('console:command') || hasPermission('world:rollback') || hasPermission('world:reset'))
const { operation, activeKey, submitting, busy, backupBefore, submit, continueWithoutBackup, recheck } = useWorldMaintenance(() => props.instanceId, canMaintain)
const snapshots = ref<ShardSnapshotsDto | null>(null)
const refreshing = ref(false)
const loadError = ref('')
const steps = ref<number | null>(1)
const resetVisible = ref(false)
const confirmName = ref('')
const dialog = useDialog()
const available = computed(() => snapshots.value?.snapshots.filter(item => item.rollbackSteps !== null) ?? [])
const targetForStep = (n: number) => available.value.find(item => item.rollbackSteps === n)
const isLoading = (key: string) => activeKey.value === key && (submitting.value || operation.value?.state === 'running')
const savedTime = (time: string) => new Date(time).toLocaleString('zh-CN', { hour12: false })
async function refreshSnapshots() {
  if (!props.instanceId || !hasPermission('world:read') || refreshing.value) return
  refreshing.value = true
  loadError.value = ''
  try { snapshots.value = (await apiShard.getShardSnapshots(props.instanceId, 'master')).data }
  catch { snapshots.value = null; loadError.value = '读取存档点失败，请刷新后重试。' }
  finally { refreshing.value = false }
}
function confirmRollback(n: number, key: string) {
  const selected = targetForStep(n)
  if (!selected || busy.value) return
  // 固定确认时的目标对象；刷新列表或自动保存都不会把确认目标偷偷换成另一个。
  const target: ShardSnapshotDto = { ...selected }
  dialog.warning({ title: `确认整个房间回档 ${n} 步？`,
    content: `目标：${target.worldDay === null ? '游戏天数未知' : `第 ${target.worldDay} 天`}，${savedTime(target.savedAt)}，存档点 #${target.snapshotId}。地上和已配置洞穴一起回档，玩家连接可能中断。${backupBefore.value ? '执行前备份已落盘的存档，不额外保存；未保存进度不包含在备份中。' : '本次不创建安全备份。'}`,
    positiveText: '回到此存档点', negativeText: '取消',
    onPositiveClick: () => submit({ action: 'rollback', sessionId: target.sessionId, cavesSessionId: target.cavesSessionId, snapshotId: target.snapshotId }, key) })
}
function openReset() { confirmName.value = ''; resetVisible.value = true }
async function resetRoom() {
  if (confirmName.value.trim() !== props.instanceName.trim() || busy.value) return
  resetVisible.value = false
  await submit({ action: 'reset', confirmName: confirmName.value.trim() }, 'reset')
}
watch(() => [props.instanceId, props.running], () => void refreshSnapshots(), { immediate: true })
watch(busy, value => emit('busy', value), { immediate: true })
watch(() => operation.value?.state, (state, previous) => {
  if (state && ['completed', 'failed', 'unknown', 'cancelled'].includes(state) && previous && state !== previous) {
    void refreshSnapshots(); emit('refreshed')
  }
})
</script>
<template>
  <div class="space-y-3">
    <p class="text-xs text-muted-foreground">保存、回档和重置作用于整个房间。回档按存档点计步，同一天可以有多个存档点。</p>
    <NSpace wrap>
      <NButton v-if="hasPermission('console:command')" size="small" :disabled="!running || busy" :loading="isLoading('save')" @click="submit({ action: 'save' }, 'save')">保存存档</NButton>
      <template v-if="hasPermission('world:rollback')">
        <NButton v-for="n in [1, 2, 3]" :key="n" size="small" :disabled="!running || busy || !targetForStep(n)" :loading="isLoading(`rollback-${n}`)" @click="confirmRollback(n, `rollback-${n}`)">回档 {{ n }} 步</NButton>
      </template>
      <NButton v-if="hasPermission('world:reset')" size="small" type="warning" :disabled="busy" :loading="isLoading('reset')" @click="openReset">重置整个房间</NButton>
    </NSpace>
    <div v-if="hasPermission('world:rollback')" class="flex flex-wrap items-center gap-2">
      <NInputNumber v-model:value="steps" :min="1" :max="Math.max(1, available.length)" :precision="0" size="small" class="w-32" :disabled="busy || !available.length" />
      <span class="text-xs">步</span>
      <NButton size="small" :disabled="!running || busy || !steps || !targetForStep(steps)" :loading="isLoading('rollback-custom')" @click="confirmRollback(steps || 1, 'rollback-custom')">自定义回档</NButton>
    </div>
    <NCheckbox v-if="hasPermission('world:rollback') || hasPermission('world:reset')" v-model:checked="backupBefore" :disabled="busy">执行前自动创建安全备份</NCheckbox>
    <div v-if="hasPermission('world:read')" class="space-y-2">
      <div class="flex flex-wrap gap-2 items-center text-xs">
        <span>已保留 {{ snapshots?.snapshots.length ?? 0 }} 个游戏快照，可整房间回档 {{ available.length }} 步。</span>
        <NButton size="tiny" :loading="refreshing" :disabled="refreshing" @click="refreshSnapshots">刷新存档点</NButton>
      </div>
      <p v-if="loadError" class="text-xs text-rose-500">{{ loadError }}</p>
      <ol v-else-if="snapshots?.snapshots.length" class="max-h-56 overflow-y-auto space-y-1 text-xs">
        <li v-for="item in snapshots.snapshots" :key="item.id" class="rounded border border-border p-2">
          <span>{{ item.rollbackSteps === null ? '不可整房间回档' : `回档 ${item.rollbackSteps} 步` }} · #{{ item.snapshotId }} · {{ item.worldDay === null ? '游戏天数未知' : `第 ${item.worldDay} 天` }} · {{ savedTime(item.savedAt) }}</span>
          <span v-if="snapshots.cavesConfigured"> · 洞穴对应快照{{ item.cavesAvailable ? '可用' : '缺失' }}</span>
          <p v-if="item.unavailableReason" class="text-muted-foreground mt-1">{{ item.unavailableReason }}</p>
        </li>
      </ol>
    </div>
    <WorldMaintenanceStatus :operation="operation" :submitting="submitting" @continue="continueWithoutBackup" @verify="recheck" />
    <NModal v-model:show="resetVisible" preset="card" title="重置整个房间" class="max-w-lg" :mask-closable="false">
      <p class="text-sm mb-3">地上和洞穴将一起重新生成，旧地图、建筑、物品和玩家进度会丢失，旧游戏快照也会删除。保留已保存的生成配置和指定种子；种子为空时随机。玩家连接可能中断。</p>
      <p class="text-sm mb-3">{{ backupBefore ? '执行前创建整个房间的安全备份，失败会暂停。' : '本次不创建安全备份。' }} 相同种子不能恢复玩家进度，地图还受预设、模组与版本影响。</p>
      <NInput v-model:value="confirmName" :placeholder="`请输入实例名称：${instanceName}`" />
      <NSpace justify="end" class="mt-4">
        <NButton @click="resetVisible = false">取消</NButton>
        <NButton type="error" :disabled="busy || !instanceName || confirmName.trim() !== instanceName.trim()" @click="resetRoom">确认重新生成</NButton>
      </NSpace>
    </NModal>
  </div>
</template>
