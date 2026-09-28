<script setup lang="ts">
import RolesSection from './RolesSection.vue'

defineOptions({
  name: 'SystemRoles',
})
</script>

<template>
  <FaPageMain class="h-full gap-4">
    <div>
      <h2 class="m-0 text-lg font-semibold">
        角色管理
      </h2>
      <p class="mt-1 mb-0 text-sm text-muted-foreground">
        一个角色就是一组权限点的集合：勾上「启停与重启」这个角色才能开关实例，不勾就只能看。
        把角色分给成员后，权限立即生效。
      </p>
    </div>
    <RolesSection />
  </FaPageMain>
</template>
