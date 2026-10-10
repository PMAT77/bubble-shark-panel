<script setup lang="ts">
import { createConsoleLogBuffer } from './consoleLogBuffer'
import type { InstanceConnectInfo, InstanceConsoleLogFilter, InstanceConsoleLogLine, InstanceItem, InstanceMaintenancePushLog } from '@/api/modules/instance'
import apiInstance from '@/api/modules/instance'
import { routeToNodeInstance } from '@/navigation/game-routes'
import { copyTextToClipboard } from '@/utils/copyToClipboard'
import { consoleLogShardLabel, filterConsoleLines, formatConsoleLogLineForCopy, isCommandEcho } from './consoleLogDisplay'
import { formatDateTime } from './utils'
import { getInstanceState, resolveRuntimeReadinessView } from './instanceDisplay'
import { useInstanceStartup } from './composables/useInstanceStartup'
import InstanceStartupProgress from './components/InstanceStartupProgress.vue'
import type { InstanceConsoleCommandShard } from '@/api/modules/instance'
import {
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NEmpty,
  NInput,
  NModal,
  NRadioButton,
  NRadioGroup,
  NSpace,
  NSpin,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
  NTooltip,
  useDialog,
} from 'naive-ui'

defineOptions({
  name: 'NodeInstanceConsole',
})

type ConsoleTab = 'console' | 'maintenance'

/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()

const route = useRoute()
const router = useRouter()
const dialog = useDialog()
const appAccountStore = useAppAccountStore()

const instanceId = computed(() => String(route.params.instanceId ?? ''))
const instanceName = ref('')
const instanceStatus = ref<InstanceItem['status'] | null>(null)
const consoleInstances = ref<InstanceItem[]>([])
const { syncStartupPolling, stopStartupPolling } = useInstanceStartup(consoleInstances, (id, startup) => {
  consoleInstances.value = consoleInstances.value.map(item => item.id === id ? { ...item, startup } : item)
}, () => { if (ownsCurrentPage()) void loadInstanceMeta() })
const consoleState = computed(() => consoleInstances.value[0] ? getInstanceState(consoleInstances.value[0]) : null)
const startupReadiness = computed(() => consoleInstances.value[0] ? resolveRuntimeReadinessView(consoleInstances.value[0]) : null)
const logs = ref<InstanceConsoleLogLine[]>([])
const connectInfo = ref<InstanceConnectInfo | null>(null)
const connectInfoLoading = ref(false)
const running = ref(false)
const activeTab = ref<ConsoleTab>('console')
const commandInput = ref('')
const commandShard = ref<InstanceConsoleCommandShard>('master')
const commandSending = ref(false)
const maintenanceMessage = ref('')
const maintenanceDraftUpdatedAt = ref<string | null>(null)
const maintenancePushLogs = ref<InstanceMaintenancePushLog[]>([])
const maintenanceLoading = ref(false)
const maintenanceSaving = ref(false)
const maintenancePushing = ref(false)
const autoScroll = ref(true)
const logViewportRef = ref<HTMLElement | null>(null)

let eventSource: EventSource | null = null
let pollTimer: ReturnType<typeof setInterval> | undefined
let connectInfoTimer: ReturnType<typeof setInterval> | undefined
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let streamRequestVersion = 0
let connectInfoRequest: Promise<void> | null = null
let logsRefreshRequest: Promise<void> | null = null
let realtimeActive = false
let initializing = false

/**
 * 路由对本页开启了 keepAlive：离开控制台时组件不会卸载，在途请求与 watch 都还活着。
 * 只有「本页正被激活」且「当前路由就是控制台」时才允许它自己导航或重连，
 * 否则用户会在别的页面上被后台逻辑顶回实例管理列表。
 */
let pageActive = true
const isConsoleRouteActive = computed(() => route.name === 'nodeInstanceConsole')

function ownsCurrentPage() {
  return pageActive && isConsoleRouteActive.value
}

const pageTitle = computed(() => instanceName.value
  ? `实例控制台 · ${instanceName.value}`
  : '实例控制台')

/**
 * 日志流推的是全量行（面板消息 + 游戏输出），这里的过滤只作用于展示与复制。
 * 命令回显与它的执行结果因此落在同一视图内，不再需要来回切换页签。
 */
const logFilter = ref<InstanceConsoleLogFilter>('all')

const displayedLogs = computed(() => filterConsoleLines(logs.value, logFilter.value))

const consoleShards = computed(() => connectInfo.value?.consoleShards)

const cavesCommandAvailable = computed(() => Boolean(
  consoleShards.value?.cavesConfigured && consoleShards.value?.cavesRunning,
))

const cavesCommandDisabledHint = computed(() => {
  if (!consoleShards.value?.cavesConfigured) {
    return '未启用洞穴'
  }
  if (!consoleShards.value.cavesRunning) {
    return '洞穴未运行'
  }
  return ''
})

const emptyLogHint = '暂无日志，启动实例后显示'

/**
 * 命令回显用琥珀色加粗突出：合并视图里游戏日志很吵，
 * 用户需要能一眼定位「这条是我刚发的命令」，紧随其后的就是它的输出。
 */
function streamClass(line: InstanceConsoleLogLine) {
  if (isCommandEcho(line)) {
    return 'text-amber-300 font-medium'
  }
  switch (line.stream) {
    case 'stderr':
      return 'text-rose-400'
    case 'system':
      return 'text-sky-400'
    default:
      return 'text-foreground/90'
  }
}

function scrollToBottom() {
  if (!autoScroll.value) {
    return
  }
  nextTick(() => {
    const el = logViewportRef.value
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  })
}

const logBuffer = createConsoleLogBuffer<InstanceConsoleLogLine>((lines) => {
  logs.value = lines
  if (activeTab.value === 'console') scrollToBottom()
})
const appendLines = logBuffer.append

async function loadInstanceMeta() {
  const res = await apiInstance.getInstanceList()
  const list = res.data as InstanceItem[]
  const target = list.find((item: InstanceItem) => item.id === instanceId.value)
  if (!target) {
    // 被缓存在别的路由上时保持静默：返回控制台后 onActivated 会重新检测
    if (ownsCurrentPage()) {
      faToast.warning('实例不存在或已删除')
      router.replace(routeToNodeInstance())
    }
    return
  }
  instanceName.value = target.name
  instanceStatus.value = target.status
  consoleInstances.value = [target]
}

async function loadConnectInfo(options?: { silent?: boolean }) {
  if (!instanceId.value) {
    return
  }
  if (connectInfoRequest) {
    return connectInfoRequest
  }
  const targetInstanceId = instanceId.value
  const request = (async () => {
    if (!options?.silent) {
      connectInfoLoading.value = true
    }
    try {
      const res = await apiInstance.getInstanceConnectInfo(targetInstanceId)
      if (targetInstanceId !== instanceId.value) {
        return
      }
      connectInfo.value = res.data
      running.value = res.data.running
      if (!connectModeApplied) {
        connectModeApplied = true
        connectDisplayMode.value = res.data.preferredMode
      }
    }
    catch {
      if (targetInstanceId === instanceId.value) {
        connectInfo.value = null
      }
    }
    finally {
      if (!options?.silent) {
        connectInfoLoading.value = false
      }
    }
  })()
  connectInfoRequest = request
  try {
    await request
  }
  finally {
    if (connectInfoRequest === request) {
      connectInfoRequest = null
    }
  }
}

async function loadMaintenanceAnnounce() {
  if (!instanceId.value) {
    return
  }
  maintenanceLoading.value = true
  try {
    const res = await apiInstance.getInstanceMaintenanceAnnounce(instanceId.value)
    maintenanceMessage.value = res.data.draft.message
    maintenanceDraftUpdatedAt.value = res.data.draft.updatedAt
    maintenancePushLogs.value = res.data.recentPushes
  }
  catch {
    maintenancePushLogs.value = []
  }
  finally {
    maintenanceLoading.value = false
  }
}

async function saveMaintenanceDraft() {
  const message = maintenanceMessage.value.trim()
  if (!message) {
    faToast.warning('请先输入公告内容')
    return
  }
  maintenanceSaving.value = true
  try {
    const res = await apiInstance.saveInstanceMaintenanceAnnounceDraft(instanceId.value, message)
    maintenanceMessage.value = res.data.draft.message
    maintenanceDraftUpdatedAt.value = res.data.draft.updatedAt
    maintenancePushLogs.value = res.data.recentPushes
    faToast.success('公告草稿已保存')
  }
  finally {
    maintenanceSaving.value = false
  }
}

function confirmPushMaintenanceAnnounce() {
  const message = maintenanceMessage.value.trim()
  if (!message) {
    faToast.warning('请先输入公告内容')
    return
  }
  dialog.info({
    title: '推送到游戏房间',
    content: '将向主世界在线玩家广播此公告。确认推送？',
    positiveText: '确认推送',
    negativeText: '取消',
    onPositiveClick: () => pushMaintenanceAnnounce(message),
  })
}

async function pushMaintenanceAnnounce(message: string) {
  maintenancePushing.value = true
  try {
    const res = await apiInstance.pushInstanceMaintenanceAnnounce(instanceId.value, message)
    maintenancePushLogs.value = [
      res.data.pushLog,
      ...maintenancePushLogs.value.filter(item => item.id !== res.data.pushLog.id),
    ]
    if (res.data.isSuccess) {
      faToast.success('维护公告已推送到游戏房间')
      await refreshLogs()
      await loadMaintenanceAnnounce()
    }
    else {
      faToast.error(res.data.errorMessage ?? '推送失败')
    }
  }
  finally {
    maintenancePushing.value = false
  }
}

function formatMaintenancePushStatus(status: InstanceMaintenancePushLog['status']) {
  return status === 'success' ? '成功' : '失败'
}

function maintenancePushStatusTagType(status: InstanceMaintenancePushLog['status']) {
  return status === 'success' ? 'success' : 'error'
}

async function refreshLogs() {
  if (!instanceId.value) {
    return
  }
  if (logsRefreshRequest) {
    return logsRefreshRequest
  }
  const targetInstanceId = instanceId.value
  const request = (async () => {
    const lastId = logs.value.at(-1)?.id ?? 0
    // 固定拉全量：afterId 取的是本地最大 id，若按页签只拉某一类流，
    // 另一类行会被这个 id 永久跳过（实时流断开时表现为丢日志）。
    const res = await apiInstance.getInstanceConsoleLogs(targetInstanceId, lastId, 'all')
    if (targetInstanceId !== instanceId.value) {
      return
    }
    running.value = res.data.running
    appendLines(res.data.lines)
  })()
  logsRefreshRequest = request
  try {
    await request
  }
  finally {
    if (logsRefreshRequest === request) {
      logsRefreshRequest = null
    }
  }
}

async function connectStream() {
  if (!appAccountStore.isLogin || !instanceId.value) {
    return
  }
  const requestVersion = ++streamRequestVersion
  const targetInstanceId = instanceId.value
  eventSource?.close()
  eventSource = null
  let streamTicket: string
  try {
    const response = await apiInstance.createInstanceConsoleStreamTicket(targetInstanceId)
    streamTicket = response.data.ticket
  }
  catch {
    scheduleStreamReconnect()
    return
  }
  if (requestVersion !== streamRequestVersion || instanceId.value !== targetInstanceId) {
    return
  }
  let source: EventSource
  try {
    source = new EventSource(apiInstance.buildInstanceConsoleStreamUrl(targetInstanceId, streamTicket))
  }
  catch {
    // 地址构造失败（例如构建期未注入接口前缀）不能让实时日志静默消失：
    // 退回轮询并安排重连，用户至少能看到日志在刷新
    scheduleStreamReconnect()
    return
  }
  eventSource = source
  source.addEventListener('ready', (event) => {
    if (eventSource !== source || requestVersion !== streamRequestVersion) return
    clearStreamReconnect()
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { running?: boolean }
      running.value = Boolean(payload.running)
    }
    catch {
      // ignore malformed payload
    }
  })
  source.addEventListener('log', (event) => {
    if (eventSource !== source || requestVersion !== streamRequestVersion) return
    try {
      const line = JSON.parse((event as MessageEvent<string>).data) as InstanceConsoleLogLine
      appendLines([line])
    }
    catch {
      // ignore malformed payload
    }
  })
  source.onerror = () => {
    if (eventSource !== source) {
      return
    }
    source.close()
    eventSource = null
    scheduleStreamReconnect()
  }
}

function clearStreamReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }
}

function scheduleStreamReconnect() {
  if (!realtimeActive || reconnectTimer || !appAccountStore.isLogin || !instanceId.value) {
    return
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    void connectStream()
  }, 3000)
}

function startRealtimeJobs() {
  realtimeActive = true
  if (hasPermission('instance:read')) syncStartupPolling()
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      void refreshLogs().catch(() => undefined)
    }, 5000)
  }
  if (!connectInfoTimer) {
    connectInfoTimer = setInterval(() => {
      void loadConnectInfo({ silent: true })
    }, 30000)
  }
}

function stopRealtimeJobs() {
  stopStartupPolling()
  logBuffer.flush()
  realtimeActive = false
  clearStreamReconnect()
  streamRequestVersion += 1
  eventSource?.close()
  eventSource = null
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
  if (connectInfoTimer) {
    clearInterval(connectInfoTimer)
    connectInfoTimer = undefined
  }
}

function resetInstanceRuntimeState() {
  consoleInstances.value = []
  instanceName.value = ''
  instanceStatus.value = null
  logBuffer.clear()
  connectInfo.value = null
  connectModeApplied = false
  running.value = false
  maintenanceMessage.value = ''
  maintenanceDraftUpdatedAt.value = null
  maintenancePushLogs.value = []
  commandInput.value = ''
  commandShard.value = 'master'
}

async function initInstanceConsole() {
  if (!instanceId.value) {
    if (ownsCurrentPage()) {
      goBack()
    }
    return
  }
  await loadInstanceMeta()
  if (!ownsCurrentPage()) {
    return
  }
  await loadConnectInfo()
  await loadMaintenanceAnnounce()
  await refreshLogs()
}

async function activateConsole() {
  if (realtimeActive || initializing || !instanceId.value) {
    return
  }
  initializing = true
  try {
    await initInstanceConsole()
    // 初始化期间用户可能已离开控制台：此时不要再建连与开轮询
    if (!ownsCurrentPage()) {
      return
    }
    void connectStream()
    startRealtimeJobs()
  }
  finally {
    initializing = false
  }
}

async function sendCommand(command?: string) {
  const text = (command ?? commandInput.value).trim()
  if (!text || commandSending.value) {
    return
  }
  commandSending.value = true
  try {
    await apiInstance.sendInstanceConsoleCommand(instanceId.value, text, commandShard.value)
    if (!command) {
      commandInput.value = ''
    }
    faToast.success('命令已发送')
  }
  finally {
    commandSending.value = false
  }
}

function confirmDangerousCommand(command: string, title: string, content: string) {
  dialog.warning({
    title,
    content,
    positiveText: '确认执行',
    negativeText: '取消',
    onPositiveClick: () => sendCommand(command),
  })
}

const quickCommands = [
  { label: '保存', command: 'c_save()' },
  { label: '回档 1 天', command: 'c_rollback(1)' },
  { label: '回档 2 天', command: 'c_rollback(2)' },
  { label: '回档 3 天', command: 'c_rollback(3)' },
]

async function clearLogs() {
  await apiInstance.clearInstanceConsoleLogs(instanceId.value)
  logBuffer.clear()
}

async function copyLogs() {
  // 复制当前可见内容：所见即所得，过滤档位不同则复制结果不同
  const source = displayedLogs.value
  const text = source.map(line => formatConsoleLogLineForCopy(line)).join('\n')
  if (!text) {
    faToast.warning('暂无日志可复制')
    return
  }
  const ok = await copyTextToClipboard(text)
  if (!ok) {
    faToast.error('复制失败，请手动选中日志文本复制')
    return
  }
  faToast.success('日志已复制')
}

const logHistoryVisible = ref(false)
const logHistoryLoading = ref(false)
const logHistoryAvailable = ref(false)
const logHistoryContent = ref('')
const logDownloading = ref(false)

/** 历史日志：内存里只有最近 2000 行，落盘文件能翻到面板重启之前的记录 */
async function openLogHistory() {
  if (!instanceId.value) {
    return
  }
  logHistoryVisible.value = true
  logHistoryLoading.value = true
  try {
    const { data } = await apiInstance.getInstanceConsoleLogHistory(instanceId.value)
    logHistoryAvailable.value = data.available
    logHistoryContent.value = data.content
  }
  catch {
    logHistoryAvailable.value = false
    logHistoryContent.value = ''
    faToast.error('读取历史日志失败')
  }
  finally {
    logHistoryLoading.value = false
  }
}

async function downloadLogs() {
  if (!instanceId.value || logDownloading.value) {
    return
  }
  logDownloading.value = true
  try {
    const { data } = await apiInstance.downloadInstanceConsoleLog(instanceId.value)
    const url = URL.createObjectURL(data)
    const link = document.createElement('a')
    link.href = url
    link.download = `${instanceName.value || instanceId.value}-console.log`
    link.click()
    URL.revokeObjectURL(url)
  }
  catch {
    faToast.error('下载日志失败：实例还没启动过，或日志文件已被清理')
  }
  finally {
    logDownloading.value = false
  }
}

type ConnectCopyMode = 'public' | 'local' | 'lan'

const connectDisplayMode = ref<ConnectCopyMode>('public')
// 只在首次拿到 connectInfo 时套用面板推荐档位，避免轮询覆盖用户的手动切换
let connectModeApplied = false

const availableConnectModes: ConnectCopyMode[] = ['public', 'local', 'lan']

const connectDisplayBlock = computed(() => {
  const info = connectInfo.value
  if (!info) {
    return null
  }
  if (connectDisplayMode.value === 'local') {
    return {
      title: '本机进服',
      command: info.localCommand,
      hint: '游戏和面板在同一台电脑上时用这一档。',
    }
  }
  if (connectDisplayMode.value === 'lan') {
    return {
      title: '局域网进服',
      command: info.lanCommand ?? '',
      hint: info.lanCommand
        ? '同一 WiFi 或内网的其他电脑用这一档。'
        : '没能自动识别内网地址，请在服务器上查看本机 IP 后手动填写。',
    }
  }
  return {
    title: '公网 / 对外',
    command: info.command,
    hint: '云服务器，或已做端口映射的独立主机用这一档。',
  }
})

const canCopyConnectDisplay = computed(() => {
  const block = connectDisplayBlock.value
  return Boolean(block?.command?.trim())
})

const connectModeToggleTitle = computed(() => {
  const idx = availableConnectModes.indexOf(connectDisplayMode.value)
  const next = availableConnectModes[(idx + 1) % availableConnectModes.length]
  const nextLabel = next === 'local' ? '本机' : next === 'lan' ? '局域网' : '公网'
  return `切换为${nextLabel}直连命令`
})

function cycleConnectDisplayMode() {
  const idx = availableConnectModes.indexOf(connectDisplayMode.value)
  connectDisplayMode.value = availableConnectModes[(idx + 1) % availableConnectModes.length]!
}

async function copyConnectCommand(mode: ConnectCopyMode) {
  const info = connectInfo.value
  if (!info) {
    faToast.warning('暂无直连命令')
    return
  }
  const command = mode === 'local'
    ? info.localCommand
    : mode === 'lan'
      ? info.lanCommand
      : info.command
  if (!command?.trim()) {
    faToast.warning('暂无直连命令')
    return
  }
  const ok = await copyTextToClipboard(command)
  if (!ok) {
    faToast.error('复制失败，请手动选中命令文本复制')
    return
  }
  const label = mode === 'local' ? '本机直连' : mode === 'lan' ? '局域网直连' : '公网直连'
  faToast.success(`${label}命令已复制`)
}

const udpPortsLabel = computed(() => {
  const ports = connectInfo.value?.udpPorts
  if (!ports?.length) {
    return ''
  }
  return ports.join('、')
})

function goBack() {
  router.push(routeToNodeInstance())
}

watch(consoleShards, (shards) => {
  if (commandShard.value === 'caves' && shards && !shards.cavesRunning) {
    commandShard.value = 'master'
  }
})

watch(activeTab, (tab) => {
  if (tab === 'console') {
    scrollToBottom()
  }
})

// 切换过滤档位后视图内容整体变化，同样贴到底部看最新几行
watch(logFilter, () => {
  scrollToBottom()
})

watch(running, (value) => {
  if (value) {
    void loadConnectInfo()
  }
})

watch(instanceId, async (nextId, prevId) => {
  // 组件被 keepAlive 缓存（key 为路由名，切换实例由本页内部处理重连）：
  // 离开控制台后 watch 仍对全局 route.params 生效，别的页面同样带 :instanceId，
  // 参数一变就会在后台重连日志流、甚至在实例不存在时把用户顶走。
  if (!ownsCurrentPage()) {
    return
  }
  if (!nextId || nextId === prevId) {
    return
  }
  stopRealtimeJobs()
  resetInstanceRuntimeState()
  await activateConsole()
})

/**
 * 关停不能只挂在 KeepAlive 的生命周期上：`deactivated` 只在「缓存迁移」时触发，
 * 而 v-show 隐藏、整页转场卡住、KeepAlive 缓存被 prune 这三种情况都会绕过它——
 * 表现出来就是用户已经离开控制台，日志流却在后台一直重连。
 * 路由变化是唯一不会漏的信号：当前路由不再是本页，立刻停掉重连与轮询。
 */
watch(() => route.name, (name) => {
  if (name !== 'nodeInstanceConsole') {
    pageActive = false
    stopRealtimeJobs()
  }
})

onMounted(() => {
  pageActive = true
  void activateConsole()
})

onActivated(() => {
  pageActive = true
  void activateConsole()
})

onDeactivated(() => {
  pageActive = false
  stopRealtimeJobs()
})

onBeforeUnmount(() => {
  pageActive = false
  stopRealtimeJobs()
})
</script>

<template>
  <FaPageMain :title="pageTitle">
    <div class="space-y-4">
      <div class="flex flex-wrap gap-2 items-center justify-between">
        <NSpace size="small">
          <NTag :type="consoleState?.tone === 'warning' ? 'warning' : consoleState?.tone === 'error' ? 'error' : running ? 'success' : 'default'" size="small">
            {{ consoleState?.label ?? (running ? '进程运行中' : '未运行') }}
          </NTag>
          <span v-if="startupReadiness" class="text-xs text-muted-foreground">{{ startupReadiness.label }}</span>
        </NSpace>
        <FaButton variant="outline" size="sm" @click="goBack">
          返回实例列表
        </FaButton>
      </div>

      <InstanceStartupProgress :startup="consoleInstances[0]?.startup" :show-resources="hasPermission('instance:read')" @resources="router.push({ name: 'nodeInstanceDetail', params: { instanceId }, hash: '#instance-resources' })" />

      <NCard title="连接与加入" size="small">
        <NSpin v-if="connectInfoLoading && !connectInfo" class="block mx-auto my-6" />
        <template v-else-if="connectInfo">
          <NDescriptions :column="1" label-placement="left" size="small" class="mb-3">
            <NDescriptionsItem label="房间名">
              {{ connectInfo.roomName }}
            </NDescriptionsItem>
            <NDescriptionsItem label="联网模式">
              {{ connectInfo.networkModeLabel }}
            </NDescriptionsItem>
            <NDescriptionsItem label="连接地址">
              {{ connectInfo.host }}:{{ connectInfo.port }}
              <span class="text-muted-foreground ml-1">（{{ connectInfo.hostSourceLabel }}）</span>
            </NDescriptionsItem>
          </NDescriptions>
          <p class="text-xs text-muted-foreground mb-3 leading-relaxed">
            在游戏内按 ~ 打开控制台，粘贴下方命令。命令框右侧可复制当前命令，或切换公网 / 本机 / 局域网直连。
          </p>

          <template v-if="connectDisplayBlock">
            <p class="text-xs text-muted-foreground mb-1">
              {{ connectDisplayBlock.title }}
            </p>
            <div class="flex gap-2 items-stretch mb-1">
              <div
                class="min-w-0 flex-1 font-mono text-xs p-3 rounded-md bg-zinc-950 text-zinc-100 break-all min-h-10"
                :class="{ 'text-zinc-500': !connectDisplayBlock.command }"
              >
                {{ connectDisplayBlock.command || '暂无可用命令' }}
              </div>
              <div class="flex shrink-0 items-center gap-1 self-center">
                <NTooltip>
                  <template #trigger>
                    <NButton
                      quaternary
                      circle
                      size="small"
                      :disabled="!canCopyConnectDisplay"
                      @click="copyConnectCommand(connectDisplayMode)"
                    >
                      <FaIcon name="i-lucide:copy" class="size-4" />
                    </NButton>
                  </template>
                  复制当前直连命令
                </NTooltip>
                <NTooltip>
                  <template #trigger>
                    <NButton
                      quaternary
                      circle
                      size="small"
                      @click="cycleConnectDisplayMode"
                    >
                      <FaIcon name="i-ri:arrow-left-right-line" class="size-4" />
                    </NButton>
                  </template>
                  {{ connectModeToggleTitle }}
                </NTooltip>
              </div>
            </div>
            <p class="text-xs text-muted-foreground/80 mb-3 leading-relaxed">
              {{ connectDisplayBlock.hint }}
            </p>
          </template>

          <p v-if="udpPortsLabel" class="text-xs text-muted-foreground mb-2">
            直连进服需放行 UDP 端口：{{ udpPortsLabel }}。从游戏列表进入不需要。
          </p>
          <ul
            v-if="connectInfo.hints.length > 0"
            class="text-xs text-muted-foreground list-disc pl-4 mb-3 space-y-1"
          >
            <li v-for="(hint, index) in connectInfo.hints" :key="index">
              {{ hint }}
            </li>
          </ul>
        </template>
        <p v-else class="text-sm text-muted-foreground">
          无法加载连接信息。
        </p>
      </NCard>

      <NTabs v-model:value="activeTab" type="line" animated>
        <NTabPane name="console" tab="控制台">
          <div class="flex flex-wrap gap-2 items-center mt-3 mb-2">
            <span class="text-xs text-muted-foreground">显示：</span>
            <NRadioGroup v-model:value="logFilter" size="small">
              <NRadioButton value="all" label="全部" />
              <NRadioButton value="panel" label="面板消息" />
              <NRadioButton value="game" label="游戏输出" />
            </NRadioGroup>
          </div>
          <div
            ref="logViewportRef"
            class="font-mono text-xs leading-5 p-3 border rounded-lg bg-zinc-950 text-zinc-100 h-[min(52vh,560px)] overflow-y-auto"
          >
            <p v-if="displayedLogs.length === 0" class="text-zinc-500">
              {{ emptyLogHint }}
            </p>
            <div
              v-for="line in displayedLogs"
              :key="line.id"
              class="whitespace-pre-wrap break-all"
              :class="isCommandEcho(line) ? 'border-l-2 border-amber-400/70 pl-2 -ml-2' : ''"
            >
              <span class="text-zinc-500 mr-2">{{ formatDateTime(line.at) }}</span>
              <span
                v-if="line.shard"
                class="text-amber-400/90 mr-1.5"
              >[{{ consoleLogShardLabel(line.shard) }}]</span>
              <span :class="streamClass(line)">{{ line.text }}</span>
            </div>
          </div>
          <div class="flex flex-wrap gap-2 items-center mt-3">
            <FaButton size="sm" variant="outline" @click="clearLogs" v-if="hasPermission('console:clear')">
              清空日志
            </FaButton>
            <FaButton size="sm" variant="outline" @click="copyLogs">
              复制日志
            </FaButton>
            <FaButton size="sm" variant="outline" :loading="logDownloading" @click="downloadLogs">
              下载日志
            </FaButton>
            <FaButton size="sm" variant="outline" @click="openLogHistory">
              历史日志
            </FaButton>
            <NSpace align="center" :size="8">
              <NSwitch v-model:value="autoScroll" size="small" />
              <span class="text-xs text-muted-foreground">自动滚动</span>
            </NSpace>
          </div>

          <div class="mt-6 pt-4 border-t border-border">
            <p class="text-xs text-muted-foreground mb-3">
              向游戏服务器发送控制台命令。命令回显与执行结果都会出现在上方日志里；把上方「显示」切到「游戏输出」即可只看游戏原始日志。
            </p>
            <div class="flex flex-wrap gap-2 items-center mb-3">
              <span class="text-xs text-muted-foreground">命令发送到：</span>
              <NRadioGroup v-model:value="commandShard" size="small">
                <NRadioButton value="master" label="地上" />
                <NRadioButton
                  value="caves"
                  label="洞穴"
                  :disabled="!cavesCommandAvailable"
                />
              </NRadioGroup>
              <span v-if="cavesCommandDisabledHint" class="text-xs text-muted-foreground">
                （{{ cavesCommandDisabledHint }}）
              </span>
            </div>
            <p class="text-xs text-muted-foreground mb-4 leading-relaxed">
              改玩家属性、刷物品等命令需在玩家当前所在世界执行（人在洞穴时选「洞穴」）；保存、回档等命令通常只需选「地上」。
            </p>
            <NSpace class="mb-4" wrap>
              <NButton
                v-for="item in quickCommands"
                :key="item.command"
                size="small"
                :disabled="!running || commandSending"
                @click="sendCommand(item.command)"
                v-if="hasPermission('console:command')"
              >
                {{ item.label }}
              </NButton>
              <NButton
                size="small"
                type="warning"
                :disabled="!running || commandSending"
                @click="confirmDangerousCommand('c_reset()', '确认重置世界？', '将立即重新生成一个全新世界：当前世界的地形、建筑与玩家物品都会丢失且不可恢复（已保存的回档快照除外）。真的要继续吗？')"
                v-if="hasPermission('console:command')"
              >
                重置世界
              </NButton>
            </NSpace>
            <form class="flex gap-2 items-start" @submit.prevent="sendCommand()">
              <FaInput
                v-model="commandInput"
                class="flex-1 font-mono"
                placeholder="例如 c_save() 或 TheNet:Announce('hello')"
                :disabled="!running || commandSending"
              />
              <FaButton
                type="submit"
                variant="default"
                :loading="commandSending"
                :disabled="!running || commandSending"
                v-if="hasPermission('console:command')"
              >
                发送
              </FaButton>
            </form>
          </div>
        </NTabPane>

        <NTabPane name="maintenance" tab="维护公告">
          <NInput
            v-model:value="maintenanceMessage"
            type="textarea"
            placeholder="例如：10 分钟后面板升级，游戏服保持在线，暂无法打开管理页"
            :disabled="maintenanceLoading || maintenanceSaving || maintenancePushing"
            :maxlength="500"
            show-count
            :autosize="{ minRows: 4, maxRows: 8 }"
            class="mb-3"
          />
          <p v-if="maintenanceDraftUpdatedAt" class="text-xs text-muted-foreground mb-3">
            草稿上次保存：{{ formatDateTime(maintenanceDraftUpdatedAt) }}
          </p>
          <NSpace class="mb-6" justify="start" wrap>
            <NButton
              size="small"
              :loading="maintenanceSaving"
              :disabled="maintenanceLoading || maintenancePushing"
              @click="saveMaintenanceDraft"
              v-if="hasPermission('maintenance:write')"
            >
              保存草稿
            </NButton>
            <NButton
              size="small"
              type="primary"
              :loading="maintenancePushing"
              :disabled="!running || maintenanceLoading || maintenanceSaving"
              @click="confirmPushMaintenanceAnnounce"
              v-if="hasPermission('maintenance:write')"
            >
              推送到房间
            </NButton>
          </NSpace>
          <p class="text-xs text-muted-foreground mb-2">
            最近推送记录
          </p>
          <NEmpty
            v-if="!maintenanceLoading && maintenancePushLogs.length === 0"
            description="暂无推送记录"
            size="small"
          />
          <div v-else class="space-y-2 max-h-[min(48vh,520px)] overflow-y-auto">
            <div
              v-for="item in maintenancePushLogs"
              :key="item.id"
              class="rounded-md border border-border px-3 py-2 text-xs"
            >
              <div class="flex flex-wrap gap-2 items-center mb-1">
                <NTag :type="maintenancePushStatusTagType(item.status)" size="small">
                  {{ formatMaintenancePushStatus(item.status) }}
                </NTag>
                <span class="text-muted-foreground">{{ formatDateTime(item.pushedAt) }}</span>
                <span class="text-muted-foreground">· {{ item.operatorAccount }}</span>
              </div>
              <p class="whitespace-pre-wrap break-all">
                {{ item.message }}
              </p>
              <p v-if="item.errorMessage" class="text-rose-500 mt-1">
                {{ item.errorMessage }}
              </p>
            </div>
          </div>
        </NTabPane>
      </NTabs>

      <p class="text-xs text-muted-foreground">
        实例 ID：{{ instanceId }}
      </p>
    </div>

    <NModal
      v-model:show="logHistoryVisible"
      preset="card"
      title="历史日志"
      class="max-w-4xl"
    >
      <p class="mb-3 text-xs text-muted-foreground">
        来自落盘日志文件（面板重启前的记录也在），最多显示末尾 500 行；需要完整内容请用「下载日志」。
      </p>
      <NSpin :show="logHistoryLoading">
        <NEmpty
          v-if="!logHistoryLoading && !logHistoryAvailable"
          size="small"
          description="还没有历史日志，实例启动过一次后才会生成"
        />
        <pre
          v-else
          class="max-h-[min(60vh,560px)] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border p-3 text-xs"
        >{{ logHistoryContent }}</pre>
      </NSpin>
    </NModal>
  </FaPageMain>
</template>
