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
   * 世界种子：实例运行中它是当前世界正在用的种子（只读），停止后可以改，
   * 改完点「重置世界」就按它重新生成地图。空串 = 留空（由游戏随机）。
   */
  worldSeed: string
  /** 面板记录/读到的当前世界种子，用于判断输入框里的值是否还没应用；null = 尚未读到 */
  currentWorldSeed: string | null
  /** 实例是否正在运行：运行中种子锁定，也读得到当前种子 */
  instanceRunning?: boolean
  /** 正在读取当前种子 */
  reading?: boolean
  /** 正在按新种子重置世界 */
  resetting?: boolean
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

/** 实例运行中不能改种子：要换地图得先停服，再重置世界 */
const seedLocked = computed(() => Boolean(props.instanceRunning))

/** 能按当前种子重置世界：实例已停止，且这个世界已经生成过 */
const canResetWorld = computed(() => !props.instanceRunning && Boolean(props.worldGenerated))

/** 输入框里的值还没变成这个世界：提醒它只在重置世界后生效 */
const seedPending = computed(() =>
  Boolean(props.worldGenerated)
  && Boolean(props.currentWorldSeed)
  && props.worldSeed !== props.currentWorldSeed,
)

/** 一句话说清现在能做什么 */
const seedHint = computed(() => {
  if (props.instanceRunning) {
    return '实例运行中，种子锁定；停止实例后可修改并重置世界。'
  }
  if (!props.worldGenerated) {
    return '启动实例时按这个种子生成地图；留空则随机。'
  }
  if (seedPending.value) {
    return '改动会在重置世界后生效。'
  }
  return '点「重置世界」会按这个种子重新生成地图，并自动启动实例。'
})
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

    <!-- 世界种子：运行中显示当前种子（锁定），停止后可改并重置世界 -->
    <section class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-sm font-medium text-foreground">
          世界种子
        </h3>
        <NTag v-if="currentWorldSeed && worldSeed === currentWorldSeed" size="small" :bordered="false" type="success">
          当前世界的种子
        </NTag>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <NInput
          :value="worldSeed"
          class="max-w-xs"
          :disabled="seedLocked"
          placeholder="留空 = 随机（例如 1608382646）"
          @update:value="updateWorldSeed"
        />
        <NButton
          v-if="instanceRunning"
          size="small"
          :loading="reading"
          :disabled="reading"
          @click="emit('read')"
        >
          读取
        </NButton>
        <NButton
          size="small"
          type="warning"
          :loading="resetting"
          :disabled="resetting || !canResetWorld"
          @click="emit('reset')"
          v-if="hasPermission('world:reset')"
        >
          重置世界
        </NButton>
      </div>

      <p class="text-xs text-muted-foreground">
        {{ seedHint }}
      </p>
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
