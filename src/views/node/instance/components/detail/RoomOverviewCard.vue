<script setup lang="ts">
import type { InstanceItem } from '@/api/modules/instance'
import type { ClusterConfigDto, ClusterOnlinePlayersDto } from '@/api/modules/cluster'
import type { ModListDto } from '@/api/modules/mod'
import type { InstanceConnectInfo } from '@/api/modules/instance'
import { NButton, NCard, NEmpty, NSpin, NStatistic, NTag } from 'naive-ui'
import { computed } from 'vue'
import {
  routeToDstModList,
  routeToDstPlayerManage,
  routeToDstRoomSettings,
  routeToDstWorldSettings,
  routeToInstanceConsole,
} from '@/navigation/game-routes'
import { instanceSupportsDstRoom } from '@/composables/useGameInstance'
import { dstGameModeLabel } from '../../instanceCommandShortcuts'

defineOptions({
  name: 'InstanceDetailRoomOverviewCard',
})

const props = defineProps<{
  instance: InstanceItem | null
  cluster: ClusterConfigDto | null
  onlinePlayers: ClusterOnlinePlayersDto | null
  modList: ModListDto | null
  connectInfo: InstanceConnectInfo | null
  loading?: boolean
}>()

const router = useRouter()

/**
 * 这一卡片把四个权限点的数据拼在一屏里：没有权限的格子显示"—"，能用的按钮才出现。
 * 这里自己判权（而不是靠父级传"缺了哪几块"），按钮与格子用的是同一个判据，不会漂移。
 */
const { auth: hasPermission } = useAppAuth()
const canViewRoom = computed(() => hasPermission('room:read'))
const canViewPlayers = computed(() => hasPermission('player:read'))
const canViewMods = computed(() => hasPermission('mod:read'))
const canViewConsole = computed(() => hasPermission('instance.console:read'))
// 世界设置的入口在「世界管理」模块下（world:read），与本卡片的房间数据不是一个权限点
const canViewWorldSettings = computed(() => hasPermission('world:read'))

const isDst = computed(() => Boolean(props.instance && instanceSupportsDstRoom(props.instance)))
const installed = computed(() => Boolean(
  props.instance
  && props.instance.status !== 'pending_install'
  && props.instance.status !== 'installing',
))

const roomName = computed(() => props.cluster?.clusterName?.trim() || props.connectInfo?.roomName || '—')

/**
 * 联网模式只显示模式本身。
 *
 * 后端标签是给控制台「连接与加入」卡片用的，带了括号补充（例如「公网（Klei 列表）」）；
 * 房间概览这一格只需要模式名，括号里那截属于噪音。
 */
function stripParenthetical(label: string): string {
  return label.replace(/（[^）]*）/g, '').trim() || label
}

const networkModeLabel = computed(() => {
  const label = props.connectInfo?.networkModeLabel?.trim()
  if (label) {
    return stripParenthetical(label)
  }
  const mode = props.cluster?.networkMode
  if (mode === 'public') {
    return '公网'
  }
  if (mode === 'lan_only') {
    return '仅局域网'
  }
  if (mode === 'offline') {
    return '离线'
  }
  return '—'
})

const playerCountText = computed(() => {
  const online = props.onlinePlayers
  if (!online || !online.running || online.onlinePlayerCount === null) {
    return '—'
  }
  return `${online.onlinePlayerCount} / ${online.maxPlayers}`
})

/**
 * Mod 概览只认「已生效」：文件就绪且开关打开才会被房间加载。
 * 只数开关会漏掉没下载下来的 Mod（导入存档后尤其常见），
 * 于是面板显示满员、游戏里却只加载出有文件的那几个。
 */
const notReadyModCount = computed(() => props.modList?.mods.filter(mod => mod.installStatus !== 'ready').length ?? 0)

const modCountText = computed(() => {
  const mods = props.modList?.mods
  if (!mods) {
    return '—'
  }
  const effective = mods.filter(mod => mod.enabled && mod.installStatus === 'ready').length
  return `${effective} / ${mods.length}`
})

const cavesText = computed(() => {
  const enabled = props.cluster?.shardEnabled
  if (typeof enabled !== 'boolean') {
    return '—'
  }
  return enabled ? '已开启' : '未开启'
})

function goConsole() {
  if (props.instance) {
    router.push(routeToInstanceConsole(props.instance.id))
  }
}

/** 房间玩家页按实例打开：在线玩家、踢人封禁与三份名单都在那里 */
function goPlayerManage() {
  if (props.instance) {
    router.push(routeToDstPlayerManage(props.instance.id))
  }
}

function goRoomSettings() {
  if (props.instance) {
    router.push(routeToDstRoomSettings(props.instance.id))
  }
}

function goWorldSettings() {
  if (props.instance) {
    router.push(routeToDstWorldSettings(props.instance.id))
  }
}

function goMods() {
  router.push(routeToDstModList())
}
</script>

<template>
  <NCard title="房间概览" size="small">
    <NSpin v-if="loading && !instance" class="block mx-auto my-6" />
    <template v-else-if="instance">
      <div
        v-if="isDst && installed"
        class="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4 lg:grid-cols-6"
      >
        <NStatistic label="房间名" :value="canViewRoom ? roomName : '—'" />
        <NStatistic label="游戏模式">
          {{ canViewRoom ? dstGameModeLabel(cluster?.gameMode) : '—' }}
        </NStatistic>
        <NStatistic label="联网模式">
          {{ canViewRoom || canViewConsole ? networkModeLabel : '—' }}
        </NStatistic>
        <NStatistic label="在线玩家">
          <span :class="onlinePlayers?.running ? '' : 'text-muted-foreground'">
            {{ canViewPlayers ? playerCountText : '—' }}
          </span>
        </NStatistic>
        <NStatistic label="Mod（已生效 / 总数）">
          {{ canViewMods ? modCountText : '—' }}
          <NTag
            v-if="canViewMods && notReadyModCount > 0"
            size="tiny"
            :bordered="false"
            type="warning"
            class="ml-1"
          >
            {{ notReadyModCount }} 个未就绪
          </NTag>
        </NStatistic>
        <NStatistic label="洞穴">
          <NTag size="small" :bordered="false" :type="cavesText === '已开启' ? 'success' : 'default'">
            {{ canViewRoom ? cavesText : '—' }}
          </NTag>
        </NStatistic>
      </div>
      <NEmpty
        v-else-if="isDst"
        description="实例尚未完成安装，安装完成后可在此查看房间信息"
        size="small"
      />
      <NEmpty
        v-else
        description="当前游戏暂不支持房间配置，仅饥荒（DST）实例提供房间概览"
        size="small"
      />
      <!--
        快捷入口按各自的权限点出现：这些跳转是**按路由名**的，而面板的路由按权限动态注册
        （`routeBaseOn: 'backend'`），无权时目标路由根本不存在——点下去不是"进不去"，
        而是在路由解析阶段直接抛 `No match`，按钮看起来完全失灵。
      -->
      <div v-if="installed" class="mt-4 flex flex-wrap gap-2">
        <NButton v-if="canViewConsole" size="small" secondary @click="goConsole">
          控制台
        </NButton>
        <NButton v-if="isDst && canViewPlayers" size="small" secondary @click="goPlayerManage">
          玩家管理
        </NButton>
        <template v-if="isDst">
          <NButton v-if="canViewRoom" size="small" secondary @click="goRoomSettings">
            房间设置
          </NButton>
          <NButton v-if="canViewWorldSettings" size="small" secondary @click="goWorldSettings">
            世界设置
          </NButton>
          <NButton v-if="canViewMods" size="small" secondary @click="goMods">
            Mod 管理
          </NButton>
        </template>
      </div>
    </template>
    <NEmpty v-else description="未找到实例" size="small" />
  </NCard>
</template>
