<script setup lang="ts">
import { NAlert, NButton, NCheckbox, NInput, NModal, NProgress } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import type { ModImportInspection } from '../../../../../../shared/contracts/mod'
import apiMod from '@/api/modules/mod'

const props = defineProps<{ show: boolean, instanceId: string, stopped: boolean, existingIds: string[] }>()
const { auth: hasPermission } = useAppAuth()
const emit = defineEmits<{ 'update:show': [value: boolean], imported: [] }>()
const fileInput = ref<HTMLInputElement | null>(null)
const preview = ref<ModImportInspection | null>(null)
const workshopId = ref('')
const overwrite = ref(false)
const busy = ref(false)
const submitting = ref(false)
const percent = ref(0)
const error = ref('')
const fileName = ref('')
const maxBytes = ref(256 * 1024 ** 2)
let controller: AbortController | null = null
let previewInstance = ''
const existing = computed(() => props.existingIds.includes(workshopId.value))
const canCommit = computed(() => !!preview.value && /^[1-9]\d{0,19}$/.test(workshopId.value) && props.stopped && (!existing.value || overwrite.value) && !busy.value && !submitting.value)
const errorMessage = (value: unknown) => value instanceof Error ? value.message : (value as { error?: string })?.error || '操作失败，请重试'

async function discard() {
  const old = preview.value
  preview.value = null
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
  if (!/\.zip$/i.test(file.name)) { error.value = '请选择单个 Mod 的 ZIP 文件'; return }
  if (file.size > maxBytes.value) { error.value = `文件超过上传上限 ${Math.round(maxBytes.value / 1024 ** 2)} MiB`; return }
  await discard()
  busy.value = true
  percent.value = 0
  overwrite.value = false
  fileName.value = file.name
  const upload = new AbortController()
  controller = upload
  previewInstance = props.instanceId
  try {
    const { data } = await apiMod.inspectImport(previewInstance, file, upload.signal, value => percent.value = value)
    if (upload.signal.aborted || !props.show || previewInstance !== props.instanceId) {
      await apiMod.discardImport(previewInstance, data.importId)
      return
    }
    preview.value = data
    workshopId.value = data.workshopId ?? ''
  }
  catch (value) { if (!upload.signal.aborted) error.value = errorMessage(value) }
  finally { busy.value = false }
}
async function commit() {
  if (!canCommit.value || !preview.value) return
  submitting.value = true
  error.value = ''
  try {
    const { data } = await apiMod.commitImport(props.instanceId, { importId: preview.value.importId, workshopId: workshopId.value, overwrite: overwrite.value })
    if (data.riskTip) faToast.warning(data.riskTip)
    preview.value = null
    emit('imported')
    emit('update:show', false)
  }
  catch (value) { error.value = errorMessage(value) }
  finally { submitting.value = false }
}
watch(() => [props.show, props.instanceId] as const, async ([show]) => {
  controller?.abort()
  await discard()
  if (!show) return
  fileName.value = ''
  error.value = ''
  workshopId.value = ''
  overwrite.value = false
  try { maxBytes.value = (await apiMod.getImportLimits(props.instanceId)).data.maxArchiveBytes }
  catch (value) { error.value = errorMessage(value) }
})
</script>

<template>
  <NModal :show="show" preset="card" title="从本地导入 Mod" style="width: min(620px, 94vw)" :mask-closable="!submitting" :close-on-esc="!submitting" @update:show="close">
    <div class="space-y-4">
      <NAlert type="info">一个 ZIP 对应一个 Workshop Mod；导入不访问创意工坊。新增 Mod 默认禁用。</NAlert>
      <input ref="fileInput" type="file" accept=".zip" class="hidden" @change="selectFile">
      <NButton :disabled="busy || submitting" @click="fileInput?.click()">选择 ZIP 文件</NButton>
      <p v-if="fileName" class="break-all text-sm">{{ fileName }}</p>
      <template v-if="busy">
        <NProgress type="line" :percentage="percent" />
        <p>{{ percent === 100 ? '正在分析…' : '正在上传…' }}</p>
      </template>
      <template v-if="preview">
        <p>{{ preview.name ?? '名称未知' }} · {{ preview.version ?? '版本未知' }} · {{ preview.fileCount }} 个文件 · {{ (preview.sizeBytes / 1024 ** 2).toFixed(2) }} MiB</p>
        <NAlert v-for="warning in preview.warnings" :key="warning" type="warning">{{ warning }}</NAlert>
        <p v-if="preview.idCandidates.length" class="text-sm">识别候选：{{ preview.idCandidates.map(item => `${item.workshopId}（${item.source === 'filename' ? '文件名' : '目录'}）`).join('、') }}</p>
        <NInput v-model:value="workshopId" placeholder="确认 Workshop ID（可手动输入）" :disabled="submitting" />
        <NCheckbox v-if="existing" v-model:checked="overwrite" :disabled="submitting">覆盖现有同 ID Mod，保留启用状态、顺序和配置</NCheckbox>
        <NAlert v-if="!stopped" type="warning">可以上传和预览；请先停止实例，再确认安装。</NAlert>
        <p class="text-sm text-muted-foreground">依赖缺失时可在下载队列中手动补齐；本地内容的 Workshop 更新时间为未知。</p>
      </template>
      <NAlert v-if="error" type="error">{{ error }}</NAlert>
      <div class="flex justify-end gap-2">
        <NButton :disabled="submitting" @click="close">取消</NButton>
        <NButton v-if="hasPermission('mod:install')" type="primary" :loading="submitting" :disabled="!canCommit" @click="commit">确认安装</NButton>
      </div>
    </div>
  </NModal>
</template>
