<script setup lang="ts">
import RolesSection from './RolesSection.vue'

defineOptions({
  name: 'SystemRoles',
})
</script>

<template>
  <FaPageMain class="gap-4" main-class="flex flex-col gap-4">
    <div>
      <h2 class="m-0 text-lg font-semibold">
        角色管理
      </h2>
      <p class="mt-1 mb-0 text-sm text-muted-foreground">
        一个角色就是一组权限点的集合。
      </p>
    </div>
    <RolesSection />
  </FaPageMain>
</template>
