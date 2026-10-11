<script setup lang="ts">
import RolesSection from './RolesSection.vue'

defineOptions({
  name: 'SystemRoles',
})
</script>

<template>
  <FaPageMain class="gap-4" main-class="flex flex-col gap-4">
    <div>
      <h1 class="m-0 text-lg font-semibold">
        角色管理
      </h1>
    </div>
    <RolesSection />
  </FaPageMain>
</template>
