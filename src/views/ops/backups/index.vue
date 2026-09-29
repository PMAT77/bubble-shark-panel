<script setup lang="ts">
/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()

import type { DataTableColumns, SelectOption } from 'naive-ui'
import type { BackupItem } from '@/api/modules/backup'
import type { InstanceSummaryItem } from '@/api/modules/instance'
import { NAlert, NButton, NDataTable, NEmpty, NInput, NModal, NSpace, NSelect, NTag, NTooltip, useDialog } from 'naive-ui'
import { computed, h, onActivated, onMounted, ref } from 'vue'
import apiBackup, { DB_SNAPSHOT_RESTORE_CONFIRM_TEXT } from '@/api/modules/backup'
import apiInstance from '@/api/modules/instance'
import { resolveApiBaseUrl, withTrailingSlash } from '@/api/base-url'
import { useAdminPageState } from '@/composables/useAdminPageState'
import SaveImportModal from './components/SaveImportModal.vue'
import { describeDownloadProgress, formatSize } from './downloadProgress'

defineOptions({
  name: 'OpsBackups',
})

const dialog = useDialog()
const route = useRoute()

const rows = ref<BackupItem[]>([])
const instances = ref<InstanceSummaryItem[]>([])
const dbRows = ref<BackupItem[]>([])
const selectedInstanceId = ref<string | null>(null)

const {
  loading,
  error,
  showError,
  runLoad,
} = useAdminPageState(rows)

/**
 * 面板数据库快照（instanceId 为哨兵值 'panel-db'）不属于任何游戏实例，
 * 不会被上面的实例存档列表带出来，因此单独持有数据与加载/错误状态。
 */
const {
  loading: dbLoading,
  error: dbError,
  showError: showDbError,
  runLoad: runDbLoad,
} = useAdminPageState(dbRows)

const kindMeta: Record<BackupItem['kind'], { label: string, type: 'default' | 'info' | 'warning' | 'error' | 'success' }> = {
  manual: { label: '手动', type: 'info' },
  scheduled: { label: '计划', type: 'default' },
  pre_update: { label: '更新前', type: 'warning' },
  pre_delete: { label: '删除前', type: 'warning' },
  pre_restore: { label: '恢复前', type: 'default' },
  pre_import: { label: '导入前', type: 'warning' },
  pre_rollback: { label: '回档前', type: 'warning' },
  pre_reset: { label: '重置前', type: 'warning' },
  database: { label: '面板快照', type: 'success' },
}

const statusMeta: Record<BackupItem['status'], { label: string, type: 'default' | 'info' | 'warning' | 'error' | 'success' }> = {
  completed: { label: '可用', type: 'success' },
  failed: { label: '失败', type: 'error' },
  stale: { label: '文件丢失', type: 'error' },
}

function formatTime(iso: string): string {
  return iso ? iso.replace('T', ' ').slice(0, 19) : '—'
}

/**
 * 创建者展示：正常为登录账号；计划任务由调度器自动执行、没有账号，
 * 因此后端写入固定标识 'scheduler'（server 端 SCHEDULED_OPERATOR），此处显示为中文。
 */
function formatCreator(createdBy: string): string {
  if (!createdBy) {
    return '—'
  }
  return createdBy === 'scheduler' ? '计划任务' : createdBy
}

function instanceName(instanceId: string): string {
  if (instanceId === 'panel-db') {
    return '面板'
  }
  return instances.value.find(item => item.id === instanceId)?.name ?? instanceId
}

const instanceOptions = computed<SelectOption[]>(() => {
  return instances.value.map(item => ({
    label: item.name,
    value: item.id,
  }))
})

function loadDbBackups() {
  runDbLoad(async () => {
    const response = await apiBackup.getDbBackupList()
    dbRows.value = response.data ?? []
  })
}

// 「刷新」与「创建面板数据库快照」都走这里，因此两个列表区块会一起刷新。
function triggerLoad() {
  runLoad(async () => {
    const [backupResponse, instanceResponse] = await Promise.all([
      apiBackup.getBackupList(selectedInstanceId.value ?? undefined),
      apiInstance.getInstanceOptions().catch(() => ({ data: [] as InstanceSummaryItem[] })),
    ])
    rows.value = backupResponse.data ?? []
    instances.value = instanceResponse.data ?? []
  })
  loadDbBackups()
}

/**
 * 消费 ?instanceId=：实例详情页的「查看本实例的备份」跳过来时预选该实例。
 * 返回是否真的换了实例，调用方据此决定要不要重新拉列表。
 */
function applyInstanceFromQuery(): boolean {
  const value = typeof route.query.instanceId === 'string' ? route.query.instanceId.trim() : ''
  if (!value || value === selectedInstanceId.value) {
    return false
  }
  selectedInstanceId.value = value
  return true
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 立刻回收会让浏览器在大文件真正开始写盘前丢掉数据源，延后释放
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** 正在下载的备份 id：非空即表示已有一次下载在途 */
const downloadingBackupId = ref<string | null>(null)

/** 进度事件每个 chunk 都触发，按 1 MB 粒度刷新同一条提示，避免高频重渲染 */
const DOWNLOAD_PROGRESS_STEP_BYTES = 1024 * 1024

/**
 * 下载备份包。
 *
 * 备份包要等整个响应体收完才开始保存到本地，大包耗时以分钟计；此前既没有「下载中」
 * 状态也不阻止重复点击，表现为「点了没反应，点几下过一会又重复下载」——
 * 每次点击都是一次独立请求，各自完成时再各触发一次浏览器下载。
 */
async function handleDownload(row: BackupItem) {
  if (downloadingBackupId.value) {
    return
  }
  downloadingBackupId.value = row.id
  const pendingToastId = faToast.loading('正在读取备份包，请稍候…', {
    description: describeDownloadProgress(0, row.sizeBytes),
  })
  let shownBytes = 0
  try {
    const response = await apiBackup.downloadBackup({ backupId: row.id }, (loadedBytes) => {
      if (loadedBytes - shownBytes < DOWNLOAD_PROGRESS_STEP_BYTES) {
        return
      }
      shownBytes = loadedBytes
      faToast.loading('正在读取备份包，请稍候…', {
        id: pendingToastId,
        description: describeDownloadProgress(loadedBytes, row.sizeBytes),
      })
    })
    saveBlob(response.data, row.fileName)
    faToast.success('备份已开始下载', { id: pendingToastId })
  }
  catch {
    // 失败原因由请求层统一提示（含后端给的中文原因），这里只收起进度提示，不再叠一条
    faToast.dismiss(pendingToastId)
  }
  finally {
    downloadingBackupId.value = null
  }
}

const createDialogVisible = ref(false)
const createDialogNote = ref('')
const importModalVisible = ref(false)
/** 打包存档可能要几十秒：提交期间按钮转圈，并挂一条常驻提示，避免点完像没反应 */
const creatingBackup = ref(false)

function openCreateBackupDialog() {
  if (!selectedInstanceId.value || selectedInstanceId.value === 'panel-db') {
    faToast.info('请先在上方选择要备份的实例')
    return
  }
  createDialogNote.value = ''
  createDialogVisible.value = true
}

async function submitCreateBackup() {
  const instanceId = selectedInstanceId.value
  if (!instanceId || creatingBackup.value) {
    return
  }
  createDialogVisible.value = false
  creatingBackup.value = true
  // 同一条 toast 先报「正在进行」、完成后再原地换成结果，中途始终有反馈
  const pendingToastId = faToast.loading('正在备份存档，请稍候…')
  try {
    await apiBackup.createBackup(instanceId, createDialogNote.value)
    faToast.success('备份创建成功', { id: pendingToastId })
    triggerLoad()
  }
  catch (err) {
    const message = err instanceof Error ? err.message : '备份创建失败'
    faToast.error(message, { id: pendingToastId })
  }
  finally {
    creatingBackup.value = false
  }
}

function handleCreateDbBackup() {
  dialog.warning({
    title: '创建面板数据库快照',
    content: '将为面板自身数据库生成一致性快照，不含游戏存档。期间请勿关闭面板。',
    positiveText: '开始创建',
    negativeText: '取消',
    onPositiveClick: async () => {
      // 快照同样要等一会儿：先给进行中的提示，完成后再换成结果
      const pendingToastId = faToast.loading('正在创建面板数据库快照，请稍候…')
      try {
        await apiBackup.createDbBackup()
        faToast.success('面板快照已创建', { id: pendingToastId })
        triggerLoad()
      }
      catch (err) {
        const message = err instanceof Error ? err.message : '面板快照创建失败'
        faToast.error(message, { id: pendingToastId })
      }
    },
  })
}

/* ------------------------------ 导入外部快照 ------------------------------ */

const importingSnapshot = ref(false)
const uploadPercent = ref(0)
const snapshotInputRef = ref<HTMLInputElement | null>(null)

function openSnapshotPicker() {
  if (importingSnapshot.value) {
    return
  }
  snapshotInputRef.value?.click()
}

/** 上传本地 .sqlite 快照：只入库，是否恢复由用户在列表里另行确认 */
async function handleSnapshotFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) {
    return
  }
  importingSnapshot.value = true
  uploadPercent.value = 0
  const pendingToastId = faToast.loading('正在上传快照，请稍候…')
  try {
    await apiBackup.uploadDbSnapshot(file, (percent) => {
      uploadPercent.value = percent
    })
    faToast.success('快照已导入，可在列表中恢复', { id: pendingToastId })
    triggerLoad()
  }
  catch (err) {
    const message = err instanceof Error ? err.message : '快照导入失败'
    faToast.error(message, { id: pendingToastId })
  }
  finally {
    importingSnapshot.value = false
    uploadPercent.value = 0
  }
}

/* --------------------------- 用快照恢复面板数据 --------------------------- */

/**
 * 恢复后面板会替换数据库并退出进程，请求多半以连接中断收场——那不是失败。
 * 因此提交之后一律进入 /health 轮询：必须**先看到面板断开、再看到它回来**才算成功，
 * 否则面板还没退出时的那次探测会被误判成「已经恢复」。
 */
const restoreDialogVisible = ref(false)
const restoreTarget = ref<BackupItem | null>(null)
const restoreConfirmText = ref('')
const restoreSubmitting = ref(false)

const RESTORE_HEALTH_INTERVAL_MS = 3000
/** 6 分钟：容器/服务重启通常几秒，留足余量给慢机器 */
const RESTORE_HEALTH_MAX_FAILURES = 120

let restoreSawPanelDown = false
let restoreHealthFailures = 0

async function probePanelHealth(): Promise<boolean> {
  const baseUrl = resolveApiBaseUrl({
    dev: import.meta.env.DEV,
    proxyEnabled: import.meta.env.VITE_ENABLE_PROXY,
    configured: import.meta.env.VITE_APP_API_BASEURL,
  })
  try {
    const response = await fetch(`${withTrailingSlash(baseUrl)}health`, { cache: 'no-store' })
    return response.ok
  }
  catch {
    return false
  }
}

const restoreHealthPoller = usePollingTask(async () => {
  const reachable = await probePanelHealth()
  if (!reachable) {
    restoreSawPanelDown = true
    restoreHealthFailures += 1
    if (restoreHealthFailures >= RESTORE_HEALTH_MAX_FAILURES) {
      restoreHealthPoller.stop()
      faToast.warning('等待面板重启超时，请刷新页面查看结果（开发环境需要手动重启面板）。')
    }
    return
  }
  if (!restoreSawPanelDown) {
    return
  }
  restoreHealthPoller.stop()
  faToast.success('面板数据已恢复，正在重新加载…')
  window.setTimeout(() => window.location.reload(), 1500)
}, { intervalMs: RESTORE_HEALTH_INTERVAL_MS, immediate: false })

function openRestoreDialog(row: BackupItem) {
  restoreTarget.value = row
  restoreConfirmText.value = ''
  restoreDialogVisible.value = true
}

async function submitRestore() {
  const target = restoreTarget.value
  if (!target || restoreSubmitting.value) {
    return
  }
  if (restoreConfirmText.value.trim() !== DB_SNAPSHOT_RESTORE_CONFIRM_TEXT) {
    faToast.warning(`请手工输入「${DB_SNAPSHOT_RESTORE_CONFIRM_TEXT}」以确认`)
    return
  }
  restoreDialogVisible.value = false
  restoreSubmitting.value = true
  const pendingToastId = faToast.loading('正在恢复面板数据，请稍候…', { duration: 0 })
  try {
    await apiBackup.restoreDbSnapshot(target.id, DB_SNAPSHOT_RESTORE_CONFIRM_TEXT)
  }
  catch {
    // 面板正在替换数据库并退出，连接中断是预期结果；成败交给 /health 轮询判定
  }
  faToast.dismiss(pendingToastId)
  restoreSawPanelDown = false
  restoreHealthFailures = 0
  faToast.info('面板正在重启，恢复完成后本页会自动刷新。')
  restoreHealthPoller.start()
  restoreSubmitting.value = false
}

function handleRestore(row: BackupItem) {
  dialog.error({
    title: '确认恢复存档',
    content: `将把实例「${instanceName(row.instanceId)}」的存档回滚到 ${formatTime(row.createdAt)} 的备份点。恢复前会自动创建一份安全备份。请先停止实例，运行中无法恢复。`,
    positiveText: '确认恢复',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const response = await apiBackup.restoreBackup(row.id)
        const safetyId = response.data.safetyBackupId
        faToast.success(safetyId ? '恢复完成（已自动创建恢复前安全备份）' : '恢复完成，可启动实例验证世界状态')
        triggerLoad()
      }
      catch (err) {
        const message = err instanceof Error ? err.message : '恢复失败'
        faToast.error(message)
      }
    },
  })
}

function handleDelete(row: BackupItem) {
  dialog.warning({
    title: '确认删除备份',
    content: `将删除备份「${row.fileName}」及其文件，删除后不可恢复。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await apiBackup.deleteBackup(row.id)
        faToast.success('备份已删除')
        triggerLoad()
      }
      catch (err) {
        const message = err instanceof Error ? err.message : '删除失败'
        faToast.error(message)
      }
    },
  })
}

const columns = computed<DataTableColumns<BackupItem>>(() => [
  {
    title: '备份文件',
    key: 'fileName',
    minWidth: 220,
    ellipsis: { tooltip: true },
  },
  {
    title: '实例',
    key: 'instanceId',
    width: 140,
    ellipsis: { tooltip: true },
    render: row => instanceName(row.instanceId),
  },
  {
    title: '类型',
    key: 'kind',
    width: 110,
    render: row => h(
      NTag,
      { size: 'small', bordered: false, type: kindMeta[row.kind].type },
      { default: () => kindMeta[row.kind].label },
    ),
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: row => h(
      NTag,
      { size: 'small', bordered: false, type: statusMeta[row.status].type },
      { default: () => statusMeta[row.status].label },
    ),
  },
  {
    title: '大小',
    key: 'sizeBytes',
    width: 100,
    align: 'right',
    render: row => formatSize(row.sizeBytes),
  },
  {
    title: '备注',
    key: 'note',
    minWidth: 160,
    ellipsis: { tooltip: true },
    render: row => row.note || '—',
  },
  {
    title: '创建者',
    key: 'createdBy',
    width: 120,
    render: row => formatCreator(row.createdBy),
  },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 180,
    render: row => formatTime(row.createdAt),
  },
  {
    title: '操作',
    key: 'actions',
    width: 190,
    render: (row) => {
      const buttons = []
      // 下载是只读动作，服务端按 backup:read 把关（权限点清单里没有 backup:download）
      if (row.status === 'completed' && hasPermission('backup:read')) {
        // 一次只下一个包：并发下载会互相抢磁盘与带宽，也更容易触发浏览器的多文件下载拦截
        buttons.push(h(NButton, {
          size: 'small',
          quaternary: true,
          type: 'primary',
          loading: downloadingBackupId.value === row.id,
          disabled: downloadingBackupId.value !== null && downloadingBackupId.value !== row.id,
          onClick: () => handleDownload(row),
        }, { default: () => '下载' }))
      }
      if (row.kind !== 'database' && row.status === 'completed' && hasPermission('backup:restore')) {
        buttons.push(h(NTooltip, { trigger: 'hover' }, {
          trigger: () => h(NButton, {
            size: 'small',
            quaternary: true,
            type: 'warning',
            onClick: () => handleRestore(row),
          }, { default: () => '恢复' }),
          default: () => '回滚该实例存档到此备份点（实例须已停止）',
        }))
      }
      if (hasPermission('backup:delete')) {
        buttons.push(h(NButton, {
          size: 'small',
          quaternary: true,
          type: 'error',
          onClick: () => handleDelete(row),
        }, { default: () => '删除' }))
      }
      return h('div', { style: 'display:flex;gap:4px' }, buttons)
    },
  },
])

const dbColumns = computed<DataTableColumns<BackupItem>>(() => [
  {
    title: '快照文件',
    key: 'fileName',
    minWidth: 260,
    ellipsis: { tooltip: true },
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
    render: row => h(
      NTag,
      { size: 'small', bordered: false, type: statusMeta[row.status].type },
      { default: () => statusMeta[row.status].label },
    ),
  },
  {
    title: '大小',
    key: 'sizeBytes',
    width: 100,
    align: 'right',
    render: row => formatSize(row.sizeBytes),
  },
  {
    title: '备注',
    key: 'note',
    minWidth: 180,
    ellipsis: { tooltip: true },
    render: row => row.note || '—',
  },
  {
    title: '创建者',
    key: 'createdBy',
    width: 120,
    render: row => formatCreator(row.createdBy),
  },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 180,
    render: row => formatTime(row.createdAt),
  },
  {
    title: '操作',
    key: 'actions',
    width: 190,
    render: (row) => {
      const buttons = []
      // 下载是只读动作，服务端按 backup:read 把关（权限点清单里没有 backup:download）
      if (row.status === 'completed' && hasPermission('backup:read')) {
        buttons.push(h(NButton, {
          size: 'small',
          quaternary: true,
          type: 'primary',
          loading: downloadingBackupId.value === row.id,
          disabled: downloadingBackupId.value !== null && downloadingBackupId.value !== row.id,
          onClick: () => handleDownload(row),
        }, { default: () => '下载' }))
      }
      if (row.status === 'completed' && hasPermission('backup:restore')) {
        buttons.push(h(NTooltip, { trigger: 'hover' }, {
          trigger: () => h(NButton, {
            size: 'small',
            quaternary: true,
            type: 'warning',
            onClick: () => openRestoreDialog(row),
          }, { default: () => '恢复' }),
          default: () => '用该快照替换面板数据（面板会重启，当前登录会失效）',
        }))
      }
      if (hasPermission('backup:delete')) {
        buttons.push(h(NButton, {
          size: 'small',
          quaternary: true,
          type: 'error',
          onClick: () => handleDelete(row),
        }, { default: () => '删除' }))
      }
      return h('div', { style: 'display:flex;gap:4px' }, buttons)
    },
  },
])

onMounted(() => {
  applyInstanceFromQuery()
  triggerLoad()
})

// 本页被 keepAlive 缓存：再次从实例详情跳进来时组件不会重新挂载，只能在激活时消费预选参数
onActivated(() => {
  if (applyInstanceFromQuery()) {
    triggerLoad()
  }
})
</script>

<template>
  <FaPageMain main-class="flex flex-col gap-4">
    <div>
      <h2 class="m-0 text-lg font-semibold">
        备份与恢复
      </h2>
      <p class="mt-1 text-sm text-muted-foreground">
        备份实例存档与面板数据，可恢复、下载与清理旧备份。 恢复会整体替换实例存档，请先停止实例。 
      </p>
    </div>

    <NSpace :size="8" align="center" class="flex-wrap">
      <NSelect
        v-model:value="selectedInstanceId"
        :options="instanceOptions"
        placeholder="全部实例"
        clearable
        filterable
        style="width: 220px"
        @update:value="triggerLoad"
      />
      <NButton
        type="primary"
        strong
        secondary
        :loading="creatingBackup"
        :disabled="!selectedInstanceId || selectedInstanceId === 'panel-db'"
        @click="openCreateBackupDialog"
       v-if="hasPermission('backup:create')">
        创建存档备份
      </NButton>
      <NButton
        type="warning"
        strong
        secondary
        :disabled="!selectedInstanceId || selectedInstanceId === 'panel-db'"
        @click="importModalVisible = true"
        v-if="hasPermission('backup:import')"
      >
        导入外部存档
      </NButton>
      <NButton :loading="loading" @click="triggerLoad">
        刷新
      </NButton>
    </NSpace>

    <div v-if="showError" class="space-y-3" role="alert">
      <NAlert type="error" title="加载失败">
        {{ error }}
      </NAlert>
      <NButton size="small" @click="triggerLoad">
        重试
      </NButton>
    </div>
    <NDataTable
      v-else
      :columns="columns"
      :data="rows"
      :loading="loading"
      :scroll-x="1200"
      :row-key="(row: BackupItem) => row.id"
    >
      <template #empty>
        <NEmpty size="large" description="暂无备份，选择实例后点击「创建存档备份」" />
      </template>
    </NDataTable>

    <section class="db-snapshot-section">
      <div>
        <h2 class="m-0 text-lg font-semibold">
          面板数据库快照
        </h2>
        <p class="mt-1 text-sm text-muted-foreground">
          由「创建面板数据库快照」生成，包含面板账号与设置，不属于任何游戏实例。
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <NButton type="warning" strong secondary @click="handleCreateDbBackup" v-if="hasPermission('backup:create')">
            创建面板数据库快照
          </NButton>
          <NButton :loading="importingSnapshot" @click="openSnapshotPicker" v-if="hasPermission('backup:import')">
            导入快照
          </NButton>
          <span v-if="importingSnapshot" class="text-xs text-muted-foreground">已上传 {{ uploadPercent }}%</span>
          <input
            ref="snapshotInputRef"
            type="file"
            accept=".sqlite,.db"
            class="hidden"
            @change="handleSnapshotFile"
          >
        </div>
      </div>

      <div v-if="showDbError" class="space-y-3" role="alert">
        <NAlert type="error" title="面板快照加载失败">
          {{ dbError }}
        </NAlert>
        <NButton size="small" @click="loadDbBackups">
          重试
        </NButton>
      </div>
      <NDataTable
        v-else
        :columns="dbColumns"
        :data="dbRows"
        :loading="dbLoading"
        :scroll-x="1130"
        :row-key="(row: BackupItem) => row.id"
      >
        <template #empty>
          <NEmpty size="large" description="还没有面板快照，点击「创建面板数据库快照」生成" />
        </template>
      </NDataTable>
    </section>

    <NModal
      v-model:show="createDialogVisible"
      preset="dialog"
      type="warning"
      title="创建存档备份"
      positive-text="开始备份"
      negative-text="取消"
      @positive-click="submitCreateBackup"
    >
      <div style="display: flex; flex-direction: column; gap: 8px">
        <p style="margin: 0">
          将为实例「{{ instanceName(selectedInstanceId ?? '') }}」创建完整的存档备份。
        </p>
        <p style="margin: 0; color: #909090">
          运行中会先让世界保存一次再打包。
        </p>
        <NInput
          v-model:value="createDialogNote"
          placeholder="备注（可选，最多 200 字）"
          maxlength="200"
        />
      </div>
    </NModal>

    <NModal
      v-model:show="restoreDialogVisible"
      preset="dialog"
      type="error"
      title="恢复面板数据"
      positive-text="确认恢复"
      negative-text="取消"
      :positive-button-props="{ disabled: restoreConfirmText.trim() !== DB_SNAPSHOT_RESTORE_CONFIRM_TEXT }"
      @positive-click="submitRestore"
    >
      <div style="display: flex; flex-direction: column; gap: 8px">
        <p style="margin: 0">
          将用快照「{{ restoreTarget?.fileName }}」替换面板当前的数据。
        </p>
        <p style="margin: 0; color: #909090">
          面板会自动重启，当前登录会失效；正在运行的游戏实例不受影响。
        </p>
        <NInput
          v-model:value="restoreConfirmText"
          :placeholder="`请输入「${DB_SNAPSHOT_RESTORE_CONFIRM_TEXT}」以确认`"
        />
      </div>
    </NModal>

    <SaveImportModal
      v-model:show="importModalVisible"
      :instance-id="selectedInstanceId && selectedInstanceId !== 'panel-db' ? selectedInstanceId : null"
      :instance-name="instanceName(selectedInstanceId ?? '')"
      @imported="triggerLoad"
    />
  </FaPageMain>
</template>

<style scoped>
.db-snapshot-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
