<script setup lang="ts">
import type { InstanceConnectInfo, InstanceItem } from '@/api/modules/instance'
import type { ClusterConfigDto, ClusterOnlinePlayersDto } from '@/api/modules/cluster'
import type { ModListDto } from '@/api/modules/mod'
import type { ShardListDto } from '@/api/modules/shard'
import apiCluster from '@/api/modules/cluster'
import apiInstance from '@/api/modules/instance'
import apiMod from '@/api/modules/mod'
import apiShard from '@/api/modules/shard'
import { NButton, NSpin, NTabPane, NTabs } from 'naive-ui'
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { routeToNodeInstance } from '@/navigation/game-routes'
import { isInstanceWorldReady } from './startupPresentation'
import { useInstanceStartup } from './composables/useInstanceStartup'
import { planInstanceDetailRequests } from './detailRequestPermissions'
import CommandCenterCard from './components/detail/CommandCenterCard.vue'
import InstanceFilesCard from './components/detail/InstanceFilesCard.vue'
import InstanceMigrationCard from './components/detail/InstanceMigrationCard.vue'
import InstanceControlCard from './components/detail/InstanceControlCard.vue'
import RoomOverviewCard from './components/detail/RoomOverviewCard.vue'
import WorldOverviewCard, { type InstanceWorldState } from './components/detail/WorldOverviewCard.vue'
import { instanceSupportsDstRoom } from '@/composables/useGameInstance'
import { keyboardTabProps } from '@/utils/keyboardTab'
import type { InstanceDetailTab } from '@/navigation/game-routes'
import { availableInstanceDetailTabs, resolveInstanceDetailTab } from './instanceDetailTabs'

defineOptions({
  name: 'NodeInstanceDetail',
})

const route = useRoute()
const router = useRouter()

/** 复用统一的权限判定（它同时处理「面板关闭登录」的场景） */
const { auth: hasPermission } = useAppAuth()
/**
 * 游客身份要额外挡住"会改状态的读接口"（世界状态查询会向游戏下发 print 指令）。
 * 判定不能只看权限点——游客恰好持有 `instance.console:read`，但服务端会拒绝它。
 */
const appAccountStore = useAppAccountStore()

const instanceId = computed(() => String(route.params.instanceId ?? ''))

const loading = ref(false)
const instance = ref<InstanceItem | null>(null)
const { syncStartupPolling, stopStartupPolling } = useInstanceStartup(computed(() => instance.value ? [instance.value] : []), (id, startup) => {
  if (instance.value?.id === id) instance.value = { ...instance.value, startup }
}, () => { if (ownsCurrentPage()) void loadDetail({ silent: true }) }, { notifyFailure: false })
const cluster = ref<ClusterConfigDto | null>(null)
const shardList = ref<ShardListDto | null>(null)
const onlinePlayers = ref<ClusterOnlinePlayersDto | null>(null)
const modList = ref<ModListDto | null>(null)
const connectInfo = ref<InstanceConnectInfo | null>(null)
const worldState = ref<InstanceWorldState | null>(null)

const pageTitle = computed(() => instance.value?.name || '实例详情')
const availableTabs = computed(() => availableInstanceDetailTabs(hasPermission, Boolean(instance.value && instanceSupportsDstRoom(instance.value))))
const activeTab = computed(() => resolveInstanceDetailTab(route.query.tab, availableTabs.value))
function changeTab(tab: InstanceDetailTab) {
  void router.replace({ query: { ...route.query, tab } })
}
watch([() => route.query.tab, availableTabs, instance], () => {
  if (instance.value && ownsCurrentPage() && route.query.tab !== activeTab.value) changeTab(activeTab.value)
})

/**
 * 有权限就拉，没有就不发；单项失败给 `null`（不阻塞其余区块）。
 *
 * 为什么不是"先发再说"：详情页只要求 `instance:read`，而房间/世界/玩家/Mod/控制台各有
 * 自己的读权限。无权限时发出去只会拿到 403，而 `allSettled` 会把失败吞成 `null`——
 * 卡片显示"—"，看起来像"这里没有数据"，而不是"你没有权限"。
 */
async function fetchSection<T>(allowed: boolean, request: () => Promise<{ data: T }>): Promise<T | null> {
  if (!allowed) {
    return null
  }
  try {
    const res = await request()
    return res.data
  }
  catch {
    return null
  }
}

/** 房间概览卡片自己按权限显示提示与快捷入口，这里不再重复计算 */

/** 运行中的实例每 30 秒静默刷新概览数据 */
const DETAIL_POLL_MS = 30_000
let pollTimer: ReturnType<typeof setInterval> | undefined

/**
 * 路由对本页开启了 keepAlive：离开详情页时组件不会卸载，定时器与 watch 都还活着。
 * 只有「本页正被激活」且「当前路由就是详情页」时才允许它自己导航，
 * 否则后台轮询会把停在别的页面上的用户强行拉回实例管理列表。
 */
let pageActive = true
const isDetailRouteActive = computed(() => route.name === 'nodeInstanceDetail')

function ownsCurrentPage() {
  return pageActive && isDetailRouteActive.value
}

async function loadDetail(options?: { silent?: boolean }) {
  if (!instanceId.value) {
    if (ownsCurrentPage()) {
      router.replace(routeToNodeInstance())
    }
    return
  }
  if (!options?.silent) {
    loading.value = true
  }
  try {
    const targetId = instanceId.value
    const listRes = await apiInstance.getInstanceList()
    if (targetId !== instanceId.value) {
      return
    }
    const target = (listRes.data as InstanceItem[]).find(item => item.id === targetId)
    if (!target) {
      // 被缓存在别的路由上时保持静默：返回详情页后 onActivated 会重新检测，
      // 那时再提示并跳回列表页
      if (ownsCurrentPage()) {
        faToast.warning('实例不存在或已删除')
        router.replace(routeToNodeInstance())
      }
      return
    }
    instance.value = target

    /**
     * 先按权限决定要发哪些请求：没有权限的区块一个请求都不发。
     * 发出去只会拿到 403（一屏红字），而卡片拿到 `null` 后只能显示"—"。
     */
    const plan = planInstanceDetailRequests(hasPermission, appAccountStore.isGuestRole)

    // 概览数据并行拉取，单项失败不阻塞页面（对应卡片展示空态）
    const [clusterData, shardData, onlineData, modData, connectData] = await Promise.all([
      fetchSection(plan.cluster, () => apiCluster.getClusterConfig(targetId)),
      fetchSection(plan.shardList, () => apiShard.getShardList(targetId)),
      fetchSection(plan.onlinePlayers, () => apiCluster.getOnlinePlayers(targetId)),
      fetchSection(plan.modList, () => apiMod.getModList(targetId)),
      fetchSection(plan.connectInfo, () => apiInstance.getInstanceConnectInfo(targetId)),
    ])
    if (targetId !== instanceId.value) {
      return
    }
    cluster.value = clusterData
    shardList.value = shardData
    onlinePlayers.value = onlineData
    modList.value = modData
    connectInfo.value = connectData

    /**
     * P1：运行中实例查询世界状态（天数/季节），失败静默。
     *
     * 这个接口会向游戏下发一条 print 指令，服务端按 `instance.console:read` 把关，
     * 所以没有控制台读权限时同样不发请求。
     *
     * 刷新时**不清空**旧读数：清空会让「世界进程」那行在每次手动刷新与 30 秒轮询时消失一瞬，
     * 卡片高度塌一下再弹回来。只有实例停止（读数已无意义）或切实例时才真正清掉。
     */
    if (plan.worldState && isInstanceWorldReady(target)) {
      try {
        const res = await apiInstance.getInstanceWorldState(targetId, 'master')
        if (targetId === instanceId.value) {
          worldState.value = res.data
        }
      }
      catch {
        // 查询失败不阻塞详情页：保留上一次的读数，比清空更有用
      }
    }
    else {
      worldState.value = null
    }
  }
  catch {
    // 全局拦截器已提示错误原因
  }
  finally {
    if (!options?.silent) {
      loading.value = false
    }
  }
}

function goBack() {
  router.push(routeToNodeInstance())
}

function stopPolling() {
  stopStartupPolling()
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

function syncPolling() {
  stopPolling()
  if (!ownsCurrentPage()) {
    return
  }
  syncStartupPolling()
  if (instance.value?.status === 'running') {
    pollTimer = setInterval(() => {
      void loadDetail({ silent: true })
    }, DETAIL_POLL_MS)
  }
}

watch(() => instance.value?.status, () => syncPolling())
watch(instanceId, () => {
  // 组件被 keepAlive 缓存：离开详情页后 watch 仍会对全局 route.params 生效，
  // 别的页面（控制台 / 世界设置 / 房间设置）同样带 :instanceId，参数一变就会
  // 触发这里的重载，进而可能把用户从那些页面顶回实例管理列表。
  // 因此只在「本页被激活且当前路由就是详情页」时才响应。
  if (!ownsCurrentPage()) {
    return
  }
  instance.value = null
  cluster.value = null
  shardList.value = null
  onlinePlayers.value = null
  modList.value = null
  connectInfo.value = null
  worldState.value = null
  void loadDetail()
})

/**
 * 关停不能只挂在 KeepAlive 的生命周期上：`deactivated` 只在「缓存迁移」时触发，
 * 而 v-show 隐藏、整页转场卡住、KeepAlive 缓存被 prune 这三种情况都会绕过它——
 * 表现出来就是用户已经离开详情页，后台轮询还在按 30 秒一次发请求。
 * 路由变化是唯一不会漏的信号：当前路由不再是本页，立刻停掉轮询。
 */
watch(() => route.name, (name) => {
  if (name !== 'nodeInstanceDetail') {
    pageActive = false
    stopPolling()
  }
})

onMounted(() => {
  pageActive = true
  void loadDetail()
})

onActivated(() => {
  pageActive = true
  void loadDetail({ silent: true })
  // 返回页面时实例状态往往没变化，watch(status) 不会触发，必须显式恢复轮询
  syncPolling()
})

onDeactivated(() => {
  pageActive = false
  stopPolling()
})

onBeforeUnmount(() => {
  pageActive = false
  stopPolling()
})
</script>

<template>
  <FaPageMain main-class="!p-3 sm:!p-5" class="instance-detail-page">
    <template #title>
      <div class="flex flex-wrap items-center gap-3">
        <NButton size="small" quaternary aria-label="返回实例列表" @click="goBack">
          <template #icon><FaIcon name="i-lucide:arrow-left" /></template>
          返回列表
        </NButton>
        <h1 class="min-w-0 flex-1 break-words text-lg font-semibold">{{ pageTitle }}</h1>
        <NButton size="small" secondary :loading="loading" @click="() => loadDetail()">
          <template #icon><FaIcon name="i-lucide:refresh-cw" /></template>
          刷新
        </NButton>
      </div>
    </template>
    <NSpin v-if="loading && !instance" class="block mx-auto my-10" />
    <div v-else-if="instance" :key="instance.id" class="min-w-0 space-y-4">
      <InstanceControlCard :instance="instance" @refreshed="() => loadDetail({ silent: true })" />
      <NTabs :value="activeTab" type="line" @update:value="changeTab">
        <NTabPane name="overview" tab="概览" display-directive="show:lazy" :tab-props="keyboardTabProps(activeTab === 'overview')">
          <div class="min-w-0 space-y-4">
            <RoomOverviewCard v-if="instanceSupportsDstRoom(instance)" :instance="instance" :cluster="cluster"
              :online-players="onlinePlayers" :mod-list="modList" :connect-info="connectInfo" :loading="loading" />
            <WorldOverviewCard v-if="instanceSupportsDstRoom(instance) && hasPermission('world:read')" :instance="instance"
              :shard-list="shardList" :world-state="worldState" :loading="loading" @refreshed="() => loadDetail({ silent: true })" />
            <dl class="text-xs text-muted-foreground"><dt class="inline">实例 ID：</dt><dd class="inline break-all font-mono">{{ instance.id }}</dd></dl>
          </div>
        </NTabPane>
        <NTabPane v-if="availableTabs.includes('commands')" name="commands" tab="游戏指令" display-directive="show:lazy" :tab-props="keyboardTabProps(activeTab === 'commands')">
          <CommandCenterCard :instance="instance" :connect-info="connectInfo" @refreshed="() => loadDetail({ silent: true })" />
        </NTabPane>
        <NTabPane v-if="availableTabs.includes('files')" name="files" tab="文件管理" display-directive="show:lazy" :tab-props="keyboardTabProps(activeTab === 'files')">
          <InstanceFilesCard :instance-id="instance.id" />
        </NTabPane>
        <NTabPane v-if="availableTabs.includes('migration')" name="migration" tab="迁移" display-directive="show:lazy" :tab-props="keyboardTabProps(activeTab === 'migration')">
          <InstanceMigrationCard :instance-id="instance.id" :stopped="instance.status === 'stopped'" />
        </NTabPane>
      </NTabs>
    </div>
  </FaPageMain>
</template>
