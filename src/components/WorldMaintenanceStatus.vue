<script setup lang="ts">
import { NAlert, NButton, NSpace, useDialog } from 'naive-ui'
import type { WorldMaintenanceOperation } from '@/api/modules/world-maintenance'
import { routeToOpsBackups } from '@/navigation/game-routes'
const props = defineProps<{ operation: WorldMaintenanceOperation | null, submitting?: boolean }>()
const emit = defineEmits<{ continue: [withoutBackup: boolean], verify: [] }>()
const dialog = useDialog()
const router = useRouter()
const { auth: hasPermission } = useAppAuth()
const phaseLabels = { preparing: '核验运行状态与目标', saving: '保存存档', backing_up: '创建安全备份', applying_config: '更新生成配置', executing: '发送生成或重载请求', starting: '启动实例', verifying: '等待世界加载并核验', finished: '操作已结束' }
function confirmSkip() {
  dialog.warning({ title: '不备份，继续执行？', content: '本次备份失败。继续后，无法通过本次备份恢复旧世界或已保存进度。', positiveText: '不备份继续', negativeText: '返回', onPositiveClick: () => emit('continue', true) })
}
</script>
<template>
  <NAlert v-if="operation" :type="operation.state === 'completed' ? 'success' : operation.state === 'failed' || operation.state === 'unknown' ? 'error' : 'warning'" class="my-3" :title="phaseLabels[operation.phase]">
    <p>{{ operation.message || '正在执行，请等待结果。' }}</p>
    <p v-if="operation.backupWarning" class="mt-1">{{ operation.backupWarning }}</p>
    <p v-if="operation.backupSkipped" class="mt-1">本次操作未创建安全备份。</p>
    <NSpace class="mt-2">
      <NButton v-if="operation.backupId && hasPermission('backup:read')" size="small" @click="router.push(routeToOpsBackups(operation.instanceId))">备份与恢复</NButton>
      <template v-if="operation.state === 'awaiting_confirmation' && operation.canContinue">
        <NButton size="small" :disabled="submitting" @click="emit('continue', false)">取消操作</NButton>
        <NButton size="small" type="error" :disabled="submitting" @click="confirmSkip">不备份继续</NButton>
        <span class="text-sm">请在五分钟内确认，过期后需重新操作。</span>
      </template>
      <NButton v-if="operation.state === 'unknown' && operation.action !== 'save'" size="small" :disabled="submitting" @click="emit('verify')">重新检查</NButton>
    </NSpace>
  </NAlert>
</template>
