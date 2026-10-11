<script setup lang="ts">
import { NSelect, NTag } from 'naive-ui'
import { getWorldRuleOptionsForShard } from '../constants/dstWorldAssets'
import {
  buildWorldConfigRows,
  groupWorldConfigRows,
  resolveRowLevelProfile,
  type DstWorldConfigTab,
} from '../constants/dstWorldRuleCatalog'
import {
  normalizeLevelValue,
  toSelectOptions,
} from '../constants/dstWorldRuleLevels'

const props = defineProps<{
  shard: 'master' | 'caves'
  /** 分片目录名（Master/Caves），预留展示用 */
  shardFolder?: 'Master' | 'Caves'
  configTab?: DstWorldConfigTab
  disabled?: boolean
}>()

const model = defineModel<Record<string, string>>({ required: true })

const activeTab = computed(() => props.configTab ?? 'rules')

const ruleSections = computed(() => {
  const rows = buildWorldConfigRows(
    props.shard,
    activeTab.value,
    getWorldRuleOptionsForShard(props.shard),
  )
  return groupWorldConfigRows(rows)
})

function ruleLevel(overrideKey: string): string {
  const row = ruleSections.value
    .flatMap(s => s.items)
    .find(item => item.overrideKey === overrideKey)
  if (!row) {
    return 'default'
  }
  const profile = resolveRowLevelProfile(row)
  return normalizeLevelValue(profile.levels, model.value[overrideKey])
}

function setRuleLevel(overrideKey: string, level: string | null) {
  if (level == null) {
    return
  }
  model.value = {
    ...model.value,
    [overrideKey]: level,
  }
}

/** 该项是否被用户改过（非默认档位），用于展示「已自定义」并支持一键恢复 */
function isCustomized(overrideKey: string): boolean {
  const raw = model.value[overrideKey]
  if (raw == null || raw === '') {
    return false
  }
  const row = ruleSections.value
    .flatMap(s => s.items)
    .find(item => item.overrideKey === overrideKey)
  if (!row) {
    return false
  }
  return normalizeLevelValue(resolveRowLevelProfile(row).levels, raw) !== 'default'
}
</script>

<template>
  <div class="space-y-6">
    <section
      v-for="section in ruleSections"
      :key="section.sectionId"
      class="space-y-3"
    >
      <h3 class="text-sm font-medium text-foreground">
        {{ section.title }}
      </h3>

      <div class="world-rule-grid">
        <div
          v-for="item in section.items"
          :key="`${section.sectionId}-${item.overrideKey}`"
          class="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card p-3"
        >
          <div
            class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/30"
          >
            <img
              v-if="item.image"
              :src="item.image"
              alt=""
              width="48"
              height="48"
              class="max-h-full max-w-full object-contain"
              loading="lazy"
            >
            <span
              v-else
              class="px-1 text-center text-[10px] leading-tight text-muted-foreground"
            >
              无图标
            </span>
          </div>

          <div class="flex min-w-0 flex-1 flex-col justify-between gap-2">
            <p :id="`${shard}-${activeTab}-${item.overrideKey}-label`" class="text-sm leading-snug font-medium text-foreground">
              {{ item.labelZh }}
              <NTag
                v-if="isCustomized(item.overrideKey)"
                size="small"
                :bordered="false"
                type="info"
                class="ml-1"
              >
                已自定义
              </NTag>
            </p>

            <div class="flex items-center justify-center gap-1">
              <NSelect
                :aria-labelledby="`${shard}-${activeTab}-${item.overrideKey}-label`"
                :input-props="{ 'aria-labelledby': `${shard}-${activeTab}-${item.overrideKey}-label` }"
                :value="ruleLevel(item.overrideKey)"
                :options="toSelectOptions(resolveRowLevelProfile(item).levels)"
                :disabled="disabled"
                size="small"
                to="body"
                @update:value="setRuleLevel(item.overrideKey, $event)"
              />
              <button
                v-if="isCustomized(item.overrideKey) && !disabled"
                type="button"
                class="shrink-0 size-8 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary cursor-pointer"
                :aria-label="`恢复${item.labelZh}默认值`"
                title="恢复默认档位"
                @click="setRuleLevel(item.overrideKey, 'default')"
              >
                ↺
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.world-rule-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
  gap: 12px;
}
</style>
