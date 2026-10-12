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
  NCheckbox,
  NInput,
  NModal,
  NSpace,
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
import { keyboardTabProps } from '@/utils/keyboardTab'
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
import WorldMaintenanceStatus from '@/components/WorldMaintenanceStatus.vue'
import { useWorldMaintenance } from '@/composables/useWorldMaintenance'
import ShardModsSection from './components/ShardModsSection.vue'
import ShardWorldRulesSection from './components/ShardWorldRulesSection.vue'
import { refreshWorldPorts, savedWorldDraft, worldDraftChanged, type WorldDraft } from './worldDraft'
import ShardWorldgenSection from './components/ShardWorldgenSection.vue'
import ShardMapPanel from './components/ShardMapPanel.vue'
import {
  applyLeveldataOverridesFromServer,
  buildLeveldataOverridesPayload,
} from './utils/leveldataOverrides'

type ShardSubTab = 'rules' | 'worldgen' | 'network' | 'map'
type ShardSaveOperation = `${ShardId}:${'save' | 'restart'}`

defineOptions({
  name: 'DstWorldSettings',
})

const route = useRoute()
const router = useRouter()
const dialog = useDialog()
const message = useMessage()
const notification = useNotification()

const { isNarrowViewport, formLabelPlacement, formLabelWidth } = useNarrowFormLayout(140)
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
/** 用户主动清空也算编辑，后续读取不能再把当前种子填回来。 */
const editedSeedShards = new Set<ShardId>()

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

const savedDrafts = ref<Partial<Record<ShardId, WorldDraft>>>({})

function captureDraft(shard: ShardId): WorldDraft {
  const master = shard === 'master'
  return {
    form: { ...(master ? masterForm : cavesForm) },
    rules: { ...(master ? masterWorldRules.value : cavesWorldRules.value) },
    worldgen: { ...(master ? masterWorldgenConfig.value : cavesWorldgenConfig.value) },
    seed: master ? masterWorldSeed.value : cavesWorldSeed.value,
  }
}

function shardDirty(shard: ShardId, configOnly = false) {
  return worldDraftChanged(captureDraft(shard), savedDrafts.value[shard],
    Boolean(shardList.value?.shards.find(item => item.id === shard)?.worldGenerated), configOnly)
}
const formDirty = computed(() => shardDirty('master') || shardDirty('caves'))

useUnsavedChangesGuard(formDirty)

/** 底部保存栏作用于当前激活的分片（模组页签不保存） */
const currentShardId = computed<ShardId>(() => (mainTab.value === 'caves' ? 'caves' : 'master'))

const clusterShardEnabled = computed(() => Boolean(shardList.value?.clusterShardEnabled))
const instanceRunning = computed(() => shardList.value?.instanceStatus === 'running')
const masterShard = computed(() => shardList.value?.shards.find(s => s.id === 'master'))
const cavesShard = computed(() => shardList.value?.shards.find(s => s.id === 'caves'))
const currentShard = computed(() => currentShardId.value === 'master' ? masterShard.value : cavesShard.value)
const currentConfigDirty = computed(() => shardDirty(currentShardId.value, true))
const showSaveBar = computed(() => mainTab.value !== 'mods'
  && (mainTab.value !== 'caves' || clusterShardEnabled.value)
  && (mainTab.value !== 'surface' || surfaceSubTab.value !== 'map'))
const draftBusy = computed(() => isSaving.value || resetting.value || maintenanceBusy.value || allocatingPorts.value)
const configReadOnly = computed(() => !hasPermission('world:write') || draftBusy.value)
const seedPending = (shard: ShardId) => Boolean(shardList.value?.shards.find(item => item.id === shard)?.worldGenerated
  && savedDrafts.value[shard] && captureDraft(shard).seed !== savedDrafts.value[shard]?.seed)
const saveStatus = computed(() => {
  const name = currentShardId.value === 'master' ? '地上' : '洞穴'
  const status = currentConfigDirty.value ? '有未保存的修改'
    : currentShard.value?.configDirty ? '已保存，重启后生效' : '已保存'
  return `${name}：${status}${seedPending(currentShardId.value) ? ' · 新种子尚未应用' : ''}`
})

const masterSeedDisplay = computed(() => masterWorldSeed.value)
const cavesSeedDisplay = computed(() => cavesWorldSeed.value)
const readingShards = ref<ShardId[]>([])
const { operation: maintenanceOperation, activeKey: maintenanceKey, busy: maintenanceBusy, submitting: maintenanceSubmitting, backupBefore, submit: submitMaintenance, continueWithoutBackup, recheck } = useWorldMaintenance(instanceId, () => hasPermission('world:reset') || hasPermission('world:rollback') || hasPermission('console:command'))
const seedModalVisible = ref(false)
const seedConfirmName = ref('')
const selectedSeed = ref<{ shard: ShardId, seed: string | null } | null>(null)
const seedResetLoading = (shard: ShardId) => maintenanceKey.value === `seed-${shard}` && (maintenanceSubmitting.value || maintenanceOperation.value?.state === 'running')
/** 本次进入页面已经自动尝试过读取的分片：避免反复打扰游戏进程 */
const autoProbedShards = new Set<ShardId>()

/**
 * 顶部只承载需要处理的异常；重启生效提示放在保存栏。
 * 静态说明（世界已生成、放行端口、洞穴未开启）一律内联到对应页签与控件旁，避免同一信息重复出现。
 */
const configAlerts = computed(() => {
  const list = shardList.value
  if (!list) {
    return { warnings: [] as string[], hints: [] as string[] }
  }
  return {
    warnings: list.warnings,
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
  editedSeedShards.clear()
  autoProbedShards.clear()
  persistedMasterOverrides.value = {}
  persistedCavesOverrides.value = {}
}

function applyShardToForm(shard: ShardSummaryDto) {
  const persisted = { ...shard.overrides }
  if (shard.id === 'master') {
    persistedMasterOverrides.value = persisted
    masterWorldSeed.value = shard.currentWorldSeed ?? shard.worldSeed ?? ''
    applyLeveldataOverridesFromServer(masterWorldRules.value, 'rules', 'master', shard.overrides)
    applyLeveldataOverridesFromServer(masterWorldgenConfig.value, 'worldgen', 'master', shard.overrides)
  }
  else {
    persistedCavesOverrides.value = persisted
    cavesWorldSeed.value = shard.currentWorldSeed ?? shard.worldSeed ?? ''
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
  const requestedInstanceId = instanceId.value
  try {
    const response = await apiShard.getShardList(requestedInstanceId)
    if (requestedInstanceId !== instanceId.value) return
    resetLocalWorldRules()
    shardList.value = response.data
    savedDrafts.value = {}
    for (const shard of response.data.shards) {
      applyShardToForm(shard)
      savedDrafts.value[shard.id] = captureDraft(shard.id)
    }
    // 实例在运行、但当前世界的种子还没记录过：进页面就自动补读一次
    void autoProbeMissingSeeds()
  }
  catch {
    if (requestedInstanceId === instanceId.value) message.error('世界配置加载失败，请重试')
  }
  finally {
    if (requestedInstanceId === instanceId.value) loading.value = false
  }
}

function updateWorldSeedDraft(shard: ShardId, value: string) {
  editedSeedShards.add(shard)
  const draft = shard === 'master' ? masterWorldSeed : cavesWorldSeed
  draft.value = value
}

/** 自动回写真实种子不产生未保存修改，也不覆盖用户新种子或留空选择。 */
function adoptCurrentWorldSeed(shard: ShardId, seed: string) {
  if (editedSeedShards.has(shard)) return
  const draft = shard === 'master' ? masterWorldSeed : cavesWorldSeed
  draft.value = seed
  if (savedDrafts.value[shard]) savedDrafts.value[shard]!.seed = seed
}

/** 世界种子草稿；空串 = 用户选择随机，点击重置前不改变当前存档。 */
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
    worldRuleOverrides: buildLeveldataOverridesPayload(
      shard,
      'rules',
      worldRules,
      shard === 'master' ? persistedMasterOverrides.value : persistedCavesOverrides.value,
    ),
    restart,
  }
  if (!summary?.worldGenerated) {
    payload.worldSeed = resolveWorldSeedPayload(shard)
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
 * 因此实例停服后输入框依然显示得到。成功后只更新当前种子与未编辑的输入，
 * 不重载整页配置——否则会把用户还没保存的改动冲掉。
 */
async function readCurrentWorldSeed(shard: ShardId) {
  if (readingShards.value.includes(shard) || !instanceRunning.value) {
    return
  }
  readingShards.value = [...readingShards.value, shard]
  const requestedInstanceId = instanceId.value
  try {
    const response = await apiShard.readWorldSeed({ instanceId: requestedInstanceId, shard })
    if (requestedInstanceId !== instanceId.value) return
    const probe = response.data
    if (probe.available && probe.seed) {
      const target = shardList.value?.shards.find(item => item.id === shard)
      if (target) {
        target.currentWorldSeed = probe.seed
      }
      adoptCurrentWorldSeed(shard, probe.seed)
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

async function confirmResetWorldWithSeed(shard: ShardId) {
  if (maintenanceBusy.value || isSaving.value) return
  const requestedInstanceId = instanceId.value
  const target = shardList.value?.shards.find(item => item.id === shard)
  // 未编辑的已生成世界必须沿用真实种子，不能把未读到误当成随机重置。
  if (target?.worldGenerated && !target.currentWorldSeed && !editedSeedShards.has(shard)) {
    if (instanceRunning.value) await readCurrentWorldSeed(shard)
    if (requestedInstanceId !== instanceId.value) return
    if (!target.currentWorldSeed && !editedSeedShards.has(shard)) {
      message.warning('尚未读到当前世界种子，请先运行实例读取，或手动填写种子后重置。')
      return
    }
  }
  if (maintenanceBusy.value || isSaving.value) return
  const seed = (shard === 'master' ? masterWorldSeed.value : cavesWorldSeed.value).trim()
  selectedSeed.value = { shard, seed: seed || null }
  seedConfirmName.value = ''
  seedModalVisible.value = true
}
async function resetWorldWithSeed() {
  if (!selectedSeed.value || maintenanceBusy.value || seedConfirmName.value.trim() !== shardList.value?.instanceName.trim()) return
  const selected = { ...selectedSeed.value }
  seedModalVisible.value = false
  await submitMaintenance({ action: 'regenerate', confirmName: seedConfirmName.value.trim(), shard: selected.shard, worldSeed: selected.seed }, `seed-${selected.shard}`)
}
// 只刷新真实状态和已保存种子；不会用回读值覆盖输入框或其他尚未保存的草稿。
watch(() => maintenanceOperation.value?.state, async (state, previous) => {
  if (!state || !previous || state === previous || !['completed', 'failed', 'unknown', 'cancelled'].includes(state)) return
  const operation = maintenanceOperation.value
  const requestedInstanceId = instanceId.value
  try {
    const latest = (await apiShard.getShardList(requestedInstanceId)).data
    if (requestedInstanceId !== instanceId.value || operation?.id !== maintenanceOperation.value?.id) return
    shardList.value = latest
    if (state === 'completed' && operation?.action === 'regenerate') {
      for (const shard of operation.shards) editedSeedShards.delete(shard)
    }
    for (const shard of latest.shards) {
      if (shard.currentWorldSeed) adoptCurrentWorldSeed(shard.id, shard.currentWorldSeed)
    }
    for (const shard of latest.shards) {
      const saved = savedDrafts.value[shard.id]
      if (saved) saved.seed = shard.currentWorldSeed ?? shard.worldSeed ?? ''
    }
  }
  catch { /* 查询失败保留已有草稿和读数 */ }
})

/** 底部按钮各自只反映自己的动作：只有当前分片正在执行的那一个动作显示 loading */
const savingCurrentShard = computed(() =>
  activeSaveOperation.value === getSaveOperation(currentShardId.value, false),
)
const restartingCurrentShard = computed(() =>
  activeSaveOperation.value === getSaveOperation(currentShardId.value, true),
)

/** 重置：丢弃本地未保存修改，重新拉取远端配置 */
async function resetConfig() {
  if (isSaving.value || resetting.value || maintenanceBusy.value) {
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

function confirmDiscardDrafts() {
  dialog.warning({
    title: '放弃全部修改？',
    content: '地上和洞穴尚未保存的配置与未应用的种子将一起丢弃。',
    positiveText: '放弃全部修改',
    negativeText: '继续编辑',
    onPositiveClick: resetConfig,
  })
}

async function saveShard(shard: ShardId, restart: boolean) {
  if (isSaving.value || allocatingPorts.value || maintenanceBusy.value) {
    return
  }
  const formRef = shard === 'master' ? masterFormRef.value : cavesFormRef.value
  try {
    await formRef?.validate()
  }
  catch {
    return
  }
  if (draftBusy.value) return
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
  const submitted = captureDraft(shard)
  const generated = Boolean(shardList.value?.shards.find(item => item.id === shard)?.worldGenerated)
  const targetId = instanceId.value
  function acceptSave() {
    const previous = savedDrafts.value[shard]
    if (targetId !== instanceId.value || !previous) return
    savedDrafts.value[shard] = savedWorldDraft(submitted, previous, generated)
    const overrides = shard === 'master' ? persistedMasterOverrides : persistedCavesOverrides
    overrides.value = { ...overrides.value, ...payload.worldRuleOverrides, ...payload.worldgenOverrides }
  }
  async function refreshSavedStatus(syncAllocatedPorts = false) {
    try {
      const latest = (await apiShard.getShardList(targetId)).data
      if (targetId !== instanceId.value) return
      if (syncAllocatedPorts) {
        for (const remote of latest.shards) {
          const saved = savedDrafts.value[remote.id]
          if (saved) refreshWorldPorts(remote.id === 'master' ? masterForm : cavesForm, saved.form, remote)
        }
      }
      shardList.value = latest
    }
    catch { message.warning('配置已保存，状态刷新失败，请稍后重试') }
  }
  activeSaveOperation.value = operation
  try {
    await apiShard.saveShardConfig(payload)
    if (targetId !== instanceId.value) return
    acceptSave()
    message.success(restart ? '已保存，正在重启' : `${shard === 'master' ? '地上' : '洞穴'}配置已保存`)
    await refreshSavedStatus()
  }
  catch (error: unknown) {
    if (targetId !== instanceId.value) return
    if (restart && isInstancePortConflictError(error)) {
      acceptSave()
      await refreshSavedStatus()
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
            await apiInstance.restartInstance(targetId, { autoAllocatePorts: true })
            message.success('已自动分配端口并完成重启')
            await refreshSavedStatus(true)
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
    content: `保存${shard === 'master' ? '地上' : '洞穴'}配置并重启整个实例，在线玩家会断开连接。另一世界的未保存修改不会提交。`,
    positiveText: '保存并重启',
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
    savedDrafts.value = {}
    shardList.value = null
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
  if (instanceId.value && !formDirty.value && !loading.value) {
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
          <NButton v-if="instanceId" size="small" class="ml-2" @click="loadConfig()">
            重试
          </NButton>
        </template>
      </NEmpty>

      <div v-else class="space-y-4">
        <NAlert v-if="configAlerts.warnings.length" type="warning" title="需要处理" class="mb-2">
          <ul class="list-disc pl-4 space-y-1">
            <li v-for="(w, i) in configAlerts.warnings" :key="`w-${i}`">
              {{ w }}
            </li>
          </ul>
        </NAlert>
          <div class="flex flex-wrap items-center gap-3 text-sm">
            <NTag :type="shardList.clusterShardEnabled ? 'info' : 'default'" size="small" :bordered="false">
              {{ shardList.clusterShardEnabled ? '洞穴已开启' : '洞穴未开启' }}
            </NTag>
            <!-- 目标页在「房间管理」模块下（room:read），无权时该路由不存在，按名跳转会抛 No match -->
            <NButton v-if="hasPermission('room:read')" size="small" text @click="goClusterSettings">
              房间设置
              <FaIcon name="i-lucide:arrow-right" class="size-4" />
            </NButton>
          </div>

        <NTabs v-model:value="mainTab" type="card" animated>
          <NTabPane :tab-props="keyboardTabProps(mainTab === 'surface')" name="surface">
            <template #tab>
              <span class="inline-flex items-center gap-2">
                地上
                <span v-if="shardDirty('master')" class="text-xs text-muted-foreground">未保存</span>
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
              :disabled="configReadOnly"
            >
              <NTabs v-model:value="surfaceSubTab" type="line" :placement="isNarrowViewport ? 'top' : 'left'" size="small" display-directive="show" class="mt-2">
                <NTabPane :tab-props="keyboardTabProps(surfaceSubTab === 'rules')" name="rules" tab="世界规则">
                  <p v-if="masterShard?.worldGenerated" class="mt-2 mb-4 text-sm text-muted-foreground">
                    改动用于下次生成地图，现有存档不变。
                  </p>
                  <ShardWorldRulesSection
                    v-model="masterWorldRules"
                    shard="master"
                    shard-folder="Master"
                    :disabled="configReadOnly"
                  />
                </NTabPane>

                <NTabPane :tab-props="keyboardTabProps(surfaceSubTab === 'worldgen')" name="worldgen" tab="世界生成">
                  <ShardWorldgenSection
                    :key="`master-${instanceId}`"
                    v-model="masterForm.worldgenPreset"
                    v-model:worldgen-config="masterWorldgenConfig"
                    :world-seed="masterSeedDisplay"
                    shard="master"
                    shard-folder="Master"
                    :instance-running="instanceRunning"
                    :reading="readingShards.includes('master')"
                    :resetting="seedResetLoading('master')"
                    :busy="draftBusy"
                    :seed-pending="seedPending('master')"
                    :world-generated="masterShard?.worldGenerated"
                    @update:world-seed="updateWorldSeedDraft('master', $event)"
                    @read="readCurrentWorldSeed('master')"
                    @reset="confirmResetWorldWithSeed('master')"
                  />
                </NTabPane>

                <NTabPane :tab-props="keyboardTabProps(surfaceSubTab === 'map')" name="map" tab="地形图">
                  <ShardMapPanel
                    v-if="instanceId"
                    :instance-id="instanceId"
                    shard="master"
                  />
                </NTabPane>

                <NTabPane :tab-props="keyboardTabProps(surfaceSubTab === 'network')" name="network" tab="网络">
                  <div class="flex flex-wrap items-center gap-2 mb-4">
                    <NButton
                      size="small"
                      :loading="allocatingPorts"
                      :disabled="draftBusy"
                      @click="autoAllocatePorts"
                      v-if="hasPermission('instance:ports')"
                    >
                      自动分配端口
                    </NButton>
                    <span class="text-sm text-muted-foreground">
                      为地上和洞穴分配可用端口，分别保存后生效。运行中需重启。
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

          <NTabPane :tab-props="keyboardTabProps(mainTab === 'caves')" name="caves">
            <template #tab>
              <span class="inline-flex items-center gap-2">
                洞穴
                <span v-if="shardDirty('caves')" class="text-xs text-muted-foreground">未保存</span>
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
                洞穴未开启
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
                :disabled="configReadOnly"
              >
                <NTabs v-model:value="cavesSubTab" type="line" :placement="isNarrowViewport ? 'top' : 'left'" size="small" display-directive="show" class="mt-2">
                  <NTabPane :tab-props="keyboardTabProps(cavesSubTab === 'rules')" name="rules" tab="世界规则">
                    <p v-if="cavesShard?.worldGenerated" class="mt-2 mb-4 text-sm text-muted-foreground">
                      改动用于下次生成地图，现有存档不变。
                    </p>
                    <ShardWorldRulesSection
                      v-model="cavesWorldRules"
                      shard="caves"
                      shard-folder="Caves"
                      :disabled="configReadOnly"
                    />
                  </NTabPane>

                  <NTabPane :tab-props="keyboardTabProps(cavesSubTab === 'worldgen')" name="worldgen" tab="世界生成">
                    <ShardWorldgenSection
                      :key="`caves-${instanceId}`"
                      v-model="cavesForm.worldgenPreset"
                      v-model:worldgen-config="cavesWorldgenConfig"
                      :world-seed="cavesSeedDisplay"
                      shard="caves"
                      shard-folder="Caves"
                      :instance-running="instanceRunning"
                      :reading="readingShards.includes('caves')"
                      :resetting="seedResetLoading('caves')"
                      :busy="draftBusy"
                      :seed-pending="seedPending('caves')"
                      :world-generated="cavesShard?.worldGenerated"
                      @update:world-seed="updateWorldSeedDraft('caves', $event)"
                      @read="readCurrentWorldSeed('caves')"
                      @reset="confirmResetWorldWithSeed('caves')"
                    />
                  </NTabPane>

                  <NTabPane :tab-props="keyboardTabProps(cavesSubTab === 'network')" name="network" tab="网络">
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

          <NTabPane :tab-props="keyboardTabProps(mainTab === 'mods')" name="mods" tab="模组">
            <ShardModsSection
              :instance-id="instanceId"
              :memory-warning="hostMemoryGuidance?.modsWarning ?? null"
            />
          </NTabPane>
        </NTabs>

        <WorldMaintenanceStatus :operation="maintenanceOperation" :submitting="maintenanceSubmitting" :show-backup-link="false" @continue="continueWithoutBackup" @verify="recheck" />
        <NModal v-model:show="seedModalVisible" preset="card" :title="selectedSeed?.shard === 'master' ? '重新生成地上' : '重新生成洞穴'" class="max-w-lg" :mask-closable="false">
          <div class="space-y-3 text-sm mb-4">
            <p>{{ selectedSeed?.seed ? `种子：${selectedSeed.seed}` : '使用随机种子' }}。其他设置使用已保存的配置，未保存修改不会提交。</p>
            <p>所选世界的建筑、物品、玩家进度和旧存档点会被清除。另一个世界也可能重新加载或调整存档进度，玩家可能断线。</p>
            <p class="text-muted-foreground">相同种子不能恢复游戏进度；地图还受预设、Mod 和游戏版本影响。</p>
            <NCheckbox v-model:checked="backupBefore">先备份整个房间，备份失败时暂停</NCheckbox>
          </div>
          <label for="seed-confirm-name" class="block text-sm mb-2">输入实例名称「{{ shardList?.instanceName }}」确认</label>
          <NInput v-model:value="seedConfirmName" :input-props="{ id: 'seed-confirm-name' }" placeholder="实例名称" />
          <NSpace justify="end" class="mt-4">
            <NButton @click="seedModalVisible = false">取消</NButton>
            <NButton type="error" :disabled="maintenanceBusy || !shardList?.instanceName || seedConfirmName.trim() !== shardList.instanceName.trim()" @click="resetWorldWithSeed">确认重新生成</NButton>
          </NSpace>
        </NModal>

        <ConfigActionBar
          :dirty="currentConfigDirty"
          :reset-dirty="formDirty"
          :status-text="saveStatus"
          :restart-needed="currentShard?.configDirty"
          reset-label="放弃全部修改"
          :busy="draftBusy"
          :saving="savingCurrentShard"
          :restarting="restartingCurrentShard"
          :resetting="resetting"
          :restart-disabled="saveAndRestartDisabled"
          :restart-disabled-title="saveAndRestartDisabledTitle"
          :show-restart="hasPermission('instance:lifecycle')"
          :save-label="mainTab === 'caves' ? '保存洞穴' : '保存地上'"
          @reset="confirmDiscardDrafts"
          @save="saveShard(currentShardId, false)"
          @save-and-restart="confirmSaveAndRestart(currentShardId)"
          v-if="hasPermission('world:write') && showSaveBar"
        />
      </div>
    </template>
  </FaPageMain>
</template>
