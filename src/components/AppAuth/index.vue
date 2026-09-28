<script setup lang="ts">
import type { PermissionKey } from '../../../shared/constants/permissions'

defineOptions({
  name: 'AppAuth',
})

const props = defineProps<{
  /** 空串表示"这项不需要权限" */
  value: PermissionKey | PermissionKey[] | ''
  all?: boolean
}>()

const isCheck = computed(() => {
  // 空串表示"这项不需要权限"，先过滤掉：留着会让 authAll 直接判失败
  const keys = (typeof props.value === 'string' ? [props.value] : props.value)
    .filter((key): key is PermissionKey => key !== '')
  if (keys.length === 0) {
    return true
  }
  return props.all ? useAppAuth().authAll(keys) : useAppAuth().auth(keys)
})
</script>

<template>
  <slot v-if="isCheck" />
  <slot v-else name="no-auth" />
</template>
