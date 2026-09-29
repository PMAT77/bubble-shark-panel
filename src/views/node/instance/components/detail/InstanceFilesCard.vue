<script setup lang="ts">
import type { InstanceFileEntry, InstanceKeyFile } from '@/api/modules/instanceFile'
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NInput,
  NModal,
  NSpin,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui'
import { computed, ref, watch } from 'vue'
import apiInstanceFile, { isEditableInstanceFilePath } from '@/api/modules/instanceFile'

const props = defineProps<{
  instanceId: string
}>()

defineOptions({
  name: 'InstanceFilesCard',
})

const dialog = useDialog()
const message = useMessage()

/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()

const currentPath = ref('')
const entries = ref<InstanceFileEntry[]>([])
const keyFiles = ref<InstanceKeyFile[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const busy = ref(false)

const editorVisible = ref(false)
const editorPath = ref('')
const editorContent = ref('')
const editorTruncated = ref(false)
const editorSizeBytes = ref(0)

const renameVisible = ref(false)
const renameTarget = ref<InstanceFileEntry | null>(null)
const renameValue = ref('')

const uploadInputRef = ref<HTMLInputElement | null>(null)
const uploading = ref(false)
const uploadPercent = ref(0)

const breadcrumbs = computed(() => {
  const segments = currentPath.value.split('/').filter(Boolean)
  const items = [{ label: '实例目录', path: '' }]
  let accumulated = ''
  for (const segment of segments) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment
    items.push({ label: segment, path: accumulated })
  }
  return items
})

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function formatTime(value: string): string {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}

function canEdit(entry: InstanceFileEntry): boolean {
  return entry.type === 'file' && !entry.protected && isEditableInstanceFilePath(entry.name)
}

async function loadKeyFiles() {
  if (!props.instanceId) {
    return
  }
  try {
    const { data } = await apiInstanceFile.listKeyFiles(props.instanceId)
    keyFiles.value = data.files.filter(item => item.exists)
  }
  catch {
    keyFiles.value = []
  }
}

async function loadEntries(path = currentPath.value) {
  if (!props.instanceId) {
    return
  }
  loading.value = true
  loadError.value = null
  try {
    const { data } = await apiInstanceFile.listFiles(props.instanceId, path)
    currentPath.value = data.path
    entries.value = data.entries
  }
  catch {
    loadError.value = '读取目录失败，请确认实例已安装后重试。'
    entries.value = []
  }
  finally {
    loading.value = false
  }
}

/** 按相对路径直接打开编辑器：关键文件入口与目录里点文件走同一条路径 */
async function openFileByPath(filePath: string) {
  busy.value = true
  try {
    const { data } = await apiInstanceFile.readFile(props.instanceId, filePath)
    editorPath.value = data.path
    editorContent.value = data.content
    editorTruncated.value = data.truncated
    editorSizeBytes.value = data.sizeBytes
    editorVisible.value = true
  }
  catch {
    message.error('读取文件失败：文件可能已被移除或不属于可编辑类型。')
  }
  finally {
    busy.value = false
  }
}

async function openEntry(entry: InstanceFileEntry) {
  if (entry.type === 'directory') {
    await loadEntries(entry.path)
    return
  }
  if (entry.protected) {
    message.warning('该文件包含敏感信息（如集群令牌），面板不提供查看与编辑。')
    return
  }
  if (!canEdit(entry)) {
    message.warning('该文件类型不支持在面板中编辑。')
    return
  }
  await openFileByPath(entry.path)
}

async function saveEditor() {
  if (busy.value) {
    return
  }
  busy.value = true
  try {
    const { data } = await apiInstanceFile.writeFile({
      instanceId: props.instanceId,
      path: editorPath.value,
      content: editorContent.value,
    })
    message.success(`已保存 ${data.path}（${formatSize(data.sizeBytes)}），旧内容已备份`)
    editorVisible.value = false
    await Promise.all([loadEntries(), loadKeyFiles()])
  }
  catch {
    message.error('保存失败：文件类型、大小或路径不在允许范围内。')
  }
  finally {
    busy.value = false
  }
}

function openUploadPicker() {
  if (uploading.value) {
    return
  }
  uploadInputRef.value?.click()
}

async function handleUploadFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !props.instanceId) {
    return
  }
  uploading.value = true
  uploadPercent.value = 0
  try {
    const { data } = await apiInstanceFile.uploadFile({
      instanceId: props.instanceId,
      dirPath: currentPath.value,
      file,
      overwrite: true,
    }, percent => {
      uploadPercent.value = percent
    })
    message.success(`已上传 ${data.path}（${formatSize(data.sizeBytes)}）${data.overwritten ? '，原文件已备份' : ''}`)
    await Promise.all([loadEntries(), loadKeyFiles()])
  }
  catch {
    message.error('上传失败：文件名不合法、超出大小上限，或目标不可写。')
  }
  finally {
    uploading.value = false
    uploadPercent.value = 0
  }
}

async function downloadEntry(entry: InstanceFileEntry) {
  if (busy.value) {
    return
  }
  busy.value = true
  try {
    const { data } = await apiInstanceFile.downloadFile(props.instanceId, entry.path)
    const url = URL.createObjectURL(data)
    const link = document.createElement('a')
    link.href = url
    link.download = entry.name
    link.click()
    URL.revokeObjectURL(url)
  }
  catch {
    message.error('下载失败：文件可能已被移动或属于敏感文件。')
  }
  finally {
    busy.value = false
  }
}

function confirmDelete(entry: InstanceFileEntry) {
  dialog.warning({
    title: `确认删除 ${entry.name}？`,
    content: entry.type === 'directory'
      ? '该目录及其全部内容都会被删除，且不会进入面板备份。'
      : '该文件会被删除且不会进入面板备份，操作不可撤销。',
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await apiInstanceFile.deletePath({ instanceId: props.instanceId, path: entry.path })
        message.success(`已删除 ${entry.name}`)
        await loadEntries()
      }
      catch {
        message.error('删除失败：该路径不在允许范围内或已被占用。')
      }
    },
  })
}

function openRename(entry: InstanceFileEntry) {
  renameTarget.value = entry
  renameValue.value = entry.name
  renameVisible.value = true
}

async function submitRename() {
  const target = renameTarget.value
  const nextName = renameValue.value.trim()
  if (!target || !nextName || busy.value) {
    return
  }
  busy.value = true
  try {
    await apiInstanceFile.renamePath({
      instanceId: props.instanceId,
      path: target.path,
      newName: nextName,
    })
    renameVisible.value = false
    message.success('已重命名')
    await loadEntries()
  }
  catch {
    message.error('重命名失败：新名称不合法或同名文件已存在。')
  }
  finally {
    busy.value = false
  }
}

watch(() => props.instanceId, () => {
  currentPath.value = ''
  void loadKeyFiles()
  void loadEntries('')
}, { immediate: true })
</script>

<template>
  <NCard title="文件管理" size="small" class="mt-4">
    <template #header-extra>
      <NButton size="tiny" :loading="loading" @click="loadEntries()">
        刷新
      </NButton>
    </template>

    <p class="mb-3 text-xs text-muted-foreground">
      浏览实例目录并直接编辑文本配置（房间、世界、Mod 等）。保存会先备份原文件；
      集群令牌等敏感文件不提供查看与编辑。上传会把文件放进当前所在目录，同名文件会先备份再覆盖。
    </p>

    <div v-if="keyFiles.length > 0" class="mb-4 rounded-lg border p-3">
      <p class="mb-2 text-sm font-medium">
        关键配置文件
      </p>
      <p class="mb-2 text-xs text-muted-foreground">
        房间页、世界页与 Mod 页已覆盖常用项；这里用于直接改原始文件。
      </p>
      <div class="flex flex-wrap gap-2">
        <NButton
          v-for="item in keyFiles"
          :key="item.path"
          size="tiny"
          :disabled="busy"
          :title="item.description"
          @click="openFileByPath(item.path)"
        >
          {{ item.label }}
        </NButton>
      </div>
    </div>

    <div class="mb-3 flex flex-wrap items-center gap-1 text-sm">
      <template v-for="(item, index) in breadcrumbs" :key="item.path">
        <span v-if="index > 0" class="text-muted-foreground">/</span>
        <NButton
          text
          size="tiny"
          :disabled="index === breadcrumbs.length - 1"
          @click="loadEntries(item.path)"
        >
          {{ item.label }}
        </NButton>
      </template>
      <span class="grow" />
      <NButton size="tiny" :loading="uploading" @click="openUploadPicker" v-if="hasPermission('file:upload')">
        上传到当前目录
      </NButton>
      <span v-if="uploading" class="text-xs text-muted-foreground">已上传 {{ uploadPercent }}%</span>
      <input
        ref="uploadInputRef"
        type="file"
        class="hidden"
        @change="handleUploadFile"
      >
    </div>

    <NSpin :show="loading">
      <p v-if="loadError" class="text-sm text-rose-600 dark:text-rose-400">{{ loadError }}</p>
      <NEmpty v-else-if="entries.length === 0" size="small" description="空目录" />
      <ul v-else class="flex flex-col gap-1">
        <li
          v-for="entry in entries"
          :key="entry.path"
          class="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-1.5"
        >
          <div class="flex min-w-0 items-center gap-2">
            <FaIcon
              :name="entry.type === 'directory' ? 'i-lucide:folder' : 'i-lucide:file-text'"
              class="size-4 shrink-0 text-muted-foreground"
            />
            <button
              type="button"
              class="truncate text-left text-sm hover:underline"
              @click="openEntry(entry)"
            >
              {{ entry.name }}
            </button>
            <NTag v-if="entry.protected" size="tiny" :bordered="false" type="warning">
              敏感
            </NTag>
          </div>
          <div class="flex items-center gap-3 text-xs text-muted-foreground">
            <span v-if="entry.type === 'file'">{{ formatSize(entry.sizeBytes) }}</span>
            <span>{{ formatTime(entry.modifiedAt) }}</span>
            <NButton
              v-if="entry.type === 'file' && !entry.protected"
              text
              size="tiny"
              :disabled="!canEdit(entry)"
              @click="openEntry(entry)"
            >
              {{ hasPermission('file:write') ? '编辑' : '查看' }}
            </NButton>
            <NButton
              v-if="entry.type === 'file' && !entry.protected && hasPermission('file:download')"
              text
              size="tiny"
              :disabled="busy"
              @click="downloadEntry(entry)"
            >
              下载
            </NButton>
            <NButton
              v-if="!entry.protected && hasPermission('file:write')"
              text
              size="tiny"
              @click="openRename(entry)"
            >
              重命名
            </NButton>
            <NButton
              v-if="!entry.protected && hasPermission('file:delete')"
              text
              size="tiny"
              type="error"
              @click="confirmDelete(entry)"
            >
              删除
            </NButton>
          </div>
        </li>
      </ul>
    </NSpin>

    <NModal v-model:show="editorVisible" preset="card" :title="editorPath" class="max-w-3xl">
      <NAlert v-if="editorTruncated" type="warning" :bordered="false" class="mb-3">
        文件较大（{{ formatSize(editorSizeBytes) }}），这里只显示前 1 MiB 内容；直接保存会截断文件，请先自行备份。
      </NAlert>
      <NInput
        v-model:value="editorContent"
        type="textarea"
        :autosize="{ minRows: 12, maxRows: 24 }"
      />
      <template #footer>
        <div class="flex justify-end gap-2">
          <NButton @click="editorVisible = false">
            取消
          </NButton>
          <NButton type="primary" :loading="busy" @click="saveEditor" v-if="hasPermission('file:write')">
            保存
          </NButton>
        </div>
      </template>
    </NModal>

    <NModal v-model:show="renameVisible" preset="card" title="重命名" class="max-w-md">
      <NInput v-model:value="renameValue" @keyup.enter="submitRename" />
      <template #footer>
        <div class="flex justify-end gap-2">
          <NButton @click="renameVisible = false">
            取消
          </NButton>
          <NButton type="primary" :loading="busy" @click="submitRename" v-if="hasPermission('file:write')">
            确定
          </NButton>
        </div>
      </template>
    </NModal>
  </NCard>
</template>
