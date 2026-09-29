<script setup lang="ts">
import MembersSection from './MembersSection.vue'

defineOptions({
  name: 'SystemMembers',
})
</script>

<template>
  <FaPageMain class="gap-4" main-class="flex flex-col gap-4">
    <div>
      <h2 class="m-0 text-lg font-semibold">
        成员管理
      </h2>
      <p class="mt-1 mb-0 text-sm text-muted-foreground">
        创建子账号、分配角色与可见实例。
      </p>
    </div>
    <MembersSection />
  </FaPageMain>
</template>
