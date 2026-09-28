<script setup lang="ts">
import MembersSection from './MembersSection.vue'

defineOptions({
  name: 'SystemMembers',
})
</script>

<template>
  <FaPageMain class="h-full gap-4">
    <div>
      <h2 class="m-0 text-lg font-semibold">
        成员管理
      </h2>
      <p class="mt-1 mb-0 text-sm text-muted-foreground">
        创建子账号、分配角色与可见实例。角色决定这个账号能做什么，实例授权决定它能在哪些实例上做，两者同时满足才生效。
      </p>
    </div>
    <MembersSection />
  </FaPageMain>
</template>
