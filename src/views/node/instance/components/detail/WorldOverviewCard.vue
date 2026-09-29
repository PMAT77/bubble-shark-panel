<script setup lang="ts">
import type { InstanceItem } from '@/api/modules/instance'
import type { ShardId, ShardListDto } from '@/api/modules/shard'
import apiShard from '@/api/modules/shard'
import { NButton, NCard, NEmpty, NSpin, NTag } from 'naive-ui'
import { computed, ref } from 'vue'
import { routeToDstWorldSettings } from '@/navigation/game-routes'
import { resolveShardDisplayStatus, statusTagType } from '@/constants/statusDictionary'
import { dstSeasonLabel } from '../../instanceCommandShortcuts'

/** 世界运行时状态（P1：指令注入查询，实例未运行时 available=false） */
export interface InstanceWorldState {
  available: boolean
  cycles: number | null
  season: string | null
  daysInSeason: number | null
  message?: string
}

defineOptions({
  name: 'InstanceDetailWorldOverviewCard',
})

const props = defineProps<{
  instance: InstanceItem | null
  shardList: ShardListDto | null
  worldState?: InstanceWorldState | null
  loading?: boolean
}>()

const emit = defineEmits<{
  refreshed: []
}>()

const router = useRouter()
const initCavesLoading = ref(false)

/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()
const canViewWorld = computed(() => hasPermission('world:read'))

const cavesShard = computed(() => props.shardList?.shards.find(shard => shard.id === 'caves') ?? null)

const cavesEnabled = computed(() => props.shardList?.clusterShardEnabled === true)

const worldStateText = computed(() => {
  const ws = props.worldState
  if (!ws || !ws.available || ws.cycles === null) {
    return null
  }
  const dayText = `第 ${ws.cycles + 1} 天`
  const seasonText = ws.season
    ? `${dstSeasonLabel(ws.season)}${ws.daysInSeason !== null ? `（第 ${ws.daysInSeason + 1} 天）` : ''}`
    : ''
  return seasonText ? `${dayText} · ${seasonText}` : dayText
})

function shardStatus(shardId: ShardId) {
  const shard = props.shardList?.shards.find(item => item.id === shardId)
  if (!shard) {
    return null
  }
  const descriptor = resolveShardDisplayStatus(shard)
  return {
    shard,
    descriptor,
    tagType: statusTagType(descriptor.tone),
  }
}

const masterView = computed(() => shardStatus('master'))
const cavesView = computed(() => shardStatus('caves'))

function presetLabel(preset: string | null | undefined) {
  if (!preset) {
    return '—'
  }
  const map: Record<string, string> = {
    SURVIVAL_TOGETHER: '标准生存',
    DST_CAVE: '洞穴',
    DST_CAVE_PLUS: '加强洞穴',
    COMPLETE_DARKNESS: '永久黑暗',
  }
  return map[preset] ?? preset
}

async function initCaves() {
  if (!props.instance || initCavesLoading.value) {
    return
  }
  initCavesLoading.value = true
  try {
    await apiShard.initCaves(props.instance.id)
    faToast.success('洞穴已初始化，可在世界设置中调整参数')
    emit('refreshed')
  }
  catch (error) {
    faToast.error(error instanceof Error ? error.message : '洞穴初始化失败，请稍后重试')
  }
  finally {
    initCavesLoading.value = false
  }
}

function goWorldSettings() {
  if (props.instance) {
    router.push(routeToDstWorldSettings(props.instance.id))
  }
}
</script>

<template>
  <NCard title="世界概览" size="small">
    <NSpin v-if="loading && !shardList" class="block mx-auto my-6" />
    <template v-else-if="instance && shardList">
      <!--
        这一行始终占位：读数在刷新与轮询之间会短暂为空（实例未运行、查询失败或还没回来），
        用 v-if 把整行收掉会让卡片高度塌一下再弹回来。
      -->
      <p class="mb-3 text-xs text-muted-foreground">
        世界进程：<span class="text-foreground">{{ worldStateText ?? '—' }}</span>
        <span v-if="worldState && !worldState.available && worldState.message" class="ml-1">{{ worldState.message }}</span>
      </p>

      <div class="grid gap-3 md:grid-cols-2">
        <div
          v-for="view in [masterView, cavesView]"
          :key="view?.shard.id ?? Math.random()"
          v-show="view"
          class="rounded-lg border border-border p-3 space-y-2"
        >
          <template v-if="view">
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-medium">{{ view.shard.isMaster ? '主世界（地上）' : '洞穴' }}</span>
              <NTag size="small" :bordered="false" :type="view.tagType">
                {{ view.descriptor.label }}
              </NTag>
            </div>
            <dl class="text-xs text-muted-foreground space-y-1">
              <div class="flex justify-between gap-2">
                <dt>世界生成</dt>
                <dd>{{ view.shard.worldGenerated ? '已生成' : '未生成' }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt>地图预设</dt>
                <dd>{{ presetLabel(view.shard.worldgenPreset) }}</dd>
              </div>
              <div class="flex justify-between gap-2">
                <dt>游戏端口</dt>
                <dd>{{ view.shard.serverPort ?? '—' }}</dd>
              </div>
            </dl>
          </template>
        </div>
      </div>

      <div v-if="!cavesEnabled" class="mt-3 rounded-md bg-muted/50 px-3 py-2.5 flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs text-muted-foreground">未开启洞穴</span>
        <NButton v-if="canViewWorld" size="tiny" secondary @click="goWorldSettings">
          去世界设置
        </NButton>
      </div>
      <div
        v-else-if="cavesEnabled && cavesShard && !cavesShard.configured"
        class="mt-3 rounded-md bg-muted/50 px-3 py-2.5 flex flex-wrap items-center justify-between gap-2"
      >
        <span class="text-xs text-muted-foreground">洞穴还没准备好，初始化后即可使用</span>
        <NButton size="tiny" type="primary" secondary :loading="initCavesLoading" @click="initCaves" v-if="hasPermission('world:write')">
          初始化洞穴
        </NButton>
      </div>
    </template>
    <template v-else-if="instance">
      <!--
        「读取失败」与「没有权限」必须分开说：详情页只在有 world:read 时才去拉分片列表，
        没有权限时这里必然是空的——写成"请稍后重试"会让人一直点刷新。
      -->
      <NEmpty
        :description="canViewWorld ? '世界配置读取失败，请稍后重试' : '当前账号没有「查看世界配置」权限，看不到世界信息'"
        size="small"
      />
    </template>
    <NEmpty v-else description="未找到实例" size="small" />
  </NCard>
</template>
