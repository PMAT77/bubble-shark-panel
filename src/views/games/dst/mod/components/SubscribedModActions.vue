<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NDropdown } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'

const props = defineProps<{
  name: string
  status: 'ready' | 'pending' | 'failed'
  disabled: boolean
  pending: boolean
  unsubscribing: boolean
  updatable: boolean
  redownloadable: boolean
}>()
const emit = defineEmits<{ retry: [], update: [], configure: [], import: [], unsubscribe: [], detail: [] }>()
const { auth: hasPermission } = useAppAuth()
const options = computed(() => {
  const items: DropdownOption[] = [{ key: 'detail', label: '查看详情', disabled: props.disabled }]
  if (hasPermission('mod:install')) {
    if (props.redownloadable) items.push({ key: 'update', label: '重新下载', disabled: props.disabled || props.pending })
    if (props.status !== 'ready') items.push({ key: 'import', label: '从本地导入', disabled: props.disabled || props.pending })
    items.push({ key: 'divider', type: 'divider' }, { key: 'unsubscribe', label: '取消订阅',
      disabled: props.disabled || props.pending || props.unsubscribing || props.status === 'pending',
      props: { class: 'text-rose-600 dark:text-rose-400' } })
  }
  return items
})
function select(key: 'detail' | 'update' | 'import' | 'unsubscribe') {
  if (key === 'detail') emit('detail')
  else if (key === 'update') emit('update')
  else if (key === 'import') emit('import')
  else emit('unsubscribe')
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <NButton v-if="status !== 'ready' && hasPermission('mod:install')" size="small" type="primary" secondary
      :disabled="disabled || pending || unsubscribing" :aria-label="`${status === 'failed' ? '重试下载' : '下载'} ${name}`" @click="emit('retry')">
      {{ status === 'failed' ? '重试' : '下载' }}
    </NButton>
    <NButton v-if="updatable && hasPermission('mod:install')" size="small" type="primary" secondary
      :disabled="disabled || pending || unsubscribing" :aria-label="`更新 ${name}`" @click="emit('update')">更新</NButton>
    <NButton v-if="status === 'ready' && hasPermission('mod:config')" size="small"
      :disabled="disabled || pending || unsubscribing" :aria-label="`配置 ${name}`" @click="emit('configure')">配置</NButton>
    <NDropdown trigger="click" :options="options" @select="select">
      <NButton size="small" :loading="unsubscribing" :aria-label="`${name} 的更多操作`">更多</NButton>
    </NDropdown>
  </div>
</template>
