<script setup lang="ts">
import type { CavesWorldgenPreset, MasterWorldgenPreset } from '@/api/modules/shard'
import { NButton, NInput, NTag } from 'naive-ui'
import { getWorldgenOptions } from '../constants/dstWorldAssets'
import ShardWorldRulesSection from './ShardWorldRulesSection.vue'

// 重置世界是写操作：只读账号能看当前种子与预设，但点不动
const { auth: hasPermission } = useAppAuth()

const props = defineProps<{
  shard: 'master' | 'caves'
  shardFolder: 'Master' | 'Caves'
  modelValue: MasterWorldgenPreset | CavesWorldgenPreset
  worldgenConfig: Record<string, string>
  /**
   * 下次生成配置；允许运行中编辑，空串表示随机。
   */
  worldSeed: string
  /** 实例是否正在运行：运行中可以读取真实种子 */
  instanceRunning?: boolean
  /** 正在读取当前种子 */
  reading?: boolean
  /** 正在按新种子重置世界 */
  resetting?: boolean
  busy?: boolean
  worldGenerated?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: MasterWorldgenPreset | CavesWorldgenPreset]
  'update:worldgenConfig': [value: Record<string, string>]
  'update:worldSeed': [value: string]
  'read': []
  'reset': []
}>()

const worldgenLocked = computed(() => Boolean(props.worldGenerated))

const isMaster = computed(() => props.shard === 'master')

const presetOptions = computed(() => getWorldgenOptions(props.shard))

function selectPreset(preset: CavesWorldgenPreset) {
  if (worldgenLocked.value || isMaster.value) {
    return
  }
  emit('update:modelValue', preset)
}

const worldgenConfigModel = computed({
  get: () => props.worldgenConfig,
  set: (value: Record<string, string>) => {
    emit('update:worldgenConfig', { ...value })
  },
})

/** 只收数字并限制长度，避免把非数字内容提交到服务端再被拒 */
function updateWorldSeed(value: string) {
  emit('update:worldSeed', value.replace(/\D/g, '').slice(0, 15))
}

const seedHint = computed(() => props.worldGenerated
  ? '修改种子后需点击重置世界才生效；留空表示随机，未修改则沿用当前种子。'
  : '首次启动按已保存的生成配置创建地图；留空表示随机。')
</script>

<template>
  <div class="space-y-6">

    <!-- 世界生成预设：地上固定联机生存，洞穴可选；世界生成后锁定 -->
    <section class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-sm font-medium text-foreground">
          地图预设
        </h3>
        <NTag v-if="worldgenLocked" size="small" :bordered="false" type="warning">
          世界已生成，预设已锁定
        </NTag>
      </div>

      <p v-if="isMaster" class="text-sm text-muted-foreground">
        地上世界固定使用官方「联机生存」预设。
      </p>
      <div v-else class="grid gap-3 sm:grid-cols-3">
        <button
          v-for="option in presetOptions"
          :key="option.id"
          type="button"
          :disabled="worldgenLocked"
          class="flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
          :class="modelValue === option.preset
            ? 'border-primary ring-2 ring-primary/40'
            : 'border-border hover:border-primary/50'"
          @click="selectPreset(option.preset as CavesWorldgenPreset)"
        >
          <span class="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/30">
            <img :src="option.image" :alt="option.label" class="max-h-full max-w-full object-contain" loading="lazy">
          </span>
          <span class="text-sm font-medium">{{ option.label }}</span>
        </button>
      </div>
    </section>

    <section class="flex flex-col gap-3">
      <h3 class="text-sm font-medium">世界种子</h3>
      <div class="flex flex-wrap items-center gap-3">
        <NInput :value="worldSeed" class="w-full! sm:w-80!" :disabled="busy || (!hasPermission('world:write') && !hasPermission('world:reset'))" :input-props="{ inputmode: 'numeric', 'aria-label': '世界种子' }" placeholder="留空 = 随机" @update:value="updateWorldSeed" />
        <div class="flex flex-wrap items-center gap-2">
          <NButton v-if="instanceRunning && hasPermission('world:read')" :loading="reading" :disabled="reading" @click="emit('read')">读取</NButton>
          <NButton v-if="hasPermission('world:reset')" type="warning" :loading="resetting" :disabled="busy" @click="emit('reset')">重置世界</NButton>
        </div>
      </div>
      <p class="text-xs leading-relaxed text-muted-foreground">{{ seedHint }}</p>
    </section>

    <ShardWorldRulesSection
      v-model="worldgenConfigModel"
      :shard="shard"
      :shard-folder="shardFolder"
      config-tab="worldgen"
      :disabled="worldgenLocked"
    />
  </div>
</template>
