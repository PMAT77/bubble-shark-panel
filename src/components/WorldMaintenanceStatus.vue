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
  dialog.warning({ title: '仍然执行，不创建安全备份？', content: '本次安全备份失败。继续后无法通过本次备份恢复旧世界或已保存进度。此确认只豁免备份失败，其他校验仍须通过。', positiveText: '不备份继续', negativeText: '返回', onPositiveClick: () => emit('continue', true) })
}
</script>
<template>
  <NAlert v-if="operation" :type="operation.state === 'completed' ? 'success' : operation.state === 'failed' || operation.state === 'unknown' ? 'error' : 'warning'" class="my-3" :title="phaseLabels[operation.phase]">
    <p>{{ operation.message || '请求已接受，正在执行；结果核验完成后更新状态。' }}</p>
    <p v-if="operation.backupWarning" class="mt-1">{{ operation.backupWarning }}</p>
    <p v-if="operation.backupSkipped" class="mt-1">本次操作未创建安全备份。</p>
    <NSpace class="mt-2">
      <NButton v-if="operation.backupId && hasPermission('backup:read')" size="tiny" @click="router.push(routeToOpsBackups(operation.instanceId))">备份与恢复</NButton>
      <template v-if="operation.state === 'awaiting_confirmation' && operation.canContinue">
        <NButton size="tiny" :disabled="submitting" @click="emit('continue', false)">取消操作</NButton>
        <NButton size="tiny" type="error" :disabled="submitting" @click="confirmSkip">仍然执行，不创建安全备份</NButton>
        <span class="text-xs">确认有效期五分钟，继续前会重新校验目标。</span>
      </template>
      <NButton v-if="operation.state === 'unknown' && operation.action !== 'save'" size="tiny" :disabled="submitting" @click="emit('verify')">重新核验实际世界</NButton>
    </NSpace>
  </NAlert>
</template>
