<script setup lang="ts">
/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()

import type { FormInst, FormRules } from 'naive-ui'
import type {
  CavesWorldgenPreset,
  ShardId,
  ShardListDto,
  ShardSavePayload,
  ShardSummaryDto,
} from '@/api/modules/shard'
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NForm,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  useDialog,
  useMessage,
  useNotification,
} from 'naive-ui'
import { computed, h, onActivated, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import apiInstance from '@/api/modules/instance'
import apiShard from '@/api/modules/shard'
import { useHostMemoryGuidance } from '@/composables/useHostMemoryGuidance'
import { useNarrowFormLayout } from '@/composables/useNarrowFormLayout'
import { useUnsavedChangesGuard } from '@/composables/useUnsavedChangesGuard'
import ConfigActionBar from '@/components/ConfigActionBar.vue'
import {
  routeToConsoleMonitor,
  routeToDstRoomSettings,
  routeToDstWorldList,
} from '@/navigation/game-routes'
import { isInstanceInstallingStatus } from '@/views/node/instance/instanceDisplay'
import { resolveShardDisplayStatus, statusTagType } from '@/constants/statusDictionary'
import { tryNotifyHostMemoryPressure } from '@/utils/hostMemoryPressure'
import { shardSavePayloadSchema } from '@/api/modules/shard'
import {
  formatPortConflictDetail,
  getPortConflictDialogLabels,
  isInstancePortConflictError,
} from '@/utils/instancePortConflict'
import ShardNetworkSection from './components/ShardNetworkSection.vue'
import WorldMaintenanceCard from './components/WorldMaintenanceCard.vue'
import ShardModsSection from './components/ShardModsSection.vue'
import ShardWorldRulesSection from './components/ShardWorldRulesSection.vue'
import AdminSettingsSection from '@/components/AdminSettingsSection.vue'
import ShardWorldgenSection from './components/ShardWorldgenSection.vue'
import ShardMapPanel from './components/ShardMapPanel.vue'
import {
  applyLeveldataOverridesFromServer,
  buildLeveldataOverridesPayload,
} from './utils/leveldataOverrides'

type ShardSubTab = 'rules' | 'worldgen' | 'network'
type ShardSaveOperation = `${ShardId}:${'save' | 'restart'}`

defineOptions({
  name: 'DstWorldSettings',
})

const route = useRoute()
const router = useRouter()
const dialog = useDialog()
const message = useMessage()
const notification = useNotification()

const { formLabelPlacement, formLabelWidth } = useNarrowFormLayout(140)
const { guidance: hostMemoryGuidance } = useHostMemoryGuidance()

const instanceId = computed(() => String(route.params.instanceId ?? ''))
const loading = ref(false)
const activeSaveOperation = shallowRef<ShardSaveOperation | null>(null)
const isSaving = computed(() => activeSaveOperation.value !== null)
/** 「重置」按钮自身的 loading（重新拉取远端配置） */
const resetting = ref(false)
const shardList = ref<ShardListDto | null>(null)

const saveAndRestartDisabled = computed(() =>
  isInstanceInstallingStatus(shardList.value?.instanceStatus),
)

const saveAndRestartDisabledTitle = computed(() =>
  saveAndRestartDisabled.value ? '实例安装完成后才可保存并重启' : undefined,
)

const mainTab = ref<'surface' | 'caves' | 'mods'>('surface')
const surfaceSubTab = ref<ShardSubTab>('rules')
const cavesSubTab = ref<ShardSubTab>('rules')
const allocatingPorts = ref(false)

const masterWorldRules = ref<Record<string, string>>({})
const cavesWorldRules = ref<Record<string, string>>({})
const masterWorldgenConfig = ref<Record<string, string>>({})
const cavesWorldgenConfig = ref<Record<string, string>>({})
/** 世界种子输入：空串表示留空（由游戏随机），只在生成地图时被读取 */
const masterWorldSeed = ref('')
const cavesWorldSeed = ref('')

/** 服务端当前已保存的世界规则快照，用于保存时做差异提交（未修改项不下发） */
const persistedMasterOverrides = ref<Record<string, string>>({})
const persistedCavesOverrides = ref<Record<string, string>>({})

const masterFormRef = ref<FormInst | null>(null)
const cavesFormRef = ref<FormInst | null>(null)

const masterForm = reactive({
  serverPort: 10999,
  steamAuthPort: 8766,
  steamMasterPort: 12346,
  worldgenPreset: 'SURVIVAL_TOGETHER' as const,
})

const cavesForm = reactive({
  serverPort: 11000,
  steamAuthPort: 8768,
  steamMasterPort: 12348,
  worldgenPreset: 'DST_CAVE' as CavesWorldgenPreset,
})

const pageTitle = computed(() => shardList.value
  ? `世界设置 · ${shardList.value.instanceName}`
  : '世界设置')

/** 远端快照：加载/保存成功后更新，用于脏状态判定与一键重置 */
const savedSnapshot = ref('')

function buildFormSnapshot(): string {
  return JSON.stringify({
    masterForm: { ...masterForm },
    cavesForm: { ...cavesForm },
    masterWorldRules: masterWorldRules.value,
    cavesWorldRules: cavesWorldRules.value,
    masterWorldgenConfig: masterWorldgenConfig.value,
    cavesWorldgenConfig: cavesWorldgenConfig.value,
    masterWorldSeed: masterWorldSeed.value,
    cavesWorldSeed: cavesWorldSeed.value,
  })
}

const formDirty = computed(() => savedSnapshot.value !== '' && buildFormSnapshot() !== savedSnapshot.value)

useUnsavedChangesGuard(formDirty)

/** 底部保存栏作用于当前激活的分片（模组页签不保存） */
const currentShardId = computed<ShardId>(() => (mainTab.value === 'caves' ? 'caves' : 'master'))

const clusterShardEnabled = computed(() => Boolean(shardList.value?.clusterShardEnabled))
const instanceRunning = computed(() => shardList.value?.instanceStatus === 'running')
const masterShard = computed(() => shardList.value?.shards.find(s => s.id === 'master'))
const cavesShard = computed(() => shardList.value?.shards.find(s => s.id === 'caves'))

/**
 * 种子输入框显示的值：改过就用改后的值，没改过就显示当前世界的种子。
 * 这样界面上只有一个「世界种子」，它既回答"现在是什么"，也是下次重置要用的值。
 */
const masterSeedDisplay = computed(() => masterWorldSeed.value || masterShard.value?.currentWorldSeed || '')
const cavesSeedDisplay = computed(() => cavesWorldSeed.value || cavesShard.value?.currentWorldSeed || '')
/** 正在读取当前世界种子的分片 */
const readingShards = ref<ShardId[]>([])
/** 正在按新种子重置世界的分片 */
const resettingShards = ref<ShardId[]>([])
/** 本次进入页面已经自动尝试过读取的分片：避免反复打扰游戏进程 */
const autoProbedShards = new Set<ShardId>()

/**
 * 顶部只承载「现在需要处理」的信息：异常警告，以及实例运行中这条会影响保存行为的条件提示。
 * 静态说明（世界已生成、放行端口、洞穴未开启）一律内联到对应页签与控件旁，避免同一信息重复出现。
 */
const configAlerts = computed(() => {
  const list = shardList.value
  if (!list) {
    return { warnings: [] as string[], hints: [] as string[] }
  }
  const running = list.shards.some(s => s.configDirty)
  return {
    warnings: list.warnings,
    hints: running ? ['实例运行中，配置变更需重启实例后生效'] : [],
  }
})

const portRules: FormRules = {
  serverPort: [
    { type: 'number', required: true, min: 1, max: 65535, message: '端口须在 1–65535', trigger: ['blur', 'change'] },
  ],
  steamAuthPort: [
    { type: 'number', required: true, min: 1, max: 65535, message: '端口须在 1–65535', trigger: ['blur', 'change'] },
  ],
  steamMasterPort: [
    { type: 'number', required: true, min: 1, max: 65535, message: '端口须在 1–65535', trigger: ['blur', 'change'] },
  ],
}

/** 分片状态标签：容器不存在不等于「没配置/没存档」，一律走全站状态词典 */
const masterShardStatus = computed(() => resolveShardDisplayStatus(masterShard.value))
const cavesShardStatus = computed(() => resolveShardDisplayStatus(cavesShard.value))

function resetLocalWorldRules() {
  masterWorldRules.value = {}
  cavesWorldRules.value = {}
  masterWorldgenConfig.value = {}
  cavesWorldgenConfig.value = {}
  masterWorldSeed.value = ''
  cavesWorldSeed.value = ''
  persistedMasterOverrides.value = {}
  persistedCavesOverrides.value = {}
}

function applyShardToForm(shard: ShardSummaryDto) {
  const persisted = { ...shard.overrides }
  if (shard.id === 'master') {
    persistedMasterOverrides.value = persisted
    masterWorldSeed.value = shard.worldSeed ?? ''
    applyLeveldataOverridesFromServer(masterWorldRules.value, 'rules', 'master', shard.overrides)
    applyLeveldataOverridesFromServer(masterWorldgenConfig.value, 'worldgen', 'master', shard.overrides)
  }
  else {
    persistedCavesOverrides.value = persisted
    cavesWorldSeed.value = shard.worldSeed ?? ''
    applyLeveldataOverridesFromServer(cavesWorldRules.value, 'rules', 'caves', shard.overrides)
    applyLeveldataOverridesFromServer(cavesWorldgenConfig.value, 'worldgen', 'caves', shard.overrides)
  }
  if (shard.serverPort != null) {
    if (shard.id === 'master') {
      masterForm.serverPort = shard.serverPort
      masterForm.steamAuthPort = shard.steamAuthPort ?? 8766
      masterForm.steamMasterPort = shard.steamMasterPort ?? 12346
      if (shard.worldgenPreset === 'SURVIVAL_TOGETHER') {
        masterForm.worldgenPreset = shard.worldgenPreset
      }
    }
    else {
      cavesForm.serverPort = shard.serverPort
      cavesForm.steamAuthPort = shard.steamAuthPort ?? 8768
      cavesForm.steamMasterPort = shard.steamMasterPort ?? 12348
      if (shard.worldgenPreset && shard.worldgenPreset !== 'SURVIVAL_TOGETHER') {
        cavesForm.worldgenPreset = shard.worldgenPreset as CavesWorldgenPreset
      }
    }
  }
}

async function loadConfig() {
  if (!instanceId.value) {
    return
  }
  loading.value = true
  try {
    resetLocalWorldRules()
    const response = await apiShard.getShardList(instanceId.value)
    shardList.value = response.data
    for (const shard of response.data.shards) {
      applyShardToForm(shard)
    }
    savedSnapshot.value = buildFormSnapshot()
    // 实例在运行、但当前世界的种子还没记录过：进页面就自动补读一次
    void autoProbeMissingSeeds()
  }
  catch {
    message.error('加载世界配置失败，请确认实例已安装后重试')
    shardList.value = null
  }
  finally {
    loading.value = false
  }
}

/** 世界种子：输入框显示的值（含回落到当前世界种子）；空串 = 留空（随机） */
function resolveWorldSeedPayload(shard: ShardId): string | null {
  const raw = (shard === 'master' ? masterSeedDisplay.value : cavesSeedDisplay.value).trim()
  return raw === '' ? null : raw
}

function buildSavePayload(shard: ShardId, restart: boolean): ShardSavePayload {
  const form = shard === 'master' ? masterForm : cavesForm
  const worldRules = shard === 'master' ? masterWorldRules.value : cavesWorldRules.value
  const worldgenConfig = shard === 'master' ? masterWorldgenConfig.value : cavesWorldgenConfig.value
  const summary = shard === 'master' ? masterShard.value : cavesShard.value
  const payload: ShardSavePayload = {
    instanceId: instanceId.value,
    shard,
    serverPort: form.serverPort,
    steamAuthPort: form.steamAuthPort,
    steamMasterPort: form.steamMasterPort,
    worldgenPreset: form.worldgenPreset,
    worldSeed: resolveWorldSeedPayload(shard),
    worldRuleOverrides: buildLeveldataOverridesPayload(
      shard,
      'rules',
      worldRules,
      shard === 'master' ? persistedMasterOverrides.value : persistedCavesOverrides.value,
    ),
    restart,
  }
  if (!summary?.worldGenerated) {
    payload.worldgenOverrides = buildLeveldataOverridesPayload(
      shard,
      'worldgen',
      worldgenConfig,
      shard === 'master' ? persistedMasterOverrides.value : persistedCavesOverrides.value,
    )
  }
  return payload
}

/** 保存前客户端预校验：把 zod 问题翻译成可定位的提示，避免后端原始报错直出 */
function describePayloadIssues(payload: ShardSavePayload): string | null {
  const parsed = shardSavePayloadSchema.safeParse(payload)
  if (parsed.success) {
    return null
  }
  for (const issue of parsed.error.issues) {
    const path = issue.path.map(p => String(p)).join('.')
    if (path.startsWith('worldRuleOverrides.') || path.startsWith('worldgenOverrides.')) {
      const key = String(issue.path[1] ?? '')
      return `世界规则项 ${key} 的值无效，请检查世界规则设置`
    }
    if (path === 'worldgenPreset') {
      return issue.message
    }
    if (path === 'worldSeed') {
      return '世界种子只能是 1–15 位数字'
    }
    if (path.endsWith('Port')) {
      return '端口须为 1–65535 的整数，请检查网络设置'
    }
    return issue.message
  }
  return '保存失败，请检查填写内容'
}

function getSaveOperation(shard: ShardId, restart: boolean): ShardSaveOperation {
  return `${shard}:${restart ? 'restart' : 'save'}`
}

/**
 * 读取当前世界的真实种子。
 *
 * 种子由游戏生成并记在存档里，只能向正在运行的分片询问；读到后面板会把它记下来，
 * 因此实例停服后这一栏依然显示得到。成功后只更新该分片的两个字段，
 * 不重载整页配置——否则会把用户还没保存的改动冲掉。
 */
async function readCurrentWorldSeed(shard: ShardId) {
  if (readingShards.value.includes(shard) || !instanceRunning.value) {
    return
  }
  readingShards.value = [...readingShards.value, shard]
  try {
    const response = await apiShard.readWorldSeed({ instanceId: instanceId.value, shard })
    const probe = response.data
    if (probe.available && probe.seed) {
      const target = shardList.value?.shards.find(item => item.id === shard)
      if (target) {
        target.currentWorldSeed = probe.seed
      }
      message.success(`当前世界种子：${probe.seed}`)
    }
    else {
      message.warning(probe.message ?? '暂时没读到当前世界的种子')
    }
  }
  catch (error: unknown) {
    message.error(error instanceof Error ? error.message : '读取当前世界种子失败')
  }
  finally {
    readingShards.value = readingShards.value.filter(item => item !== shard)
  }
}

/**
 * 实例运行中又还没有种子记录时，进页面就自动补读一次（串行，避免两条查询互相干扰）。
 * 只补读"还没有值"的分片；读不到就安静结束，用户仍可点「读取」重试。
 */
async function autoProbeMissingSeeds() {
  if (!instanceRunning.value) {
    return
  }
  for (const shard of shardList.value?.shards ?? []) {
    if (shard.currentWorldSeed || autoProbedShards.has(shard.id)) {
      continue
    }
    autoProbedShards.add(shard.id)
    await readCurrentWorldSeed(shard.id)
  }
}

/**
 * 按输入框里的种子重置世界：二次确认后交给面板删存档并启动实例。
 *
 * 与「世界维护」里的重置世界（把命令发给运行中的游戏）不同，这条路径要求实例已停止。
 */
function confirmResetWorldWithSeed(shard: ShardId) {
  if (resettingShards.value.includes(shard) || instanceRunning.value) {
    return
  }
  const seed = (shard === 'master' ? masterSeedDisplay.value : cavesSeedDisplay.value).trim()
  const shardLabel = shard === 'master' ? '地上世界' : '洞穴世界'
  dialog.warning({
    title: `重置${shardLabel}？`,
    content: () => h('div', { class: 'space-y-2 text-sm' }, [
      h('p', '当前世界会被丢弃，面板会先自动创建一份安全备份。'),
      h('p', seed ? `新地图使用种子 ${seed}。` : '种子留空，新地图由游戏随机生成。'),
      h('p', '重置后会立即启动实例，首次生成地图需要几分钟。'),
    ]),
    positiveText: '重置并启动',
    negativeText: '取消',
    onPositiveClick: () => resetWorldWithSeed(shard, seed),
  })
}

async function resetWorldWithSeed(shard: ShardId, seed: string) {
  resettingShards.value = [...resettingShards.value, shard]
  try {
    const response = await apiShard.resetWorldWithSeed({
      instanceId: instanceId.value,
      shard,
      worldSeed: seed === '' ? null : seed,
    })
    const result = response.data
    if (result.restartWarning) {
      notification.warning({
        title: '世界已重置，但实例没启动起来',
        content: result.restartWarning,
        duration: 0,
      })
    }
    else {
      message.success('已按新种子重置世界，实例正在启动')
    }
    if (result.backupWarning) {
      notification.warning({ title: '安全备份未成功', content: result.backupWarning, duration: 0 })
    }
    await loadConfig()
  }
  catch (error: unknown) {
    message.error(error instanceof Error ? error.message : '重置世界失败')
  }
  finally {
    resettingShards.value = resettingShards.value.filter(item => item !== shard)
  }
}

/** 底部按钮各自只反映自己的动作：只有当前分片正在执行的那一个动作显示 loading */
const savingCurrentShard = computed(() =>
  activeSaveOperation.value === getSaveOperation(currentShardId.value, false),
)
const restartingCurrentShard = computed(() =>
  activeSaveOperation.value === getSaveOperation(currentShardId.value, true),
)

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

async function saveShard(shard: ShardId, restart: boolean) {
  if (isSaving.value || allocatingPorts.value) {
    return
  }
  const formRef = shard === 'master' ? masterFormRef.value : cavesFormRef.value
  try {
    await formRef?.validate()
  }
  catch {
    return
  }
  if (shard === 'caves' && cavesForm.serverPort === masterForm.serverPort) {
    message.error('洞穴游戏端口不能与地上世界相同，请在「网络」页签中修改后保存')
    return
  }
  const payload = buildSavePayload(shard, restart)
  const payloadIssue = describePayloadIssues(payload)
  if (payloadIssue) {
    message.error(payloadIssue)
    return
  }
  const operation = getSaveOperation(shard, restart)
  activeSaveOperation.value = operation
  try {
    await apiShard.saveShardConfig(payload)
    message.success(restart ? '世界配置已保存并触发重启' : '世界配置已保存')
    await loadConfig()
  }
  catch (error: unknown) {
    if (restart && isInstancePortConflictError(error)) {
      const labels = getPortConflictDialogLabels('restart')
      dialog.warning({
        title: labels.title,
        content: () => h('div', { class: 'space-y-2 text-sm' }, [
          h('p', '世界配置已保存，但因端口冲突未能重启实例。'),
          h('p', error.error),
          h('p', { class: 'text-muted-foreground' }, formatPortConflictDetail(error.data ?? {})),
        ]),
        positiveText: labels.positiveText,
        negativeText: '留在本页修改端口',
        onPositiveClick: async () => {
          try {
            await apiInstance.restartInstance(instanceId.value, { autoAllocatePorts: true })
            message.success('已自动分配端口并完成重启')
            await loadConfig()
          }
          catch (retryError: unknown) {
            const description = retryError instanceof Error
              ? retryError.message
              : (typeof retryError === 'object' && retryError && 'error' in retryError
                ? String((retryError as { error?: string }).error)
                : '请稍后重试')
            message.error(description || '重启失败')
          }
        },
        onNegativeClick: () => {
          mainTab.value = shard === 'caves' ? 'caves' : 'surface'
          if (shard === 'caves') {
            cavesSubTab.value = 'network'
          }
          else {
            surfaceSubTab.value = 'network'
          }
        },
      })
      return
    }
    if (tryNotifyHostMemoryPressure(notification, error, () => router.push(routeToConsoleMonitor()))) {
      return
    }
    const msg = error instanceof Error
      ? error.message
      : (typeof error === 'object' && error && 'error' in error ? String((error as { error?: string }).error) : '保存失败')
    message.error(msg)
  }
  finally {
    if (activeSaveOperation.value === operation) {
      activeSaveOperation.value = null
    }
  }
}

function confirmSaveAndRestart(shard: ShardId) {
  dialog.warning({
    title: '保存并重启',
    content: '将保存当前世界配置并重启实例，在线玩家会被断开。是否继续？',
    positiveText: '继续',
    negativeText: '取消',
    onPositiveClick: () => saveShard(shard, true),
  })
}

function goClusterSettings() {
  router.push(routeToDstRoomSettings(instanceId.value))
}

function goBack() {
  router.push(routeToDstWorldList())
}

function applyRouteTabFromQuery() {
  if (route.query.tab === 'network') {
    mainTab.value = 'surface'
    surfaceSubTab.value = 'network'
  }
}

async function autoAllocatePorts() {
  if (!instanceId.value || allocatingPorts.value || isSaving.value) {
    return
  }
  allocatingPorts.value = true
  try {
    const { data } = await apiInstance.allocateInstancePorts(instanceId.value)
    const offset = data.gamePort - 10999
    masterForm.serverPort = data.gamePort
    masterForm.steamAuthPort = 8766 + offset
    masterForm.steamMasterPort = 12346 + offset
    if (cavesShard.value?.configured) {
      cavesForm.serverPort = masterForm.serverPort + 1
      cavesForm.steamAuthPort = masterForm.steamAuthPort + 2
      cavesForm.steamMasterPort = masterForm.steamMasterPort + 2
    }
    message.success(`已自动分配端口，主世界游戏端口为 ${data.gamePort}`)
  }
  catch (error) {
    const description = error instanceof Error
      ? error.message
      : (typeof error === 'object' && error && 'error' in error ? String((error as { error?: string }).error) : '请稍后重试')
    message.error(description || '自动分配端口失败')
  }
  finally {
    allocatingPorts.value = false
  }
}

watch(instanceId, (id) => {
  if (id) {
    void loadConfig()
  }
}, { immediate: true })

watch(() => route.query.tab, () => {
  applyRouteTabFromQuery()
}, { immediate: true })

onMounted(() => {
  applyRouteTabFromQuery()
})

onActivated(() => {
  applyRouteTabFromQuery()
  if (instanceId.value) {
    void loadConfig()
  }
})
</script>

<template>
  <FaPageMain>
    <template #title>
      <div class="flex flex-wrap items-center justify-between gap-4">
        <h1 class="text-lg font-semibold">
          {{ pageTitle }}
        </h1>

        <FaButton variant="outline" size="sm" @click="goBack">
          返回世界列表
        </FaButton>
      </div>
    </template>

    <NSpin v-if="loading && !shardList" size="large" class="block mx-auto my-8" />
    <template v-else>
      <NEmpty
        v-if="!shardList"
        class="py-16"
        description="未能加载世界配置，请确认实例已安装后重试。"
      >
        <template #extra>
          <NButton size="small" @click="goBack">
            返回世界列表
          </NButton>
          <NButton v-if="instanceId" size="small" class="ml-2" @click="loadConfig">
            重试
          </NButton>
        </template>
      </NEmpty>

      <div v-else class="space-y-4">
        <AdminSettingsSection
          title="世界配置"
          description="分别调整地上与洞穴的地图规则、端口与 Mod。"
        />
        <NAlert v-if="configAlerts.warnings.length" type="warning" title="需要处理" class="mb-2">
          <ul class="list-disc pl-4 space-y-1">
            <li v-for="(w, i) in configAlerts.warnings" :key="`w-${i}`">
              {{ w }}
            </li>
          </ul>
        </NAlert>
        <NAlert
          v-for="(hint, i) in configAlerts.hints"
          :key="`h-${i}`"
          type="info"
          :title="hint"
          class="mb-2"
        />

        <NCard size="small" title="洞穴开关">
          <p class="text-sm text-muted-foreground mb-2">
            是否在房间中同时运行地上与洞穴，请在房间设置中配置。
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <NTag :type="shardList.clusterShardEnabled ? 'info' : 'default'" size="small" :bordered="false">
              {{ shardList.clusterShardEnabled ? '洞穴已开启' : '洞穴未开启' }}
            </NTag>
            <!-- 目标页在「房间管理」模块下（room:read），无权时该路由不存在，按名跳转会抛 No match -->
            <NButton v-if="hasPermission('room:read')" size="small" text @click="goClusterSettings">
              前往房间设置
              <FaIcon name="i-lucide:arrow-right" class="size-4" />
            </NButton>
          </div>
        </NCard>

        <NTabs v-model:value="mainTab" type="card" animated>
          <NTabPane name="surface">
            <template #tab>
              <span class="inline-flex items-center gap-2">
                地上
                <NTag size="tiny" :bordered="false" :type="statusTagType(masterShardStatus.tone)">
                  {{ masterShardStatus.label }}
                </NTag>
              </span>
            </template>

            <NForm
              ref="masterFormRef"
              :model="masterForm"
              :rules="portRules"
              :label-placement="formLabelPlacement"
              :label-width="formLabelWidth"
            >
              <NTabs v-model:value="surfaceSubTab" type="card" placement="left" size="small" display-directive="show" class="mt-2">
                <NTabPane name="rules" tab="世界规则">
                  <p v-if="masterShard?.worldGenerated" class="mt-2 mb-4 text-xs text-muted-foreground">
                    地上世界已生成：世界规则的改动只在重新生成地图时生效，不会改变现有存档。
                  </p>
                  <ShardWorldRulesSection
                    v-model="masterWorldRules"
                    shard="master"
                    shard-folder="Master"
                  />
                </NTabPane>

                <NTabPane name="worldgen" tab="世界生成">
                  <ShardWorldgenSection
                    v-model="masterForm.worldgenPreset"
                    v-model:worldgen-config="masterWorldgenConfig"
                    :world-seed="masterSeedDisplay"
                    shard="master"
                    shard-folder="Master"
                    :current-world-seed="masterShard?.currentWorldSeed ?? null"
                    :instance-running="instanceRunning"
                    :reading="readingShards.includes('master')"
                    :resetting="resettingShards.includes('master')"
                    :world-generated="masterShard?.worldGenerated"
                    @update:world-seed="masterWorldSeed = $event"
                    @read="readCurrentWorldSeed('master')"
                    @reset="confirmResetWorldWithSeed('master')"
                  />
                </NTabPane>

                <NTabPane name="map" tab="地形图">
                  <ShardMapPanel
                    v-if="instanceId"
                    :instance-id="instanceId"
                    shard="master"
                  />
                </NTabPane>

                <NTabPane name="network" tab="网络">
                  <div class="flex flex-wrap items-center gap-2 mb-4">
                    <NButton
                      size="small"
                      :loading="allocatingPorts"
                      :disabled="isSaving"
                      @click="autoAllocatePorts"
                      v-if="hasPermission('instance:ports')"
                    >
                      自动分配未占用端口
                    </NButton>
                    <span class="text-xs text-muted-foreground">
                      与同节点其它实例冲突时可一键换用新端口块；保存后生效，运行中需重启。
                    </span>
                  </div>
                  <ShardNetworkSection
                    v-model:server-port="masterForm.serverPort"
                    v-model:steam-auth-port="masterForm.steamAuthPort"
                    v-model:steam-master-port="masterForm.steamMasterPort"
                    shard-folder="Master"
                  />
                </NTabPane>
              </NTabs>
            </NForm>

          </NTabPane>

          <NTabPane name="caves">
            <template #tab>
              <span class="inline-flex items-center gap-2">
                洞穴
                <NTag
                  v-if="clusterShardEnabled"
                  size="tiny"
                  :bordered="false"
                  :type="statusTagType(cavesShardStatus.tone)"
                >
                  {{ cavesShardStatus.label }}
                </NTag>
                <NTag v-else size="tiny" :bordered="false" type="default">
                  未开启
                </NTag>
              </span>
            </template>

            <template v-if="!clusterShardEnabled">
              <p class="text-sm text-muted-foreground mt-2 mb-4">
                需先在房间设置中开启洞穴，才能调整洞穴的世界规则与世界生成。
              </p>
              <NButton v-if="hasPermission('room:read')" size="small" @click="goClusterSettings">
                前往房间设置
              </NButton>
            </template>

            <template v-else>
              <NForm
                ref="cavesFormRef"
                :model="cavesForm"
                :rules="portRules"
                :label-placement="formLabelPlacement"
                :label-width="formLabelWidth"
              >
                <NTabs v-model:value="cavesSubTab" type="card" placement="left" size="small" display-directive="show" class="mt-2">
                  <NTabPane name="rules" tab="世界规则">
                    <p v-if="cavesShard?.worldGenerated" class="mt-2 mb-4 text-xs text-muted-foreground">
                      洞穴世界已生成：世界规则的改动只在重新生成地图时生效，不会改变现有存档。
                    </p>
                    <ShardWorldRulesSection
                      v-model="cavesWorldRules"
                      shard="caves"
                      shard-folder="Caves"
                    />
                  </NTabPane>

                  <NTabPane name="worldgen" tab="世界生成">
                    <ShardWorldgenSection
                      v-model="cavesForm.worldgenPreset"
                      v-model:worldgen-config="cavesWorldgenConfig"
                      :world-seed="cavesSeedDisplay"
                      shard="caves"
                      shard-folder="Caves"
                      :current-world-seed="cavesShard?.currentWorldSeed ?? null"
                      :instance-running="instanceRunning"
                      :reading="readingShards.includes('caves')"
                      :resetting="resettingShards.includes('caves')"
                      :world-generated="cavesShard?.worldGenerated"
                      @update:world-seed="cavesWorldSeed = $event"
                      @read="readCurrentWorldSeed('caves')"
                      @reset="confirmResetWorldWithSeed('caves')"
                    />
                  </NTabPane>

                  <NTabPane name="network" tab="网络">
                    <ShardNetworkSection
                      v-model:server-port="cavesForm.serverPort"
                      v-model:steam-auth-port="cavesForm.steamAuthPort"
                      v-model:steam-master-port="cavesForm.steamMasterPort"
                      shard-folder="Caves"
                      show-port-hint
                    />
                  </NTabPane>
                </NTabs>
              </NForm>

            </template>
          </NTabPane>

          <NTabPane name="mods" tab="模组">
            <ShardModsSection
              :instance-id="instanceId"
              :memory-warning="hostMemoryGuidance?.modsWarning ?? null"
            />
          </NTabPane>
        </NTabs>

        <NCard v-if="mainTab !== 'mods'" title="世界维护" size="small" class="mt-4">
          <WorldMaintenanceCard
            :instance-id="instanceId"
            :shard="mainTab === 'caves' ? 'caves' : 'master'"
            :instance-name="shardList?.instanceName ?? ''"
          />
        </NCard>

        <ConfigActionBar
          :dirty="formDirty"
          :busy="isSaving || resetting"
          :saving="savingCurrentShard"
          :restarting="restartingCurrentShard"
          :resetting="resetting"
          :restart-disabled="saveAndRestartDisabled"
          :restart-disabled-title="saveAndRestartDisabledTitle"
          :show-restart="hasPermission('instance:lifecycle')"
          :save-label="mainTab === 'caves' ? '保存洞穴' : '保存地上'"
          @reset="resetConfig"
          @save="saveShard(currentShardId, false)"
          @save-and-restart="confirmSaveAndRestart(currentShardId)"
          v-if="hasPermission('world:write')"
        />
      </div>
    </template>
  </FaPageMain>
</template>
