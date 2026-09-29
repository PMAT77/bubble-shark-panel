<script setup lang="ts">
/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()

import type { ShardId, ShardSnapshotDto } from '@/api/modules/shard'
import {
  NAlert,
  NButton,
  NEmpty,
  NInput,
  NInputNumber,
  NModal,
  NSpin,
  useDialog,
  useMessage,
} from 'naive-ui'
import { computed, ref, watch } from 'vue'
import apiShard from '@/api/modules/shard'

const props = defineProps<{
  instanceId: string
  shard: ShardId
  instanceName: string
}>()

defineOptions({
  name: 'DstWorldMaintenanceCard',
})

const dialog = useDialog()
const message = useMessage()

const loading = ref(false)
const busy = ref(false)
const loadError = ref<string | null>(null)
const running = ref(false)
const maxSnapshots = ref(6)
const snapshots = ref<ShardSnapshotDto[]>([])
const warnings = ref<string[]>([])
const rollbackSteps = ref(1)

const resetModalVisible = ref(false)
const resetConfirmName = ref('')

const shardLabel = computed(() => props.shard === 'master' ? '地上世界' : '洞穴世界')
const resetConfirmMatched = computed(() => resetConfirmName.value.trim() === props.instanceName.trim())

function formatSavedAt(value: string): string {
  if (!value) {
    return '时间未知'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '时间未知'
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}

async function loadSnapshots() {
  if (!props.instanceId) {
    return
  }
  loading.value = true
  loadError.value = null
  try {
    const { data } = await apiShard.getShardSnapshots(props.instanceId, props.shard)
    running.value = data.running
    maxSnapshots.value = data.maxSnapshots
    snapshots.value = data.snapshots
    warnings.value = data.warnings
    if (rollbackSteps.value > data.maxSnapshots) {
      rollbackSteps.value = data.maxSnapshots
    }
  }
  catch {
    loadError.value = '读取存档点失败，请确认实例已安装后重试。'
    snapshots.value = []
    warnings.value = []
  }
  finally {
    loading.value = false
  }
}

/** 把后端返回的安全备份结果转成用户能看懂的一句反馈 */
function reportMaintenanceResult(result: { command: string, backupId: string | null, backupWarning: string | null }, doneText: string) {
  if (result.backupWarning) {
    message.warning(`${doneText}，但${result.backupWarning}`)
    return
  }
  const backupText = result.backupId ? '，已创建回档前的安全备份' : ''
  message.success(`${doneText}${backupText}（命令 ${result.command}）`)
}

async function submitRollback() {
  if (busy.value) {
    return
  }
  busy.value = true
  try {
    const { data } = await apiShard.rollbackShard({
      instanceId: props.instanceId,
      shard: props.shard,
      steps: rollbackSteps.value,
    })
    reportMaintenanceResult(data, `已下发回档命令，${shardLabel.value}将回退 ${rollbackSteps.value} 步`)
  }
  catch {
    message.error('回档命令下发失败，请确认实例正在运行。')
  }
  finally {
    busy.value = false
  }
}

function confirmRollback() {
  dialog.warning({
    title: `确认回档 ${rollbackSteps.value} 步？`,
    content: `将把${shardLabel.value}回退到 ${rollbackSteps.value} 个存档点之前，期间进度会丢失。回档前会自动创建一份安全备份，之后可以在「备份与恢复」里翻回。`,
    positiveText: '确认回档',
    negativeText: '取消',
    onPositiveClick: () => {
      void submitRollback()
    },
  })
}

async function submitResetWorld() {
  if (busy.value || !resetConfirmMatched.value) {
    return
  }
  busy.value = true
  try {
    const { data } = await apiShard.resetShardWorld({
      instanceId: props.instanceId,
      shard: props.shard,
      confirmName: resetConfirmName.value.trim(),
    })
    resetModalVisible.value = false
    resetConfirmName.value = ''
    reportMaintenanceResult(data, `已下发重置世界命令，${shardLabel.value}将重新生成地图`)
    await loadSnapshots()
  }
  catch {
    message.error('重置世界命令下发失败：请确认实例正在运行，且实例名称输入正确。')
  }
  finally {
    busy.value = false
  }
}

watch(() => [props.instanceId, props.shard], () => {
  resetModalVisible.value = false
  resetConfirmName.value = ''
  void loadSnapshots()
}, { immediate: true })
</script>

<template>
  <div class="mt-2">
    <NAlert v-if="!running" type="info" :bordered="false" class="mb-3">
      实例未运行：回档与重置世界需要服务器正在运行才能下发命令。
    </NAlert>

    <NSpin :show="loading">
      <p v-if="loadError" class="text-sm text-rose-600 dark:text-rose-400">{{ loadError }}</p>

      <template v-else>
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <span class="text-sm">
            {{ shardLabel }}可用存档点：<strong>{{ snapshots.length }}</strong> 个
          </span>
          <span class="text-xs text-muted-foreground">
            房间设置里的快照保留数量为 {{ maxSnapshots }}，决定回档可用的步数上限
          </span>
          <NButton size="tiny" :loading="loading" @click="loadSnapshots">
            刷新
          </NButton>
        </div>

        <p v-for="item in warnings" :key="item" class="mb-2 text-xs text-amber-600 dark:text-amber-400">
          {{ item }}
        </p>

        <NEmpty v-if="snapshots.length === 0" size="small" description="还没有可用的存档点" />
        <ul v-else class="mb-4 flex flex-col gap-1">
          <li
            v-for="(item, index) in snapshots"
            :key="item.id"
            class="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm"
          >
            <span>第 {{ index + 1 }} 近的存档点</span>
            <span class="text-muted-foreground">{{ formatSavedAt(item.savedAt) }}</span>
          </li>
        </ul>

        <div class="rounded-lg border p-3">
          <p class="mb-2 text-sm font-medium">回档</p>
          <p class="mb-3 text-xs text-muted-foreground">
            回档会丢弃最近的进度，但不会删除更早的存档点；回档前会先自动创建一份安全备份。
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <NInputNumber
              v-model:value="rollbackSteps"
              :min="1"
              :max="maxSnapshots"
              class="w-32"
              :disabled="busy"
            />
            <span class="text-sm">步</span>
            <NButton
              type="warning"
              :loading="busy"
              :disabled="!running"
              @click="confirmRollback"
             v-if="hasPermission('world:rollback')">
              回档
            </NButton>
          </div>
        </div>

        <div class="mt-3 rounded-lg border border-red-200 p-3 dark:border-red-900/50">
          <p class="mb-2 text-sm font-medium">重置世界</p>
          <p class="mb-3 text-xs text-muted-foreground">
            丢弃当前世界并重新生成一张全新地图：地形、建筑与玩家物品都会丢失，只有存档点与安全备份能找回。
            执行前会自动创建一份安全备份。
          </p>
          <NButton
            type="error"
            :disabled="!running"
            :loading="busy"
            @click="resetModalVisible = true"
            v-if="hasPermission('world:reset')"
          >
            重置世界
          </NButton>
        </div>
      </template>
    </NSpin>

    <NModal
      v-model:show="resetModalVisible"
      preset="card"
      title="确认重置世界"
      class="max-w-lg"
    >
      <p class="mb-3 text-sm">
        重置后当前世界的地形、建筑与玩家物品都会丢失。请输入实例名称
        <strong>{{ instanceName }}</strong> 以确认。
      </p>
      <NInput
        v-model:value="resetConfirmName"
        :placeholder="instanceName"
        @keyup.enter="submitResetWorld"
      />
      <template #footer>
        <div class="flex justify-end gap-2">
          <NButton @click="resetModalVisible = false">
            取消
          </NButton>
          <NButton
            type="error"
            :disabled="!resetConfirmMatched"
            :loading="busy"
            @click="submitResetWorld"
           v-if="hasPermission('world:reset')">
            确认重置
          </NButton>
        </div>
      </template>
    </NModal>
  </div>
</template>
