<script setup lang="ts">
/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()

import type { ShardId } from '@/api/modules/shard'
import type { MapDto } from '@/api/modules/map'
import {
  NAlert,
  NButton,
  NEmpty,
  NImage,
  NSpin,
  NTag,
  useMessage,
} from 'naive-ui'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import apiMap, { buildMapImageUrl } from '@/api/modules/map'
import ShardMapLegend from './ShardMapLegend.vue'
import {
  describePrimaryAction,
  describeStatus,
  formatAge,
  formatExportedAt,
  formatFilledRatio,
  formatLandmarkSummary,
  formatMapSize,
  shouldPoll,
} from './shardMapPresentation'

/**
 * 地形图面板。
 *
 * 数据来自「让正在运行的世界把地形写出来」，因此**实例没跑就没有图**——这一点在界面上
 * 直说，而不是给一个点了没反应的按钮。生成期间用轮询看进度，离开页面立刻停表。
 */

const props = defineProps<{
  instanceId: string
  shard: ShardId
}>()

defineOptions({
  name: 'DstShardMapPanel',
})

const message = useMessage()
const appAccountStore = useAppAccountStore()

const loading = ref(false)
const busy = ref(false)
const state = ref<MapDto | null>(null)
/** 每次刷新换一个查询串，绕开浏览器对同一 URL 的图片缓存 */
const imageVersion = ref(Date.now())

let pollTimer: ReturnType<typeof setInterval> | null = null

const shardLabel = computed(() => props.shard === 'master' ? '地上世界' : '洞穴世界')
const generating = computed(() => state.value?.status === 'generating')
const hasImage = computed(() => Boolean(state.value?.imagePath))
/**
 * 「查看地形图」是独立权限点（`world.map:read`），与「世界管理」的 `world:read` 不是一回事。
 * 没有它时不发请求、只说明原因——否则这一屏会静默变成"还没有地形图"，用户点了刷新也没用。
 */
const canViewMap = computed(() => hasPermission('world.map:read'))

const imageUrl = computed(() => {
  const path = state.value?.imagePath
  if (!path) {
    return ''
  }
  const token = appAccountStore.token ?? ''
  const url = buildMapImageUrl(path, token)
  return `${url}&v=${imageVersion.value}`
})

// 展示逻辑全部走纯函数：它们有单测兜底，组件只负责铺到模板上
const statusInfo = computed(() => describeStatus(state.value?.status))
const primaryActionText = computed(() => describePrimaryAction(hasImage.value))
const exportedAtText = computed(() => formatExportedAt(state.value?.exportedAt))
const ageText = computed(() => formatAge(state.value?.ageSeconds))
const mapSizeText = computed(() => formatMapSize(state.value?.width, state.value?.height))
const filledText = computed(() => formatFilledRatio(state.value?.filledRatio))
const landmarkText = computed(() => formatLandmarkSummary(state.value?.landmarkCount))
const legendEntries = computed(() => state.value?.legend ?? [])

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function startPolling() {
  stopPolling()
  pollTimer = setInterval(() => {
    void loadMap(false)
  }, 1500)
}

async function loadMap(showSpin = true) {
  if (!props.instanceId || !canViewMap.value) {
    return
  }
  if (showSpin) {
    loading.value = true
  }
  try {
    const { data } = await apiMap.getMap(props.instanceId, props.shard)
    state.value = data
    if (data.status === 'ready') {
      imageVersion.value = Date.now()
    }
    // 生成中才继续轮询；到终态就停表，不给服务器添无谓的请求
    if (shouldPoll(data.status)) {
      startPolling()
    }
    else {
      stopPolling()
    }
  }
  catch {
    stopPolling()
  }
  finally {
    loading.value = false
  }
}

/**
 * 触发导出。
 *
 * `force` 只在"已经有一张图、用户主动点重新生成"时为真：首次生成没有缓存可跳过，
 * 而再次点击的意图就是"现在就要新的"，不该被服务端的新鲜窗口挡回来。
 */
async function generate(force: boolean) {
  if (busy.value) {
    return
  }
  busy.value = true
  try {
    const { data } = await apiMap.refreshMap({
      instanceId: props.instanceId,
      shard: props.shard,
      force,
    })
    state.value = data
    startPolling()
    message.success('已开始导出地形，请稍候')
  }
  catch (error) {
    // 后端会把"实例没运行"这类原因写在 error 里，直接透传比换成通用文案有用
    const reason = (error as { error?: string })?.error
    message.error(reason ?? '导出地形失败，请确认实例正在运行')
  }
  finally {
    busy.value = false
  }
}

watch(() => [props.instanceId, props.shard], () => {
  stopPolling()
  state.value = null
  if (!canViewMap.value) {
    return
  }
  void loadMap()
}, { immediate: true })

onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="mt-2">
    <!-- 没有「查看地形图」权限：整块收起来，避免"刷新状态"反复请求一个必然 403 的接口 -->
    <NEmpty
      v-if="!canViewMap"
      size="small"
      description="当前账号没有「查看地形图」权限，地形图不可用"
    />
    <template v-else>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <NButton size="small" type="primary" :loading="busy || generating" @click="generate(hasImage)" v-if="hasPermission('world.map:generate')">
        {{ primaryActionText }}
      </NButton>
      <NButton size="small" :disabled="loading" @click="loadMap()">
        刷新状态
      </NButton>
      <NTag v-if="statusInfo.tone" size="small" :type="statusInfo.tone" :bordered="false">
        {{ statusInfo.text }}
      </NTag>
    </div>

    <p class="mb-3 text-xs text-muted-foreground">
      地形图从正在运行的{{ shardLabel }}实时导出，读的是游戏自己的地块数据，含当前启用的 Mod 影响；实例停止时无法生成。
    </p>

    <NAlert v-if="state?.message" :type="state.status === 'failed' ? 'error' : 'info'" :bordered="false" class="mb-3">
      {{ state.message }}
    </NAlert>

    <NSpin :show="loading">
      <!--
        地图在左、图例在右；窄屏（到不了并排的宽度）时堆叠，仍然是地图在上、图例在下——
        用户主要是来看图的，图例不该把它挤到屏幕外面去。
      -->
      <div v-if="hasImage" class="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div class="flex min-w-0 flex-1 flex-col gap-3">
          <div class="flex justify-center rounded-md border bg-muted/20">
            <NImage
              :src="imageUrl"
              :alt="`${shardLabel}地形图`"
              object-fit="contain"
              :img-props="{
                style: 'display: block; width: auto; height: auto; max-width: 100%; max-height: min(60vh, 560px);',
              }"
            />
          </div>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span v-if="mapSizeText">地图尺寸：{{ mapSizeText }} 格</span>
            <span v-if="landmarkText">{{ landmarkText }}</span>
            <span v-if="exportedAtText">导出时间：{{ exportedAtText }}<template v-if="ageText">（{{ ageText }}）</template></span>
            <span v-if="state?.seed">世界种子：{{ state.seed }}</span>
            <span v-if="filledText">已探索地块占比：{{ filledText }}</span>
            <span>点击地图可放大查看</span>
          </div>
        </div>

        <ShardMapLegend :entries="legendEntries" class="lg:w-60 lg:shrink-0" />
      </div>

      <NEmpty
        v-else-if="!loading"
        size="small"
        :description="`还没有${shardLabel}的地形图`"
      />
    </NSpin>
    </template>
  </div>
</template>
