<script setup lang="ts">
import type { InstanceConnectInfo, InstanceConsoleCommandShard, InstanceItem, InstanceMaintenancePushLog } from '@/api/modules/instance'
import apiInstance from '@/api/modules/instance'
import { NButton, NCard, NEmpty, NInput, NRadioButton, NRadioGroup, NTabPane, NTabs, NTag, useDialog } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { routeToInstanceConsole } from '@/navigation/game-routes'
import { formatDateTime } from '../../utils'
import {
  INSTANCE_QUICK_COMMANDS,
  RESET_WORLD_COMMAND,
  RESET_WORLD_CONFIRM_CONTENT,
  RESET_WORLD_CONFIRM_TITLE,
} from '../../instanceCommandShortcuts'

defineOptions({
  name: 'InstanceDetailCommandCenterCard',
})

const props = defineProps<{
  instance: InstanceItem | null
  connectInfo: InstanceConnectInfo | null
}>()

/** 发送成功后通知父组件（刷新最近公告等） */
const emit = defineEmits<{
  refreshed: []
}>()

const dialog = useDialog()
const router = useRouter()

/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()

type CommandTab = 'quick' | 'custom' | 'announce'

const activeTab = ref<CommandTab>('quick')
const running = computed(() => props.instance?.status === 'running')

/* ------------------------------ 分片选择 ------------------------------ */

const consoleShards = computed(() => props.connectInfo?.consoleShards)

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

const commandShard = ref<InstanceConsoleCommandShard>('master')

watch(consoleShards, (shards) => {
  if (commandShard.value === 'caves' && shards && !shards.cavesRunning) {
    commandShard.value = 'master'
  }
})

/* ------------------------------ 指令发送 ------------------------------ */

const commandSending = ref(false)

async function sendCommand(command: string) {
  if (!props.instance || !running.value || commandSending.value) {
    return
  }
  commandSending.value = true
  try {
    await apiInstance.sendInstanceConsoleCommand(props.instance.id, command, commandShard.value)
    faToast.success('命令已发送', {
      description: '执行输出请到控制台查看',
    })
  }
  catch (error) {
    faToast.error(error instanceof Error ? error.message : '命令发送失败，请稍后重试')
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

function runQuickCommand(key: string) {
  const item = INSTANCE_QUICK_COMMANDS.find(cmd => cmd.key === key)
  if (!item) {
    return
  }
  if (item.dangerous) {
    confirmDangerousCommand(item.command, item.confirmTitle ?? '确认执行', item.confirmContent ?? '确认执行该命令？')
    return
  }
  void sendCommand(item.command)
}

function confirmResetWorld() {
  confirmDangerousCommand(RESET_WORLD_COMMAND, RESET_WORLD_CONFIRM_TITLE, RESET_WORLD_CONFIRM_CONTENT)
}

/* ------------------------------ 自定义指令 ------------------------------ */

const customCommand = ref('')

function sendCustomCommand() {
  const text = customCommand.value.trim()
  if (!text) {
    return
  }
  void sendCommand(text).then(() => {
    customCommand.value = ''
  })
}

/* ------------------------------ 世界公告 ------------------------------ */

const maintenanceMessage = ref('')
const maintenanceDraftUpdatedAt = ref<string | null>(null)
const maintenancePushLogs = ref<InstanceMaintenancePushLog[]>([])
const maintenanceLoading = ref(false)
const maintenanceSaving = ref(false)
const maintenancePushing = ref(false)

async function loadMaintenanceAnnounce() {
  if (!props.instance) {
    return
  }
  maintenanceLoading.value = true
  try {
    const res = await apiInstance.getInstanceMaintenanceAnnounce(props.instance.id)
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
  if (!props.instance) {
    return
  }
  const message = maintenanceMessage.value.trim()
  if (!message) {
    faToast.warning('请先输入公告内容')
    return
  }
  maintenanceSaving.value = true
  try {
    const res = await apiInstance.saveInstanceMaintenanceAnnounceDraft(props.instance.id, message)
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
  if (!props.instance) {
    return
  }
  maintenancePushing.value = true
  try {
    const res = await apiInstance.pushInstanceMaintenanceAnnounce(props.instance.id, message)
    maintenancePushLogs.value = [
      res.data.pushLog,
      ...maintenancePushLogs.value.filter(item => item.id !== res.data.pushLog.id),
    ]
    if (res.data.isSuccess) {
      faToast.success('维护公告已推送到游戏房间')
      emit('refreshed')
    }
    else {
      faToast.error(res.data.errorMessage ?? '推送失败')
    }
  }
  finally {
    maintenancePushing.value = false
  }
}

function maintenancePushStatusTagType(status: InstanceMaintenancePushLog['status']) {
  return status === 'success' ? 'success' : 'error'
}

function maintenancePushStatusLabel(status: InstanceMaintenancePushLog['status']) {
  return status === 'success' ? '成功' : '失败'
}

/** 公告 Tab 首次打开时加载草稿与记录 */
function onTabChange(tab: CommandTab) {
  if (tab === 'announce' && maintenancePushLogs.value.length === 0 && !maintenanceDraftUpdatedAt.value) {
    void loadMaintenanceAnnounce()
  }
}

function goConsole() {
  if (props.instance) {
    router.push(routeToInstanceConsole(props.instance.id))
  }
}

defineExpose({
  loadMaintenanceAnnounce,
})
</script>

<template>
  <NCard title="游戏指令" size="small">
    <p
      v-if="instance && !running"
      class="rounded-md bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground mb-3"
    >
      实例未运行，启动后可用
    </p>

    <NTabs v-model:value="activeTab" type="line" size="small" @update:value="onTabChange">
      <NTabPane name="quick" tab="快捷指令">
        <div class="flex flex-wrap gap-2 items-center mt-3 mb-3">
          <span class="text-xs text-muted-foreground">发送到：</span>
          <NRadioGroup v-model:value="commandShard" size="small">
            <NRadioButton value="master" label="地上" />
            <NRadioButton value="caves" label="洞穴" :disabled="!cavesCommandAvailable" />
          </NRadioGroup>
          <span v-if="cavesCommandDisabledHint" class="text-xs text-muted-foreground">
            （{{ cavesCommandDisabledHint }}）
          </span>
        </div>
        <NSpace wrap>
          <NButton
            v-for="item in INSTANCE_QUICK_COMMANDS"
            :key="item.key"
            size="small"
            :disabled="!running || commandSending"
            :loading="commandSending"
            @click="runQuickCommand(item.key)"
            v-if="hasPermission('console:command')"
          >
            {{ item.label }}
          </NButton>
          <NButton
            size="small"
            type="warning"
            :disabled="!running || commandSending"
            :loading="commandSending"
            @click="confirmResetWorld"
            v-if="hasPermission('console:command')"
          >
            重置世界
          </NButton>
        </NSpace>
      </NTabPane>

      <NTabPane name="custom" tab="自定义指令">
        <div class="flex flex-wrap gap-2 items-center mt-3 mb-3">
          <span class="text-xs text-muted-foreground">发送到：</span>
          <NRadioGroup v-model:value="commandShard" size="small">
            <NRadioButton value="master" label="地上" />
            <NRadioButton value="caves" label="洞穴" :disabled="!cavesCommandAvailable" />
          </NRadioGroup>
          <span v-if="cavesCommandDisabledHint" class="text-xs text-muted-foreground">
            （{{ cavesCommandDisabledHint }}）
          </span>
        </div>
        <form class="flex gap-2 items-start" @submit.prevent="sendCustomCommand">
          <NInput
            v-model:value="customCommand"
            class="flex-1"
            placeholder="例如 c_listallplayers() 或 TheNet:Announce('hello')"
            :disabled="!running || commandSending"
          />
          <NButton
            attr-type="submit"
            size="small"
            type="primary"
            :loading="commandSending"
            :disabled="!running || commandSending"
            v-if="hasPermission('console:command')"
          >
            发送
          </NButton>
        </form>
        <p class="text-xs text-muted-foreground mt-3 leading-relaxed">
          执行结果见
          <NButton text type="primary" size="tiny" class="align-baseline px-0" :disabled="!instance" @click="goConsole">
            实例控制台
          </NButton>
        </p>
      </NTabPane>

      <NTabPane name="announce" tab="世界公告">
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
                {{ maintenancePushStatusLabel(item.status) }}
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
  </NCard>
</template>
