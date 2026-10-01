<script setup lang="ts">
/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()

import type { FormInst, FormRules } from 'naive-ui'
import type {
  ClusterConfigDto,
  ClusterGameMode,
  ClusterNetworkMode,
  ClusterSavePayload,
} from '@/api/modules/cluster'
import {
  NAlert,
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NRadio,
  NRadioGroup,
  NSelect,
  NSpace,
  NSpin,
  NSwitch,
  NTooltip,
  useDialog,
  useMessage,
  useNotification,
} from 'naive-ui'
import AdminSettingsSection from '@/components/AdminSettingsSection.vue'
import ConfigActionBar from '@/components/ConfigActionBar.vue'
import { useUnsavedChangesGuard } from '@/composables/useUnsavedChangesGuard'
import { computed, nextTick, onActivated, reactive, ref, shallowRef, watch } from 'vue'
import apiCluster from '@/api/modules/cluster'
import apiInstance from '@/api/modules/instance'
import { useHostMemoryGuidance } from '@/composables/useHostMemoryGuidance'
import { useNarrowFormLayout } from '@/composables/useNarrowFormLayout'
import { routeToConsoleMonitor, routeToDstPlayerManage, routeToDstRoomList, routeToDstWorldSettings } from '@/navigation/game-routes'
import router from '@/router'
import { isInstanceInstallingStatus } from '@/views/node/instance/instanceDisplay'
import { getPortConflictDialogLabels, isInstancePortConflictError } from '@/utils/instancePortConflict'
import { tryNotifyHostMemoryPressure } from '@/utils/hostMemoryPressure'

defineOptions({
  name: 'DstRoomSettings',
})

const route = useRoute()
const router = useRouter()
const dialog = useDialog()
const message = useMessage()
const notification = useNotification()

const { formLabelPlacement, formLabelWidth } = useNarrowFormLayout(120)
const { guidance: hostMemoryGuidance } = useHostMemoryGuidance()

const cavesMemoryAlert = computed(() => {
  if (!formModel.shardEnabled) {
    return null
  }
  return hostMemoryGuidance.value?.cavesWarning ?? null
})

const instanceId = computed(() => String(route.params.instanceId ?? ''))
const loading = ref(false)
const loadError = shallowRef<string | null>(null)
const activeSaveOperation = shallowRef<'save' | 'restart' | null>(null)
const isSaving = computed(() => activeSaveOperation.value !== null)
/** 「重置」按钮自身的 loading（重新拉取远端配置） */
const resetting = ref(false)
const formRef = ref<FormInst | null>(null)
const serverConfig = ref<ClusterConfigDto | null>(null)

const formModel = reactive({
  networkMode: 'offline' as ClusterNetworkMode,
  clusterToken: '',
  clusterName: '',
  clusterDescription: '',
  clusterPassword: '',
  gameMode: 'survival' as ClusterGameMode,
  maxPlayers: 6,
  pvp: false,
  pauseWhenEmpty: true,
  voteEnabled: true,
  tickRate: 15,
  whitelistSlots: 0,
  maxSnapshots: 6,
  shardEnabled: false,
  bindIp: '127.0.0.1',
  masterIp: '127.0.0.1',
  masterPort: 10888,
  clusterKey: 'supersecretkey',
  steamGroupOnly: false,
  steamGroupId: '',
  steamGroupAdmins: false,
})

const gameModeOptions = [
  { label: '生存', value: 'survival' },
  { label: '无尽', value: 'endless' },
  { label: '荒野', value: 'wilderness' },
  { label: '轻松', value: 'easy' },
  { label: '暗无天日', value: 'darkandwildernes' },
]

/** 游戏模式选择后的说明（随选择联动展示在表单反馈区） */
const gameModeHint = computed(() => ({
  survival: '默认模式：死亡后变为幽灵，可通过触摸试金石等方式复活。',
  endless: '无尽模式：死亡后可无限重生，适合休闲联机。',
  wilderness: '荒野模式：随机地点出生、无法复活，死亡后需重新生成角色。',
  easy: '轻松模式：生存压力更小，适合新手。',
  darkandwildernes: '暗无天日：永夜环境 + 荒野规则，高难度挑战。',
}[formModel.gameMode] ?? ''))

const pageTitle = computed(() => serverConfig.value
  ? `房间设置 · ${serverConfig.value.instanceName}`
  : '房间设置')

/** 远端快照：加载/保存成功后更新，用于脏状态判定与一键重置 */
const savedSnapshot = ref('')

const formDirty = computed(() =>
  savedSnapshot.value !== '' && JSON.stringify({ ...formModel }) !== savedSnapshot.value,
)

useUnsavedChangesGuard(formDirty)

const showPublicTokenSection = computed(() => formModel.networkMode === 'public')

const saveAndRestartDisabled = computed(() =>
  isInstanceInstallingStatus(serverConfig.value?.instanceStatus),
)

const saveAndRestartDisabledTitle = computed(() =>
  saveAndRestartDisabled.value ? '实例安装完成后才可保存并重启' : undefined,
)


const clusterTokenPlaceholder = computed(() => {
  if (serverConfig.value?.clusterTokenConfigured && serverConfig.value.clusterTokenMasked) {
    return `已配置（${serverConfig.value.clusterTokenMasked}），留空表示不修改`
  }
  return '联机模式须填写 pds- 开头的 Klei 集群令牌'
})

/** 联网模式说明：原先作为常驻横幅推送，现内联在模式选择下方，跟随选中项变化。 */
const NETWORK_MODE_HINTS: Record<ClusterNetworkMode, string> = {
  offline: '离线模式：不向 Klei 注册，不会出现在游戏浏览列表。',
  lan_only: '仅局域网模式：同一局域网内玩家可发现房间。',
  public: '公网模式：需确保防火墙或云安全组已放行游戏端口。',
}

const networkModeHint = computed(() => NETWORK_MODE_HINTS[formModel.networkMode])

/** 顶部只承载异常警告与「实例运行中」这条影响保存行为的条件提示。 */
const configAlerts = computed(() => {
  const config = serverConfig.value
  if (!config) {
    return { warnings: [] as string[], hints: [] as string[] }
  }
  return {
    warnings: config.warnings,
    hints: config.configDirty ? ['实例运行中，配置变更需重启实例后生效'] : [],
  }
})

const formRules = computed<FormRules>(() => {
  const rules: FormRules = {
    clusterName: [
      { required: true, message: '请输入房间名称', trigger: ['blur', 'input'] },
    ],
    maxPlayers: [
      {
        type: 'number',
        required: true,
        min: 1,
        max: 64,
        message: '最大玩家数须在 1–64 之间',
        trigger: ['blur', 'change'],
      },
    ],
    tickRate: [
      {
        type: 'number',
        required: true,
        min: 15,
        max: 60,
        message: '网络刷新率须在 15–60 之间',
        trigger: ['blur', 'change'],
      },
    ],
    masterPort: [
      {
        type: 'number',
        required: true,
        min: 1,
        max: 65535,
        message: '主机端口须在 1–65535 之间',
        trigger: ['blur', 'change'],
      },
    ],
    steamGroupId: [
      {
        validator: (_rule, value: string) => {
          const normalized = String(value ?? '').trim()
          if (normalized && !/^\d+$/.test(normalized)) {
            return new Error('Steam 组 ID 只能包含数字')
          }
          if (formModel.steamGroupOnly && (!normalized || normalized === '0')) {
            return new Error('启用仅 Steam 组入服时须填写有效的 Steam 组 ID')
          }
          return true
        },
        trigger: ['blur', 'input'],
      },
    ],
  }

  if (formModel.networkMode === 'public') {
    rules.clusterToken = [
      {
        required: true,
        validator: (_rule, value: string) => {
          const input = String(value ?? '').trim()
          if (!input && serverConfig.value?.clusterTokenConfigured) {
            return true
          }
          if (!input) {
            return new Error('联机模式必须填写 Klei 集群令牌')
          }
          if (!input.startsWith('pds-')) {
            return new Error('Klei 集群令牌应以 pds- 开头')
          }
          return true
        },
        trigger: ['blur', 'input', 'change'],
      },
    ]
  }

  return rules
})

function allowSteamGroupIdInput(value: string) {
  return /^\d*$/.test(value)
}

function applyConfig(config: ClusterConfigDto) {
  serverConfig.value = config
  formModel.networkMode = config.networkMode
  formModel.clusterName = config.clusterName
  formModel.clusterDescription = config.clusterDescription
  formModel.clusterPassword = config.clusterPassword
  formModel.gameMode = config.gameMode
  formModel.maxPlayers = config.maxPlayers
  formModel.pvp = config.pvp
  formModel.pauseWhenEmpty = config.pauseWhenEmpty
  formModel.voteEnabled = config.voteEnabled
  formModel.tickRate = config.tickRate
  formModel.whitelistSlots = config.whitelistSlots
  formModel.maxSnapshots = config.maxSnapshots
  formModel.shardEnabled = config.shardEnabled
  formModel.bindIp = config.bindIp
  formModel.masterIp = config.masterIp
  formModel.masterPort = config.masterPort
  formModel.clusterKey = config.clusterKey
  formModel.steamGroupOnly = config.steamGroupOnly
  formModel.steamGroupId = config.steamGroupId === '0' ? '' : config.steamGroupId
  formModel.steamGroupAdmins = config.steamGroupAdmins
  formModel.clusterToken = ''
  savedSnapshot.value = JSON.stringify({ ...formModel })
}

async function loadConfig() {
  if (!instanceId.value) {
    serverConfig.value = null
    loadError.value = '未找到这个房间，请返回房间列表后重新进入。'
    return
  }
  loading.value = true
  loadError.value = null
  try {
    const response = await apiCluster.getClusterConfig(instanceId.value)
    applyConfig(response.data)
  }
  catch {
    serverConfig.value = null
    loadError.value = '加载房间配置失败，请确认实例已安装后重试。'
  }
  finally {
    loading.value = false
  }
}

/** 重置：丢弃本地未保存修改，重新拉取远端配置 */
async function resetConfig() {
  if (isSaving.value || resetting.value) {
    return
  }
  resetting.value = true
  try {
    await loadConfig()
  }
  finally {
    resetting.value = false
  }
}

function buildSavePayload(restart = false): ClusterSavePayload {
  const payload: ClusterSavePayload = {
    instanceId: instanceId.value,
    networkMode: formModel.networkMode,
    clusterName: formModel.clusterName.trim(),
    clusterDescription: formModel.clusterDescription.trim(),
    clusterPassword: formModel.clusterPassword,
    gameMode: formModel.gameMode,
    maxPlayers: formModel.maxPlayers,
    pvp: formModel.pvp,
    pauseWhenEmpty: formModel.pauseWhenEmpty,
    voteEnabled: formModel.voteEnabled,
    clusterIntention: serverConfig.value?.clusterIntention ?? 'cooperative',
    tickRate: formModel.tickRate,
    whitelistSlots: formModel.whitelistSlots,
    maxSnapshots: formModel.maxSnapshots,
    shardEnabled: formModel.shardEnabled,
    bindIp: formModel.bindIp.trim(),
    masterIp: formModel.masterIp.trim(),
    masterPort: formModel.masterPort,
    clusterKey: formModel.clusterKey.trim(),
    steamGroupOnly: formModel.steamGroupOnly,
    steamGroupId: formModel.steamGroupId.trim() || '0',
    steamGroupAdmins: formModel.steamGroupAdmins,
    restart,
  }
  if (formModel.clusterToken.trim()) {
    payload.clusterToken = formModel.clusterToken.trim()
  }
  return payload
}

async function saveConfig(restart = false) {
  if (!serverConfig.value || loading.value || isSaving.value) {
    return
  }
  try {
    await formRef.value?.validate()
  }
  catch {
    return
  }
  const operation = restart ? 'restart' : 'save'
  activeSaveOperation.value = operation
  try {
    await apiCluster.saveClusterConfig(buildSavePayload(restart))
    message.success(restart ? '房间配置已保存并触发重启' : '房间配置已保存')
    formModel.clusterToken = ''
    await loadConfig()
  }
  catch (error: unknown) {
    if (restart && isInstancePortConflictError(error)) {
      const labels = getPortConflictDialogLabels('restart')
      dialog.warning({
        title: labels.title,
        content: '房间配置已保存，但重启实例时端口被占用。',
        positiveText: labels.positiveText,
        negativeText: '取消',
        onPositiveClick: async () => {
          try {
            await apiInstance.restartInstance(instanceId.value, { autoAllocatePorts: true })
            message.success('已自动分配端口并完成重启')
            await loadConfig()
          }
          catch {
            message.error('重启失败，请稍后重试')
          }
        },
      })
      return
    }
    if (tryNotifyHostMemoryPressure(notification, error, () => router.push(routeToConsoleMonitor()))) {
      return
    }
    // 其余业务错误由全局拦截器统一提示，这里仅避免未处理的 Promise 拒绝
  }
  finally {
    if (activeSaveOperation.value === operation) {
      activeSaveOperation.value = null
    }
  }
}

function goBack() {
  router.push(routeToDstRoomList())
}

function goWorldSettings() {
  if (instanceId.value) {
    router.push(routeToDstWorldSettings(instanceId.value))
  }
}

function goPlayerManage() {
  if (instanceId.value) {
    router.push(routeToDstPlayerManage(instanceId.value))
  }
}

function confirmSaveAndRestart() {
  dialog.warning({
    title: '保存并重启',
    content: '将保存当前房间配置并重启实例，在线玩家会被断开。是否继续？',
    positiveText: '保存并重启',
    negativeText: '取消',
    onPositiveClick: () => saveConfig(true),
  })
} 

watch(() => formModel.networkMode, (mode) => {
  void nextTick(() => {
    if (mode === 'public') {
      void formRef.value?.validate(undefined, rule => rule?.key === 'clusterToken')
    }
    else {
      formRef.value?.restoreValidation()
    }
  })
})

watch(instanceId, (id) => {
  if (id) {
    void loadConfig()
  }
}, { immediate: true })

onActivated(() => {
  if (instanceId.value) {
    void loadConfig()
  }
})
</script>

<template>
  <FaPageMain >
    <template #title>
      <div class="flex flex-wrap items-center justify-between gap-4">
        <h1 class="text-lg font-semibold">
          {{ pageTitle }}
        </h1>

        <FaButton variant="outline" size="sm" @click="goBack">
          返回房间列表
        </FaButton>
      </div>
    </template>

    <NSpin v-if="loading && !serverConfig" size="large" class="block mx-auto my-8" />
    <div v-else-if="loadError || !serverConfig" class="space-y-4" role="alert">
      <NAlert type="error" title="无法加载房间配置">
        {{ loadError ?? '当前配置不可用，请重新加载后再编辑。' }}
      </NAlert>
      <NButton :loading="loading" @click="loadConfig">
        重试加载
      </NButton>
    </div>
    <div v-else class="space-y-4">
      <AdminSettingsSection
        title="房间配置"
        description="设置联网方式、房间信息与洞穴开关。"
      />
      <div class="space-y-4">
        <NAlert v-if="configAlerts.warnings.length" type="warning" title="需要处理" class="mb-2">
          <ul class="list-disc pl-4 space-y-1">
            <li v-for="(warning, index) in configAlerts.warnings" :key="`warn-${index}`">
              {{ warning }}
            </li>
          </ul>
        </NAlert>
        <NAlert
          v-for="(hint, index) in configAlerts.hints"
          :key="`hint-${index}`"
          type="info"
          :title="hint"
          class="mb-2"
        />
        <NForm
          ref="formRef"
          :model="formModel"
          :rules="formRules"
          :label-placement="formLabelPlacement"
          :label-width="formLabelWidth"
          require-mark-placement="right-hanging"
        >
          <NCard title="联网模式" size="small">
            <NFormItem label="模式">
              <NRadioGroup v-model:value="formModel.networkMode">
                <NSpace>
                  <NRadio value="offline">
                    离线 
                  </NRadio>
                  <NRadio value="lan_only">
                    仅局域网 
                  </NRadio>
                  <NRadio value="public">
                    公网联机
                  </NRadio>
                </NSpace>
              </NRadioGroup>
              <template #feedback>
                {{ networkModeHint }}
              </template>
            </NFormItem>
            <NFormItem label="网络刷新率" path="tickRate">
              <NInputNumber v-model:value="formModel.tickRate" :min="15" :max="60" :step="15" class="w-40" />
              <NTooltip :style="{ maxWidth: '300px' }">
                <template #trigger>
                  <NButton text class="ml-2">
                    <FaIcon name="i-lucide:info" class="size-4" />
                  </NButton>
                </template>
                <p>客户端与服务器之间每秒通信的次数，<br>性能满足的情况下，通信频率越高，游戏越流畅、体验越好。</p>
              </NTooltip>
              <span class="ml-2 text-sm text-muted-foreground">15–60，默认 15</span>
            </NFormItem>
          </NCard>
          <NCard v-if="showPublicTokenSection" title="Klei 集群令牌" size="small" class="mt-4">
            <p class="mb-3 text-sm text-muted-foreground">
              在游戏内执行 <code>TheNet:GenerateClusterToken()</code> 或前往
              <a
                class="text-primary underline"
                href="https://accounts.klei.com"
                target="_blank"
                rel="noopener noreferrer"
              >accounts.klei.com</a>
              生成令牌（一行，以 pds- 开头）
            </p> 
            <NFormItem
              label="Klei 集群令牌"
              path="clusterToken"
              :required="formModel.networkMode === 'public' && !serverConfig?.clusterTokenConfigured"
            >
              <NInput
                v-model:value="formModel.clusterToken"
                type="password"
                show-password-on="click"
                :placeholder="clusterTokenPlaceholder"
              />
            </NFormItem>
          </NCard>

          <NCard title="房间信息" size="small" class="mt-4">
            <NFormItem label="房间名称" path="clusterName">
              <NInput v-model:value="formModel.clusterName" placeholder="游戏大厅显示的名称" />
            </NFormItem>
            <NFormItem label="房间描述">
              <NInput
                v-model:value="formModel.clusterDescription"
                type="textarea"
                placeholder="可选"
                :rows="2"
              />
            </NFormItem>
            <NFormItem label="房间密码">
              <NInput
                v-model:value="formModel.clusterPassword"
                placeholder="留空则无需密码"
                show-password-on="click"
                type="password"
              />
            </NFormItem>
          </NCard>

          <NCard title="玩法设置" size="small" class="mt-4">
            <NFormItem label="游戏模式">
              <NSelect v-model:value="formModel.gameMode" :options="gameModeOptions" class="max-w-xs" />
              <template v-if="gameModeHint" #feedback>
                {{ gameModeHint }}
              </template>
            </NFormItem>
            <NFormItem label="最大玩家" path="maxPlayers">
              <NInputNumber v-model:value="formModel.maxPlayers" :min="1" :max="64" class="w-40" />
              <NTooltip :style="{ maxWidth: '300px' }">
                <template #trigger>
                  <NButton text class="ml-2">
                    <FaIcon name="i-lucide:info" class="size-4" />
                  </NButton>
                </template>
                <p>1核2G服务器推荐4人，<br> 2核4G服务器推荐6-8人</p>
              </NTooltip>
            </NFormItem>
            <NFormItem label="白名单预留位" path="whitelistSlots">
              <NInputNumber v-model:value="formModel.whitelistSlots" :min="0" :max="formModel.maxPlayers" class="w-40" />
              <NTooltip :style="{ maxWidth: '300px' }">
                <template #trigger>
                  <NButton text class="ml-2">
                    <FaIcon name="i-lucide:info" class="size-4" />
                  </NButton>
                </template>
                <p>给白名单玩家保留的席位数量。<br>填 0 表示不使用白名单，此时白名单名单不会生效。</p>
              </NTooltip>
            </NFormItem>
            <NFormItem label="PVP">
              <NSwitch v-model:value="formModel.pvp" />
              <NTooltip :style="{ maxWidth: '300px' }">
                <template #trigger>
                  <NButton text class="ml-2">
                    <FaIcon name="i-lucide:info" class="size-4" />
                  </NButton>
                </template>
                <p>是否开启玩家对战</p>
              </NTooltip>
            </NFormItem>
            <NFormItem label="无人暂停">
              <NSwitch v-model:value="formModel.pauseWhenEmpty" /> 
              <NTooltip :style="{ maxWidth: '300px' }">
                <template #trigger>
                  <NButton text class="ml-2">
                    <FaIcon name="i-lucide:info" class="size-4" />
                  </NButton>
                </template>
                <p>无人时暂停游戏</p>
              </NTooltip>
            </NFormItem>
            <NFormItem label="投票功能">
              <NSwitch v-model:value="formModel.voteEnabled" />
              <NTooltip :style="{ maxWidth: '300px' }">
                <template #trigger>
                  <NButton text class="ml-2">
                    <FaIcon name="i-lucide:info" class="size-4" />
                  </NButton>
                </template>
                <p>开启后，可通过投票进行踢出玩家、回档、重置世界操作</p>
              </NTooltip>
            </NFormItem>
          </NCard>

          <NCard title="玩家名单" size="small" class="mt-4">
            <p class="text-sm text-muted-foreground">
              管理员、白名单与黑名单已经集中到「玩家管理」页面：那里能看到在线玩家、按游戏名添加名单、踢出或封禁玩家。
              白名单是否生效仍由上面的「白名单预留位」决定，填 0 就是不用白名单。
            </p>
            <NButton
              v-if="hasPermission('player:read')"
              class="mt-3"
              size="small"
              secondary
              @click="goPlayerManage"
            >
              前往玩家管理
            </NButton>
          </NCard>

          <NCard title="存档与快照" size="small" class="mt-4">
            <NFormItem label="最大快照数">
              <NInputNumber v-model:value="formModel.maxSnapshots" :min="1" :max="99" class="w-40" />
              <NTooltip :style="{ maxWidth: '300px' }" >
                <template #trigger>
                  <NButton text class="ml-2">
                    <FaIcon name="i-lucide:info" class="size-4" />
                  </NButton>
                </template>
                <p>服务器保留的快照数量上限，<br>默认情况下，服务器会在新的一天开始时对服务器存档，生成一份快照。保留的快照数量决定了可回档的天数上限。 在世界内有玩家存在时，服务器不会清理该世界的快照。</p>
              </NTooltip>
            </NFormItem>
          </NCard>

          <NCard title="洞穴（地下世界）" size="small" class="mt-4">
            <AppHostMemoryAlert
              v-if="cavesMemoryAlert"
              title="内存提示"
              :message="cavesMemoryAlert"
            />
            <NFormItem label="启用洞穴">
              <NSwitch v-model:value="formModel.shardEnabled" />
              <NTooltip :style="{ maxWidth: '300px' }">
                <template #trigger>
                  <NButton text class="ml-2">
                    <FaIcon name="i-lucide:info" class="size-4" />
                  </NButton>
                </template>
                <p>开启后地上与洞穴各运行一个服务器；保存后将自动准备洞穴默认配置，请到「世界设置」调整地图与端口。</p>
              </NTooltip>
            </NFormItem>
            <template v-if="formModel.shardEnabled">
              <NFormItem label="内部通信端口" path="masterPort">
                <NInputNumber v-model:value="formModel.masterPort" :min="1" :max="65535" class="w-40" />
                <template #feedback>
                  地上与洞穴服务器之间的通信端口，默认 10888，两处须保持一致
                </template>
              </NFormItem>
              <NFormItem label="互联密钥">
                <NInput
                  v-model:value="formModel.clusterKey"
                  type="password"
                  show-password-on="click"
                  placeholder="地上与洞穴共用"
                />
                <template #feedback>
                  地上与洞穴共用的内部密钥，请修改默认值（不是 Klei 房间令牌）
                </template>
              </NFormItem>
            </template>
            <!-- 目标页在「世界管理」模块下（world:read）：无权时这条路由根本没注册，按名跳转会在解析阶段抛 No match -->
            <NButton
              v-if="formModel.shardEnabled && hasPermission('world:read')"
              size="small"
              class="mt-3"
              @click="goWorldSettings"
            >
              前往世界设置
              <FaIcon name="i-lucide:arrow-right" class="size-4" />
            </NButton>
          </NCard>

          <NCard title="Steam 组（可选）" size="small" class="mt-4">
            <NFormItem label="Steam 组 ID" path="steamGroupId">
              <NInput
                v-model:value="formModel.steamGroupId"
                placeholder="纯数字，留空表示不绑定"
                class="w-48"
                inputmode="numeric"
                :allow-input="allowSteamGroupIdInput"
              />
              <NTooltip :style="{ maxWidth: '300px' }">
                <template #trigger>
                  <NButton text class="ml-2">
                    <FaIcon name="i-lucide:info" class="size-4" />
                  </NButton>
                </template>
                <p>每个steam群组都有唯一的一串数字与其对应，在这里填写群组编号用于绑定steam群组。 绑定后服务器将在群组成员的大厅中优先显示，并附有红色、黄色或白色小旗子标志。</p>
              </NTooltip>
            </NFormItem>
            <NFormItem label="仅 Steam 组">
              <NSwitch v-model:value="formModel.steamGroupOnly" />
              <NTooltip :style="{ maxWidth: '300px' }">
                <template #trigger>
                  <NButton text class="ml-2">
                    <FaIcon name="i-lucide:info" class="size-4" />
                  </NButton>
                </template>
                <p>是否仅允许steam群组成员加入服务器</p>
              </NTooltip>
            </NFormItem>
            <NFormItem label="组管理员权限">
              <NSwitch v-model:value="formModel.steamGroupAdmins" />
              <NTooltip :style="{ maxWidth: '300px' }">
                <template #trigger>
                  <NButton text class="ml-2">
                    <FaIcon name="i-lucide:info" class="size-4" />
                  </NButton>
                </template>
                <p>是否将steam群组管理员设为游戏管理员</p>
              </NTooltip>
            </NFormItem>
          </NCard>
        </NForm>

        <AppAuth value="room:write">
          <ConfigActionBar
            :dirty="formDirty"
            :busy="isSaving || resetting"
            :saving="activeSaveOperation === 'save'"
            :restarting="activeSaveOperation === 'restart'"
            :resetting="resetting"
            :restart-disabled="saveAndRestartDisabled"
            :restart-disabled-title="saveAndRestartDisabledTitle"
            :show-restart="hasPermission('instance:lifecycle')"
            @reset="resetConfig"
            @save="saveConfig(false)"
            @save-and-restart="confirmSaveAndRestart"
          />
        </AppAuth>
        <!-- 只有 room:read 的角色：配置照常可看，但不给保存入口，也不留一堆点了报错的按钮 -->
        <AppAuth value="room:write" #no-auth>
          <div class="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            你可以查看这份房间配置，但没有修改权限，保存与重置入口已隐藏。需要修改请联系管理员。
          </div>
        </AppAuth>
      </div>
    </div>
  </FaPageMain>
</template>
