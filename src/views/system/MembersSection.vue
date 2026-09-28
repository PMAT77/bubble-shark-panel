<script setup lang="ts">
import { NCard, NEmpty } from 'naive-ui'

defineOptions({
  name: 'MembersSection',
})
</script>

<template>
  <NCard title="成员" :bordered="false">
    <NEmpty description="成员列表正在接线中" />
  </NCard>
</template>
