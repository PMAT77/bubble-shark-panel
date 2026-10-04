<script setup lang="ts">
import { NAlert, NButton, NCheckbox, NInput, NModal, NProgress } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import type { ModImportInspection, ModImportItemInspection, ModImportItemResult } from '../../../../../../shared/contracts/mod'
import apiMod from '@/api/modules/mod'
import { validateModImportIds } from '../modImportPresentation'

const props = defineProps<{ show: boolean, instanceId: string, stopped: boolean, existingIds: string[] }>()
const { auth: hasPermission } = useAppAuth()
const emit = defineEmits<{ 'update:show': [value: boolean], imported: [] }>()
const fileInput = ref<HTMLInputElement | null>(null)
const preview = ref<ModImportInspection | null>(null)
const rows = ref<Array<Omit<ModImportItemInspection, 'workshopId'> & { workshopId: string }>>([])
const results = ref<ModImportItemResult[]>([])
const retryBlocked = ref(false)
const overwrite = ref(false)
const busy = ref(false)
const submitting = ref(false)
const percent = ref(0)
const error = ref('')
const fileName = ref('')
const maxBytes = ref(256 * 1024 ** 2)
let controller: AbortController | null = null
let previewInstance = ''
const resultById = computed(() => new Map(results.value.map(item => [item.itemId, item])))
const pendingRows = computed(() => rows.value.filter(item => resultById.value.get(item.itemId)?.status !== 'installed'))
const existingCount = computed(() => pendingRows.value.filter(item => props.existingIds.includes(item.workshopId.trim())).length)
const idErrors = computed(() => validateModImportIds(rows.value, preview.value?.reservedWorkshopIds ?? []))
const summary = computed(() => ({
  installed: results.value.filter(item => item.status === 'installed').length,
  failed: results.value.filter(item => item.status === 'failed').length,
  notProcessed: results.value.filter(item => item.status === 'not_processed').length,
}))
const canCommit = computed(() => hasPermission('mod:install') && !!preview.value && pendingRows.value.length > 0
  && idErrors.value.size === 0 && props.stopped && (!existingCount.value || overwrite.value)
  && !retryBlocked.value && !busy.value && !submitting.value)
const errorMessage = (value: unknown) => value instanceof Error ? value.message : (value as { error?: string })?.error || '操作失败，请重试'

async function discard() {
  const old = preview.value
  preview.value = null
  rows.value = []
  results.value = []
  retryBlocked.value = false
  if (old) await apiMod.discardImport(previewInstance, old.importId).catch(() => {})
}
async function close() {
  if (submitting.value) return
  controller?.abort()
  await discard()
  emit('update:show', false)
}
async function selectFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  error.value = ''
  if (!/\.zip$/i.test(file.name)) { error.value = '请选择 Mod 的 ZIP 文件'; return }
  if (file.size > maxBytes.value) { error.value = `文件超过上传上限 ${Math.round(maxBytes.value / 1024 ** 2)} MiB`; return }
  await discard()
  busy.value = true
  percent.value = 0
  overwrite.value = false
  fileName.value = file.name
  const upload = new AbortController()
  controller = upload
  const uploadInstance = props.instanceId
  previewInstance = uploadInstance
  try {
    const { data } = await apiMod.inspectImport(uploadInstance, file, upload.signal, value => percent.value = value)
    if (upload.signal.aborted || !props.show || uploadInstance !== props.instanceId) {
      await apiMod.discardImport(uploadInstance, data.importId)
      return
    }
    preview.value = data
    rows.value = data.items.map(item => ({ ...item, workshopId: item.workshopId ?? '' }))
  }
  catch (value) { if (!upload.signal.aborted) error.value = errorMessage(value) }
  finally { if (controller === upload) busy.value = false }
}
async function commit() {
  if (!canCommit.value || !preview.value) return
  submitting.value = true
  error.value = ''
  const instanceId = props.instanceId
  try {
    const { data } = await apiMod.commitImport(instanceId, { importId: preview.value.importId,
      items: pendingRows.value.map(item => ({ itemId: item.itemId, workshopId: item.workshopId.trim() })), overwrite: overwrite.value })
    if (!props.show || instanceId !== props.instanceId) return
    results.value = data.results
    retryBlocked.value = data.retryBlocked
    error.value = data.error ?? ''
    if (data.riskTip) faToast.warning(data.riskTip)
    if (!data.summary.remaining) {
      faToast.success(`已导入 ${data.summary.installed} 个 Mod`)
      preview.value = null
      emit('update:show', false)
    }
  }
  catch (value) { error.value = errorMessage(value) }
  finally { submitting.value = false; emit('imported') }
}
watch(() => [props.show, props.instanceId] as const, async ([show]) => {
  controller?.abort()
  busy.value = false
  await discard()
  if (!show) return
  fileName.value = ''
  error.value = ''
  overwrite.value = false
  const instanceId = props.instanceId
  try {
    const limits = await apiMod.getImportLimits(instanceId)
    if (props.show && instanceId === props.instanceId) maxBytes.value = limits.data.maxArchiveBytes
  }
  catch (value) { error.value = errorMessage(value) }
})
</script>

<template>
  <NModal :show="show" preset="card" title="从本地导入 Mod" style="width: min(760px, 94vw)" :mask-closable="!submitting" :close-on-esc="!submitting" @update:show="close">
    <div class="max-h-[calc(100dvh-160px)] flex flex-col gap-3">
      <p v-if="results.length" role="status">已安装 {{ summary.installed }} 个 · 失败 {{ summary.failed }} 个<span v-if="summary.notProcessed"> · 未处理 {{ summary.notProcessed }} 个</span>。成功项已保留。</p>
      <div class="min-h-0 flex-1 overflow-y-auto space-y-3">
        <NAlert type="info">一个ZIP可包含多个Mod，新增 Mod 默认禁用。</NAlert>
        <input ref="fileInput" type="file" accept=".zip" class="hidden" @change="selectFile">
        <NButton :disabled="busy || submitting" @click="fileInput?.click()">选择 ZIP 文件</NButton>
        <p v-if="fileName" class="break-all text-sm">{{ fileName }}</p>
        <template v-if="busy">
          <NProgress type="line" :percentage="percent" />
          <p>{{ percent === 100 ? '正在分析…' : '正在上传…' }}</p>
        </template>
        <template v-if="preview">
          <p>{{ rows.length }} 个 Mod · {{ preview.fileCount }} 个文件 · {{ (preview.sizeBytes / 1024 ** 2).toFixed(2) }} MiB</p>
          <NAlert v-for="warning in preview.warnings.filter(value => !rows.some(item => item.warnings.includes(value)))" :key="warning" type="warning">{{ warning }}</NAlert>
          <div class="space-y-2">
            <article v-for="item in rows" :key="item.itemId" class="border border-border rounded p-3 space-y-2">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <span class="min-w-0 break-words font-medium">{{ item.name ?? '名称未知' }}</span>
                <span class="text-sm">{{ resultById.get(item.itemId)?.status === 'installed' ? '已安装'
                  : resultById.get(item.itemId)?.status === 'failed' ? '安装失败'
                    : resultById.get(item.itemId)?.status === 'not_processed' ? '未处理'
                      : props.existingIds.includes(item.workshopId.trim()) ? '覆盖已有 Mod' : '新增 Mod（默认禁用）' }}</span>
              </div>
              <p class="break-all text-xs text-muted-foreground">{{ item.directory === '.' ? 'ZIP 根目录' : item.directory }} · {{ item.version ?? '版本未知' }} · {{ item.fileCount }} 个文件</p>
              <NInput v-model:value="item.workshopId" placeholder="填写 Workshop ID" :input-props="{ 'aria-label': `Workshop ID：${item.name ?? item.directory}`,
                'aria-invalid': idErrors.has(item.itemId), 'aria-describedby': idErrors.has(item.itemId) ? `mod-import-error-${item.itemId}` : undefined }"
                :status="idErrors.has(item.itemId) ? 'error' : undefined" :disabled="submitting || resultById.get(item.itemId)?.status === 'installed'" />
              <p v-if="idErrors.has(item.itemId)" :id="`mod-import-error-${item.itemId}`" class="text-sm text-red-500">{{ idErrors.get(item.itemId) }}</p>
              <p v-if="resultById.get(item.itemId)?.error" class="break-words text-sm">{{ resultById.get(item.itemId)?.error }}</p>
              <details v-if="item.warnings.length || item.idCandidates.length > 1" class="text-sm">
                <summary class="cursor-pointer">更多信息</summary>
                <p v-if="item.idCandidates.length > 1">ID 候选：{{ item.idCandidates.map(value => `${value.workshopId}（${value.source === 'filename' ? '文件名' : '目录'}）`).join('、') }}</p>
                <p v-for="warning in item.warnings" :key="warning">{{ warning }}</p>
              </details>
            </article>
          </div>
          <p class="text-sm text-muted-foreground">依赖缺失时可在下载队列中手动补齐；本地内容的 Workshop 更新时间为未知。</p>
        </template>
      </div>
      <NCheckbox v-if="preview && existingCount" v-model:checked="overwrite" :disabled="submitting">覆盖已有 Mod（{{ existingCount }} 个），保留启用状态、配置和顺序</NCheckbox>
      <NAlert v-if="preview && !stopped" type="warning">可以上传和预览；请先停止实例，再确认安装。</NAlert>
      <NAlert v-if="error" type="error" class="max-h-32 overflow-y-auto">{{ error }}</NAlert>
      <div class="flex justify-end gap-2">
        <NButton :disabled="submitting" @click="close">{{ results.length ? '关闭' : '取消' }}</NButton>
        <NButton v-if="hasPermission('mod:install')" type="primary" :loading="submitting" :disabled="!canCommit" @click="commit">{{ results.length ? '重试失败项' : '确认安装' }}</NButton>
      </div>
    </div>
  </NModal>
</template>
