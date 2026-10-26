<script setup lang="ts">
import { NSwitch, NTag } from 'naive-ui'

defineProps<{ name: string, ready: boolean, enabled: boolean, disabled: boolean, loading: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
const { auth: hasPermission } = useAppAuth()
</script>

<template>
  <span v-if="!ready" class="text-sm text-muted-foreground">未就绪</span>
  <NSwitch v-else-if="hasPermission('mod:toggle')" :value="enabled" :disabled="disabled" :loading="loading"
    :aria-label="`${enabled ? '停用' : '启用'} ${name}`" @update:value="emit('toggle')">
    <template #checked>启用</template>
    <template #unchecked>停用</template>
  </NSwitch>
  <NTag v-else size="small" :bordered="false">{{ enabled ? '已启用' : '已停用' }}</NTag>
</template>
