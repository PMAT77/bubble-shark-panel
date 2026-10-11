<script setup lang="ts">
import MembersSection from './MembersSection.vue'

defineOptions({
  name: 'SystemMembers',
})
</script>

<template>
  <FaPageMain class="gap-4" main-class="flex flex-col gap-4">
    <div>
      <h1 class="m-0 text-lg font-semibold">
        成员管理
      </h1>
    </div>
    <MembersSection />
  </FaPageMain>
</template>
