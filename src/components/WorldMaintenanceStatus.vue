<script setup lang="ts">
import { NButton, NSpace, useDialog } from 'naive-ui'
import type { WorldMaintenanceOperation } from '@/api/modules/world-maintenance'
import { routeToOpsBackups } from '@/navigation/game-routes'
const props = defineProps<{ operation: WorldMaintenanceOperation | null, submitting?: boolean }>()
const emit = defineEmits<{ continue: [withoutBackup: boolean], verify: [] }>()
const dialog = useDialog()
const router = useRouter()
const { auth: hasPermission } = useAppAuth()
function confirmSkip() {
  dialog.warning({ title: '不备份，继续执行？', content: '本次备份失败。继续后，无法通过本次备份恢复旧世界或已保存进度。', positiveText: '不备份继续', negativeText: '返回', onPositiveClick: () => emit('continue', true) })
}
</script>
<template>
  <NSpace v-if="operation && ((operation.backupId && hasPermission('backup:read')) || (operation.state === 'awaiting_confirmation' && operation.canContinue) || (operation.state === 'unknown' && operation.action !== 'save'))" class="my-3">
    <NButton v-if="operation.backupId && hasPermission('backup:read')" size="small" @click="router.push(routeToOpsBackups(operation.instanceId))">备份与恢复</NButton>
    <template v-if="operation.state === 'awaiting_confirmation' && operation.canContinue">
      <NButton size="small" :disabled="submitting" @click="emit('continue', false)">取消操作</NButton>
      <NButton size="small" type="error" :disabled="submitting" @click="confirmSkip">不备份继续</NButton>
      <span class="text-sm">请在五分钟内确认，过期后需重新操作。</span>
    </template>
    <NButton v-if="operation.state === 'unknown' && operation.action !== 'save'" size="small" :disabled="submitting" @click="emit('verify')">重新检查</NButton>
  </NSpace>
</template>
