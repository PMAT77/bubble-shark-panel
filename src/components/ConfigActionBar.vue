<script setup lang="ts">
defineOptions({ name: 'ConfigActionBar' })

withDefaults(defineProps<{
  dirty?: boolean
  resetDirty?: boolean
  statusText?: string
  restartNeeded?: boolean
  /** 任一操作进行中：三个按钮一律置灰，避免并发提交 */
  busy?: boolean
  /** 「保存」按钮自身的 loading */
  saving?: boolean
  /** 「保存并重启」按钮自身的 loading */
  restarting?: boolean
  /** 「重置」按钮自身的 loading */
  resetting?: boolean
  restartDisabled?: boolean
  /** 「保存并重启」禁用原因（禁用时以 tooltip 展示） */
  restartDisabledTitle?: string
  /** 不需要重启动作的页面（如系统设置）可隐藏 */
  showRestart?: boolean
  saveLabel?: string
  restartLabel?: string
  resetLabel?: string
}>(), {
  showRestart: true,
  saveLabel: '保存配置',
  restartLabel: '保存并重启',
  resetLabel: '放弃修改',
})

const emit = defineEmits<{
  reset: []
  save: []
  saveAndRestart: []
}>()
</script>

<template>
  <FaFixedBar position="bottom">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <span class="text-sm text-muted-foreground" role="status" aria-live="polite">
        {{ statusText ?? (dirty ? '有未保存的修改' : '已保存') }}
      </span>
      <div class="flex flex-wrap gap-2">
        <FaButton variant="ghost" :loading="resetting" :disabled="!(resetDirty ?? dirty) || busy" @click="emit('reset')">
          {{ resetLabel }}
        </FaButton>
        <FaButton :loading="saving" :disabled="!dirty || busy" @click="emit('save')">
          {{ saveLabel }}
        </FaButton>
        <FaButton v-if="showRestart" variant="outline" :loading="restarting" :disabled="(!dirty && !restartNeeded) || busy || restartDisabled" @click="emit('saveAndRestart')">
          {{ restartLabel }}
        </FaButton>
      </div>
      <p v-if="showRestart && restartDisabled && restartDisabledTitle" class="w-full text-sm text-muted-foreground">
        {{ restartDisabledTitle }}
      </p>
    </div>
  </FaFixedBar>
</template>
