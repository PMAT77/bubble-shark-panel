<script setup lang="ts">
import type { InstanceSummaryItem } from '@/api/modules/instance'
import type { PlayerListKind, PlayerOnlineEntry, PlayerOnlineRosterDto } from '@/api/modules/player'
import { NAlert, NButton, NSpin, NTag, useDialog, useMessage } from 'naive-ui'
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import OnlinePlayersPanel from './components/OnlinePlayersPanel.vue'
import PlayerListsPanel from './components/PlayerListsPanel.vue'
import apiInstance from '@/api/modules/instance'
import apiCluster from '@/api/modules/cluster'
import apiPlayer from '@/api/modules/player'
import { instanceSupportsDstRoom } from '@/composables/useGameInstance'
import { statusTagType } from '@/constants/statusDictionary'
import { routeToDstPlayerList } from '@/navigation/game-routes'
import { getInstanceState } from '@/views/node/instance/instanceDisplay'

defineOptions({
  name: 'DstPlayerManage',
})

/** 在线玩家刷新间隔：查询要走一次游戏控制台，太密会打扰服务器日志 */
const ONLINE_POLL_MS = 15000

const LIST_LABELS: Record<PlayerListKind, string> = {
  admin: '管理员',
  whitelist: '白名单',
  block: '黑名单',
}

const route = useRoute()
const router = useRouter()
/** 按钮级与"这一请求该不该发"的判定；后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()
const dialog = useDialog()
const message = useMessage()

const instanceId = computed(() => String(route.params.instanceId ?? ''))
const instance = ref<InstanceSummaryItem | null>(null)
const instanceLoaded = ref(false)
const roster = ref<PlayerOnlineRosterDto | null>(null)
const rosterLoading = ref(false)
const rosterError = ref<string | null>(null)
const actingKuId = ref<string | null>(null)
/** 白名单预留位：来自房间配置，为 0 时白名单不生效 */
const whitelistSlots = ref(0)
let pageActive = false

const listPanel = ref<InstanceType<typeof PlayerListsPanel> | null>(null)

const state = computed(() => (instance.value ? getInstanceState(instance.value) : null))
const onlineKuIds = computed(() => (roster.value?.players ?? []).map(player => player.kuId))

async function loadInstance() {
  try {
    // 只拿实例标识：本页在「玩家管理」模块下，不需要也不该要求「查看实例」
    const response = await apiInstance.getInstanceOptions()
    const list = response.data ?? []
    instance.value = list.find(item => item.id === instanceId.value) ?? null
  }
  catch {
    // 业务错误由全局拦截器提示
  }
  finally {
    instanceLoaded.value = true
  }
}

async function loadWhitelistSlots() {
  /**
   * 白名单预留位是房间配置（`room:read`），本页只有 `player:read`：
   * 无权时不发这个请求（会 403），按"未启用"处理——名单面板自己会再校正一次。
   */
  if (!hasPermission('room:read')) {
    whitelistSlots.value = 0
    return
  }
  try {
    const { data } = await apiCluster.getClusterConfig(instanceId.value)
    whitelistSlots.value = data.whitelistSlots
  }
  catch {
    // 读不到房间配置时按未启用处理，名单面板自己也会用接口返回值再校正一次
    whitelistSlots.value = 0
  }
}

async function loadRoster(options?: { silent?: boolean }) {
  if (!instanceId.value) {
    return
  }
  if (!options?.silent) {
    rosterLoading.value = true
  }
  try {
    const { data } = await apiPlayer.getOnlinePlayers(instanceId.value)
    roster.value = data
    rosterError.value = null
  }
  catch (error) {
    rosterError.value = error instanceof Error ? error.message : '读取在线玩家失败'
  }
  finally {
    rosterLoading.value = false
  }
}

const poller = usePollingTask(async () => {
  await loadRoster({ silent: true })
}, { intervalMs: ONLINE_POLL_MS, immediate: false })

function syncPolling() {
  if (!pageActive) {
    return
  }
  if (instance.value?.status === 'running') {
    poller.start()
  }
  else {
    poller.stop()
  }
}

watch(() => instance.value?.status, () => syncPolling())

async function reloadAll() {
  await Promise.all([loadInstance(), loadWhitelistSlots(), loadRoster()])
  syncPolling()
}

function displayName(player: PlayerOnlineEntry): string {
  return player.name.trim() || player.kuId
}

/**
 * 结果提示：后端给的是通用句子（它不知道玩家昵称），界面把「该玩家」换成实际名字。
 *
 * 后端只在下发后复查在线名单确认玩家离开时才给 verified；失败时它给出的也是
 * 下一步动作（改用封禁），而不是解释命令为什么没生效的长句——那种话该进日志。
 */
function notifyActionResult(verified: boolean, text: string, player: PlayerOnlineEntry) {
  const content = text.replace('该玩家', `「${displayName(player)}」`)
  if (verified) {
    message.success(content)
    return
  }
  message.warning(content, { duration: 8000 })
}

/**
 * 弹窗里的按钮要能自己说明「正在做」。
 *
 * 一次踢出 / 封禁要下发命令再复查在线名单，成功也要一两秒、失败可能更久；
 * 这段时间里按钮转圈并禁用，弹窗保持打开，结果出来才关闭——否则点了没反应，
 * 管理员只会以为按钮坏了、再点一次。
 */
interface PendingDialog {
  loading?: boolean
  closable?: boolean
}

async function performKick(player: PlayerOnlineEntry, pending?: PendingDialog) {
  if (actingKuId.value) {
    return
  }
  actingKuId.value = player.kuId
  if (pending) {
    pending.loading = true
    pending.closable = false
  }
  try {
    const { data } = await apiPlayer.kickPlayer({ instanceId: instanceId.value, kuId: player.kuId })
    notifyActionResult(data.verified, data.message, player)
    await loadRoster({ silent: true })
  }
  catch {
    // 业务错误（实例未运行、命令未送达等）由全局拦截器提示
  }
  finally {
    actingKuId.value = null
    // onPositiveClick 返回的 Promise 结束后 naive-ui 才关闭弹窗；这里只负责复位按钮
    if (pending) {
      pending.loading = false
    }
  }
}

async function performBan(player: PlayerOnlineEntry, pending?: PendingDialog) {
  if (actingKuId.value) {
    return
  }
  actingKuId.value = player.kuId
  if (pending) {
    pending.loading = true
    pending.closable = false
  }
  try {
    const { data } = await apiPlayer.banPlayer({ instanceId: instanceId.value, kuId: player.kuId })
    notifyActionResult(data.verified, data.message, player)
    await loadRoster({ silent: true })
    await listPanel.value?.loadAll()
  }
  catch {
    // 业务错误由全局拦截器提示
  }
  finally {
    actingKuId.value = null
    if (pending) {
      pending.loading = false
    }
  }
}

function confirmKick(player: PlayerOnlineEntry) {
  const dialogRef = dialog.warning({
    title: '踢出玩家',
    content: `将把「${displayName(player)}」踢出房间。对方可以立刻重新加入，如需禁止再加入请用封禁。`,
    positiveText: '踢出',
    negativeText: '取消',
    // 执行期间不允许点遮罩关掉：请求会继续跑，结果提示却看不到
    maskClosable: false,
    onPositiveClick: () => performKick(player, dialogRef),
  })
}

function confirmBan(player: PlayerOnlineEntry) {
  const dialogRef = dialog.warning({
    title: '封禁玩家',
    content: `将把「${displayName(player)}」加入黑名单并立刻踢出，之后他无法再加入房间；房间重启后依然有效。`,
    positiveText: '封禁',
    negativeText: '取消',
    maskClosable: false,
    onPositiveClick: () => performBan(player, dialogRef),
  })
}

/** 从在线玩家直接加入名单：先读当前名单再整体写回，避免覆盖别处的改动 */
async function addOnlinePlayerToList(payload: { player: PlayerOnlineEntry, kind: PlayerListKind }) {
  const { player, kind } = payload
  try {
    const { data } = await apiPlayer.getPlayerList(instanceId.value, kind)
    const exists = data.entries.some(entry => entry.kuId.toLowerCase() === player.kuId.toLowerCase())
    if (exists) {
      message.warning(`「${displayName(player)}」已经在${LIST_LABELS[kind]}名单里了`)
      return
    }
    await apiPlayer.savePlayerList({
      instanceId: instanceId.value,
      kind,
      entries: [...data.entries.map(entry => ({ kuId: entry.kuId })), { kuId: player.kuId }],
    })
    await listPanel.value?.loadAll()
    message.success(`已把「${displayName(player)}」加入${LIST_LABELS[kind]}名单`)
  }
  catch {
    // 业务错误由全局拦截器提示
  }
}

function goBack() {
  router.push(routeToDstPlayerList())
}

onMounted(() => {
  pageActive = true
  void reloadAll()
})

onActivated(() => {
  pageActive = true
  void reloadAll()
})

onDeactivated(() => {
  pageActive = false
  poller.stop()
})

onBeforeUnmount(() => {
  pageActive = false
  poller.stop()
})

watch(instanceId, () => {
  roster.value = null
  whitelistSlots.value = 0
  void reloadAll()
})
</script>

<template>
  <FaPageMain>
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2 min-w-0">
          <NButton size="small" quaternary @click="goBack">
            <template #icon>
              <FaIcon name="i-lucide:arrow-left" />
            </template>
            返回玩家列表
          </NButton>
          <span class="font-medium truncate">{{ instance?.name ?? '玩家管理' }}</span>
          <NTag v-if="state" size="small" :bordered="false" :type="statusTagType(state.tone)">
            {{ state.label }}
          </NTag>
        </div>
        <div class="flex flex-wrap gap-2">
          <NButton size="small" secondary :loading="rosterLoading" @click="reloadAll">
            刷新
          </NButton>
        </div>
      </div>

      <p class="text-sm text-muted-foreground">
        在这里集中管理玩家：看谁在线、踢人、封禁，以及维护管理员 / 白名单 / 黑名单三份名单。
        名单里显示的是玩家名字，保存时写入的仍是玩家 ID。
      </p>

      <NAlert v-if="rosterError" type="error" :bordered="false" title="读取在线玩家失败">
        {{ rosterError }}
      </NAlert>

      <NSpin v-if="!instanceLoaded" :show="true" class="block py-10" />

      <NAlert v-else-if="!instance" type="warning" :bordered="false">
        找不到这个实例，它可能已经被删除。请返回玩家列表重新选择。
      </NAlert>

      <template v-else-if="!instanceSupportsDstRoom(instance)">
        <NAlert type="warning" :bordered="false">
          这个实例不是饥荒（DST）房间，玩家管理只对饥荒房间可用。
        </NAlert>
      </template>

      <template v-else>
        <OnlinePlayersPanel
          :roster="roster"
          :loading="rosterLoading"
          :acting-ku-id="actingKuId"
          @kick="confirmKick"
          @ban="confirmBan"
          @add-to-list="addOnlinePlayerToList"
        />

        <PlayerListsPanel
          ref="listPanel"
          :instance-id="instanceId"
          :whitelist-slots="whitelistSlots"
          :online-ku-ids="onlineKuIds"
          :instance-running="instance?.status === 'running'"
          @changed="reloadAll"
        />
      </template>
    </div>
  </FaPageMain>
</template>
