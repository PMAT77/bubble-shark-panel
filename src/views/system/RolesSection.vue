<script setup lang="ts">
import { NCard, NEmpty } from 'naive-ui'

defineOptions({
  name: 'RolesSection',
})
</script>

<template>
  <NCard title="角色" :bordered="false">
    <NEmpty description="角色列表正在接线中" />
  </NCard>
</template>
