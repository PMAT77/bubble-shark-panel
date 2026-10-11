<script setup lang="ts">
import { NButton, NInput, NSpace } from 'naive-ui'

defineOptions({
  name: 'AdminListToolbar',
})

const props = withDefaults(defineProps<{
  keyword?: string
  keywordPlaceholder?: string
  showKeyword?: boolean
  showSearch?: boolean
  showReset?: boolean
  searchLoading?: boolean
  disableSearchLoading?: boolean
  resetDisabled?: boolean
}>(), {
  keyword: '',
  keywordPlaceholder: '关键词搜索',
  showKeyword: true,
  showSearch: true,
  showReset: true,
  searchLoading: false,
  disableSearchLoading: false,
  resetDisabled: false,
})

const emit = defineEmits<{
  'update:keyword': [value: string]
  search: []
  reset: []
}>()

function onKeywordUpdate(value: string) {
  emit('update:keyword', value)
}
</script>

<template>
  <div class="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center md:justify-between">
    <NSpace :size="8" align="center" class="min-w-0 flex-1 flex-wrap">
      <NInput
        v-if="showKeyword"
        :value="props.keyword"
        class="w-full md:w-64"
        :placeholder="keywordPlaceholder"
        :input-props="{ 'aria-label': keywordPlaceholder }"
        clearable
        @update:value="onKeywordUpdate"
        @keydown.enter="emit('search')"
      />
      <slot name="filters" />
      <template v-if="showSearch || showReset">
        <NButton
          v-if="showSearch"
          type="primary"
          strong
          secondary
          :loading="searchLoading && !disableSearchLoading"
          @click="emit('search')"
        >
          查询
        </NButton>
        <NButton
          v-if="showReset"
          :disabled="resetDisabled"
          @click="emit('reset')"
        >
          重置
        </NButton>
      </template>
    </NSpace>
    <NSpace v-if="$slots.actions" :size="8" align="center" class="w-full shrink-0 md:w-auto md:justify-end">
      <slot name="actions" />
    </NSpace>
  </div>
</template>
