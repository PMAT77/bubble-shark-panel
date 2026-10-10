<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { NButton, NCard, NFormItem, NInputNumber, NSpin, useMessage } from 'naive-ui'
import apiInstance, { type InstanceItem, type InstanceResourceConfig, type InstanceResourcesPayload, type ResourceSnapshot } from '@/api/modules/instance'
import { copyTextToClipboard } from '@/utils/copyToClipboard'
import { formatMemoryMb } from '../../instanceDisplay'
import { isStartupActive } from '../../startupPresentation'
import { resourceOomKillCount, resourceRecommendationWarning } from '../../resourceSettingsPresentation'
import { formatDateTime } from '../../utils'

const props = defineProps<{ instance: InstanceItem }>()
const { auth: hasPermission } = useAppAuth()
const message = useMessage()
const route = useRoute()
const payload = ref<InstanceResourcesPayload | null>(null)
const draft = ref<InstanceResourceConfig>({ masterMemoryMb: null, cavesMemoryMb: null, shardReadyWaitSec: null })
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const swapLabels: Record<InstanceResourcesPayload['swapAdvice']['state'], string> = { unknown: '状态未知', none: '未配置', low: '余量不足', exhausted: '已用尽', ready: '可用' }
let active = true
let generation = 0
let controller: AbortController | undefined
let refreshTimer: ReturnType<typeof setInterval> | undefined
const canWrite = computed(() => hasPermission('instance:lifecycle'))
const dirty = computed(() => payload.value && JSON.stringify(draft.value) !== JSON.stringify(payload.value.config))
const valid = computed(() => [draft.value.masterMemoryMb, draft.value.cavesMemoryMb].every(value => value === null || value === 0 || value >= 6)
  && (draft.value.shardReadyWaitSec === null || draft.value.shardReadyWaitSec >= 1))
const cavesEnabled = computed(() => props.instance.startup?.caves.state !== 'disabled')
const current = computed(() => ({
  master: (isStartupActive(props.instance.startup) ? props.instance.startup?.master.resources : null) ?? payload.value?.current.master ?? null,
  caves: (isStartupActive(props.instance.startup) ? props.instance.startup?.caves.resources : null) ?? payload.value?.current.caves ?? null,
}))
function limitLabel(value: number | null | undefined) { return value == null || value === 0 ? '不限' : `${Math.round(value)} MiB` }
function currentLabel(snapshot: ResourceSnapshot | null) {
  return snapshot ? `${formatMemoryMb(snapshot.memoryCurrentMb)} / 上限 ${snapshot.memoryMaxState === 'unlimited' ? '不限' : snapshot.memoryMaxMb === null ? '未知' : limitLabel(snapshot.memoryMaxMb)}，运行时内核峰值 ${formatMemoryMb(snapshot.memoryPeakMb)}，swap ${formatMemoryMb(snapshot.swapCurrentMb)}` : '暂无运行数据'
}
const highWarning = computed(() => Object.values(current.value).some(snapshot => snapshot && snapshot.memoryHighMb !== null && snapshot.memoryHighMb > 0)
  ? '当前分片仍存在 MemoryHigh 软限制，可能触发强制回收并拖慢加载。保存设置后重新启动实例以应用新配置。' : null)
const recommendationWarning = computed(() => payload.value
  ? resourceRecommendationWarning(payload.value.effective, payload.value.recommendation, cavesEnabled.value) : null)
const oomLabel = computed(() => isStartupActive(props.instance.startup) ? '本轮 OOM终止次数' : '运行时累计 OOM终止次数')

async function load(preserveDraft = false) {
  if (!active) return
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  const version = ++generation
  const id = props.instance.id
  loading.value = true
  error.value = ''
  try {
    const result = await apiInstance.getInstanceResources(id, { signal })
    if (version !== generation || signal.aborted || id !== props.instance.id) return
    payload.value = result.data
    if (!preserveDraft) draft.value = { ...result.data.config }
  }
  catch (cause) { if (version === generation && !signal.aborted) error.value = cause instanceof Error ? cause.message : '资源信息读取失败' }
  finally { if (version === generation) loading.value = false }
}
async function save() {
  if (!canWrite.value || !valid.value || saving.value) return
  const id = props.instance.id
  const version = generation
  saving.value = true
  try {
    const result = await apiInstance.saveInstanceResources(id, { ...draft.value })
    if (!active || id !== props.instance.id || version !== generation) return
    payload.value = result.data
    draft.value = { ...result.data.config }
    message.success('资源设置已保存，下次启动生效')
  }
  catch (cause) { if (active && id === props.instance.id) message.error(cause instanceof Error ? cause.message : '保存失败') }
  finally { saving.value = false }
}
function useRecommendation() {
  if (!payload.value) return
  draft.value = { ...draft.value, masterMemoryMb: payload.value.recommendation.masterMemoryMb, cavesMemoryMb: payload.value.recommendation.cavesMemoryMb }
}
async function copyCommand() {
  const command = payload.value?.swapAdvice.command
  if (!command) return
  const copied = await copyTextToClipboard(command)
  message[copied ? 'success' : 'warning'](copied ? '命令已复制，请在服务器上以 root 执行' : '复制失败，请手动选中命令复制')
}
async function copyBudgetCommand() {
  const copied = await copyTextToClipboard('sudo bsp setup-memory-budget')
  message[copied ? 'success' : 'warning'](copied ? '命令已复制，停止同机全部实例后以 root 执行' : '复制失败，请手动复制')
}
function stop() { active = false; generation++; controller?.abort(); loading.value = false; clearInterval(refreshTimer); refreshTimer = undefined }
function activate() {
  active = true
  void load()
  clearInterval(refreshTimer)
  refreshTimer = setInterval(() => { if (active && !loading.value && !saving.value) void load(Boolean(dirty.value)) }, 5000)
  if (route.hash === '#instance-resources') void nextTick(() => document.getElementById('instance-resources')?.scrollIntoView({ block: 'start' }))
}
onMounted(activate)
onActivated(activate)
onDeactivated(stop)
onBeforeUnmount(stop)
watch(() => props.instance.id, () => { payload.value = null; void load() })
watch(() => `${props.instance.status}:${props.instance.startup?.status ?? ''}`, () => { if (active) void load(Boolean(dirty.value)) })
</script>

<template>
  <NCard id="instance-resources" title="资源与启动设置" size="small" class="mt-4">
    <template #header-extra><NButton size="tiny" secondary :loading="loading" :disabled="saving || !!dirty" @click="load()">刷新</NButton></template>
    <NSpin :show="loading && !payload">
      <p v-if="error" class="text-sm text-red-500">{{ error }}</p>
      <div v-if="payload" class="space-y-3 text-sm">
        <div class="grid gap-2 md:grid-cols-2">
          <p>主世界当前：{{ currentLabel(current.master) }}</p>
          <p v-if="cavesEnabled">洞穴当前：{{ currentLabel(current.caves) }}</p>
        </div>
        <div class="text-xs text-muted-foreground space-y-1">
          <p v-if="current.master">主世界内存压力（近10秒）：{{ current.master.memoryPressureFullAvg10 === null ? '—' : `${current.master.memoryPressureFullAvg10.toFixed(1)}%` }}；{{ oomLabel }}：{{ resourceOomKillCount(instance.startup, 'master', current.master) ?? '—' }}。</p>
          <p v-if="cavesEnabled && current.caves">洞穴内存压力（近10秒）：{{ current.caves.memoryPressureFullAvg10 === null ? '—' : `${current.caves.memoryPressureFullAvg10.toFixed(1)}%` }}；{{ oomLabel }}：{{ resourceOomKillCount(instance.startup, 'caves', current.caves) ?? '—' }}。</p>
        </div>
        <p v-if="highWarning" role="alert" class="text-amber-600 dark:text-amber-400">{{ highWarning }}</p>
        <p class="text-muted-foreground">下次启动：主世界 {{ limitLabel(payload.effective.masterMemoryMb) }} · 洞穴 {{ limitLabel(payload.effective.cavesMemoryMb) }} · 每分片最多等待 {{ payload.effective.shardReadyWaitSec }} 秒。运行中的限额不会自动更改。</p>
        <div class="grid gap-x-4 md:grid-cols-3">
          <NFormItem label="主世界内存上限（MiB）"><NInputNumber v-model:value="draft.masterMemoryMb" :min="0" :precision="0" :disabled="!canWrite || saving" placeholder="留空继承全局" class="w-full" /></NFormItem>
          <NFormItem label="洞穴内存上限（MiB）"><NInputNumber v-model:value="draft.cavesMemoryMb" :min="0" :precision="0" :disabled="!canWrite || saving" placeholder="留空继承全局" class="w-full" /></NFormItem>
          <NFormItem label="每分片启动等待（秒）"><NInputNumber v-model:value="draft.shardReadyWaitSec" :min="1" :precision="0" :disabled="!canWrite || saving" placeholder="留空继承全局" class="w-full" /></NFormItem>
        </div>
        <p class="text-xs text-muted-foreground">留空继承全局；内存填 0 表示不设单片硬限，共享物理预算仍生效，正数至少 6 MiB。双分片依次加载，最长等待约为每分片时间的两倍。</p>
        <p>后端推荐：主世界 {{ payload.recommendation.masterMemoryMb }} MiB，洞穴 {{ payload.recommendation.cavesMemoryMb }} MiB（{{ payload.recommendation.modCount }} 个 Mod；实测峰值：主世界 {{ formatMemoryMb(payload.recommendation.masterPeakMb) }}，洞穴 {{ formatMemoryMb(payload.recommendation.cavesPeakMb) }}）。</p>
        <p class="text-xs text-muted-foreground">依据：取 Mod 估算 {{ payload.recommendation.estimatedMb }} MiB、2048 MiB 基线与实测需求的较大值，预留 20% 后向上取整到 256 MiB；同次 RAM＋swap 需求：主世界 {{ formatMemoryMb(payload.recommendation.masterDemandMb) }}，洞穴 {{ formatMemoryMb(payload.recommendation.cavesDemandMb) }}；测量时间：{{ formatDateTime(payload.recommendation.measuredAt) }}。</p>
        <p v-if="payload.recommendation.masterPeakLimited || payload.recommendation.cavesPeakLimited" class="text-amber-600 dark:text-amber-400">部分峰值受到硬限截断，只能作为需求下界；请结合 swap 与加载状态判断。</p>
        <p v-if="recommendationWarning" role="alert" class="text-amber-600 dark:text-amber-400">{{ recommendationWarning }}</p>
        <div v-if="canWrite" class="flex flex-wrap gap-2">
          <NButton size="small" secondary :disabled="saving" @click="useRecommendation">填入推荐值</NButton>
          <NButton size="small" secondary :disabled="saving" @click="draft = { masterMemoryMb: null, cavesMemoryMb: null, shardReadyWaitSec: null }">恢复继承</NButton>
          <NButton size="small" secondary :disabled="saving || !dirty" @click="draft = { ...payload.config }">撤销修改</NButton>
          <NButton size="small" type="primary" :loading="saving" :disabled="!valid || !dirty" @click="save">保存，下次启动生效</NButton>
        </div>
        <p>宿主机可用内存 {{ formatMemoryMb(payload.host.availableMb) }} / 总计 {{ formatMemoryMb(payload.host.totalMb) }}；swap 可用 {{ formatMemoryMb(payload.host.swapFreeMb) }} / 总计 {{ formatMemoryMb(payload.host.swapTotalMb) }}。</p>
        <div v-if="payload.protection" class="rounded-md border border-border p-3 space-y-2">
          <p>面板整个服务当前 {{ formatMemoryMb(payload.protection.panelCurrentMb) }}，峰值 {{ formatMemoryMb(payload.protection.panelPeakMb) }}；下次配置预算建议预留 {{ payload.protection.reserveMb }} MiB{{ payload.protection.reserveEstimated ? '（面板峰值未知，按 512 MiB 估算）' : '' }}。</p>
          <p>游戏共享物理预算：{{ formatMemoryMb(payload.protection.budget.currentMb) }} / {{ formatMemoryMb(payload.protection.budget.maxMb) }}；指标来源：{{ payload.protection.source === 'unknown' ? '未核验' : payload.protection.source === 'docker-host' ? 'Docker 宿主机' : 'Native 宿主机' }}。</p>
          <p :class="payload.protection.budget.state === 'protected' ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400'">{{ payload.protection.budget.message }}</p>
          <p>共享预算仅在同机游戏全部停止后由 root 调整。运行期间持续严重内存压力或确认 OOM 会停止整个实例，计划任务不会自动重启。</p>
          <NButton size="tiny" secondary @click="copyBudgetCommand">复制共享预算配置命令</NButton>
        </div>
        <div class="rounded-md bg-muted/50 p-3 space-y-2">
          <p class="font-medium">swap：{{ swapLabels[payload.swapAdvice.state] }}</p>
          <p>{{ payload.swapAdvice.message }}</p>
          <template v-if="payload.swapAdvice.command">
            <p class="text-xs text-muted-foreground">停止实例后，在服务器上使用 root 执行：</p>
            <pre class="overflow-x-auto whitespace-pre-wrap break-all text-xs">{{ payload.swapAdvice.command }}</pre>
            <NButton size="tiny" secondary @click="copyCommand">复制命令</NButton>
          </template>
        </div>
      </div>
    </NSpin>
  </NCard>
</template>
