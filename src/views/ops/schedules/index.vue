<script setup lang="ts">
/** 当前账号的权限判定；按钮级隐藏用，后端仍是唯一的安全边界 */
const { auth: hasPermission } = useAppAuth()

import type { DataTableColumns, FormRules, SelectOption } from 'naive-ui'
import type { ScheduleCreateRequest, ScheduleTaskItem } from '@/api/modules/schedule'
import type { InstanceSummaryItem } from '@/api/modules/instance'
import { NButton, NDataTable, NEmpty, NForm, NFormItem, NInput, NInputNumber, NModal, NSelect, NSpace, NSwitch, NTag, NTime, NTimePicker, NTooltip, useDialog } from 'naive-ui'
import { computed, h, onActivated, onMounted, ref } from 'vue'
import apiSchedule from '@/api/modules/schedule'
import apiInstance from '@/api/modules/instance'
import { suppressScheduleRunNotificationOnce } from '@/composables/useScheduleRunNotifier'
import { useAdminPageState } from '@/composables/useAdminPageState'

defineOptions({
  name: 'OpsSchedules',
})

const dialog = useDialog()
const appSettingsStore = useAppSettingsStore()
const route = useRoute()
const router = useRouter()

const rows = ref<ScheduleTaskItem[]>([])
const instances = ref<InstanceSummaryItem[]>([])
const isMobileMode = computed(() => appSettingsStore.mode === 'mobile')

const {
  loading,
  runLoad,
} = useAdminPageState(rows)

const kindMeta: Record<ScheduleTaskItem['kind'], { label: string, type: 'default' | 'info' | 'warning' | 'error' | 'success' }> = {
  restart: { label: '定时重启', type: 'warning' },
  backup: { label: '定时备份', type: 'info' },
  update_check: { label: '更新检查', type: 'default' },
  db_snapshot: { label: '面板快照', type: 'success' },
}

const runStatusMeta: Record<NonNullable<ScheduleTaskItem['lastRunStatus']>, { label: string, type: 'default' | 'info' | 'warning' | 'error' | 'success' }> = {
  running: { label: '执行中', type: 'info' },
  ok: { label: '成功', type: 'success' },
  failed: { label: '失败', type: 'error' },
  skipped: { label: '跳过', type: 'warning' },
}

function describeSchedule(task: ScheduleTaskItem): string {
  if (task.scheduleType === 'interval') {
    return `每 ${task.scheduleValue} 小时`
  }
  const tzLabel = task.scheduleTimezone === 'server' ? '服务器时区' : '北京时间'
  return `每日 ${task.scheduleValue}（${tzLabel}）`
}

function instanceName(instanceId: string): string {
  if (instanceId === 'panel-db') {
    return '面板数据库'
  }
  return instances.value.find(item => item.id === instanceId)?.name ?? instanceId
}

const instanceOptions = computed<SelectOption[]>(() => {
  return instances.value.map(item => ({
    label: item.name,
    value: item.id,
  }))
})

/** 从通知「查看任务」跳转过来时要定位的任务：短暂高亮并滚动到可视区 */
const highlightedTaskId = ref<string | null>(null)
let highlightTimer: number | undefined

function highlightTaskRow(taskId: string) {
  highlightedTaskId.value = taskId
  if (highlightTimer !== undefined) {
    window.clearTimeout(highlightTimer)
  }
  // 等表格应用高亮 class 后再滚动到该行
  nextTick(() => {
    document.querySelector('.schedule-row-highlight')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
  highlightTimer = window.setTimeout(() => {
    highlightedTaskId.value = null
  }, 4000)
}

/** 消费 ?taskId= 定位参数；消费后从地址栏移除，避免刷新时重复高亮 */
function focusTaskFromQuery() {
  const taskId = typeof route.query.taskId === 'string' ? route.query.taskId : ''
  if (!taskId) {
    return
  }
  highlightTaskRow(taskId)
  void router.replace({ path: route.path, query: {} })
}

function scheduleRowClassName(row: ScheduleTaskItem): string {
  return row.id === highlightedTaskId.value ? 'schedule-row-highlight' : ''
}

function triggerLoad() {
  // 列表就绪后再定位（行必须已经渲染才能滚动）
  void runLoad(async () => {
    const [scheduleResponse, instanceResponse] = await Promise.all([
      apiSchedule.getScheduleList(),
      apiInstance.getInstanceOptions().catch(() => ({ data: [] as InstanceSummaryItem[] })),
    ])
    rows.value = scheduleResponse.data ?? []
    instances.value = instanceResponse.data ?? []
  }).then(focusTaskFromQuery)
}

/** 存在执行中的任务时按 5s 刷新列表，让「执行中」自动滚动到终态 */
const hasRunningTask = computed(() => rows.value.some(row => row.lastRunStatus === 'running'))
const runPoller = usePollingTask(async () => {
  const response = await apiSchedule.getScheduleList()
  rows.value = response.data ?? []
}, { intervalMs: 5000, immediate: false })

function syncRunPoller() {
  if (hasRunningTask.value) {
    runPoller.start()
  }
  else {
    runPoller.stop()
  }
}

watch(hasRunningTask, syncRunPoller)

onMounted(() => {
  triggerLoad()
})

onActivated(() => {
  triggerLoad()
  syncRunPoller()
})

onDeactivated(() => {
  runPoller.stop()
})

// 已在计划任务页时再次点击通知（路由不变化）也要重新定位
watch(() => route.query.taskId, (taskId) => {
  if (typeof taskId === 'string' && taskId) {
    triggerLoad()
  }
})

onBeforeUnmount(() => {
  if (highlightTimer !== undefined) {
    window.clearTimeout(highlightTimer)
  }
})

// ---------------------------------------------------------------------------
// 创建 / 编辑
// ---------------------------------------------------------------------------

const editorVisible = ref(false)
const editorIsEdit = ref(false)
const editorTaskId = ref('')
const editorInstanceId = ref<string | null>(null)
const editorKind = ref<ScheduleTaskItem['kind']>('backup')
const editorScheduleType = ref<ScheduleTaskItem['scheduleType']>('daily')
const editorScheduleTimezone = ref<NonNullable<ScheduleCreateRequest['scheduleTimezone']>>('beijing')
const editorIntervalHours = ref<number | null>(24)
const editorDailyTimeTs = ref<number | null>(null)

/** HH:mm 字符串 → 当天该时刻的时间戳（供时间选择器回显） */
function parseHHmmToTs(value: string): number {
  const [hourPart, minutePart] = value.split(':')
  const date = new Date()
  date.setHours(Number.parseInt(hourPart ?? '0', 10) || 0, Number.parseInt(minutePart ?? '0', 10) || 0, 0, 0)
  return date.getTime()
}

/** 时间戳 → HH:mm 字符串（提交给后端的格式） */
function formatTsToHHmm(ts: number): string {
  const date = new Date(ts)
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return hour + ':' + minute
}

const kindOptions: SelectOption[] = [
  { label: '定时备份（实例存档）', value: 'backup' },
  { label: '定时重启', value: 'restart' },
  { label: '检查游戏更新', value: 'update_check' },
  { label: '面板数据库快照（全局）', value: 'db_snapshot' },
]

const scheduleTypeOptions: SelectOption[] = [
  { label: '每日固定时刻', value: 'daily' },
  { label: '每 N 小时', value: 'interval' },
]

const scheduleTimezoneOptions: SelectOption[] = [
  { label: '北京时间（默认）', value: 'beijing' },
  { label: '服务器所在时区', value: 'server' },
]

const editorRules: FormRules = {
  instanceId: [{ required: true, message: '请选择目标实例', trigger: ['blur', 'change'], type: 'string' }],
}

function openCreateDialog() {
  editorIsEdit.value = false
  editorTaskId.value = ''
  editorInstanceId.value = instances.value[0]?.id ?? null
  editorKind.value = 'backup'
  editorScheduleType.value = 'daily'
  editorScheduleTimezone.value = 'beijing'
  editorIntervalHours.value = 24
  editorDailyTimeTs.value = parseHHmmToTs('04:30')
  editorVisible.value = true
}

function openEditDialog(task: ScheduleTaskItem) {
  editorIsEdit.value = true
  editorTaskId.value = task.id
  editorInstanceId.value = task.instanceId
  editorKind.value = task.kind
  editorScheduleType.value = task.scheduleType
  editorScheduleTimezone.value = task.scheduleTimezone ?? 'beijing'
  editorIntervalHours.value = Number.parseInt(task.scheduleValue, 10) || 24
  editorDailyTimeTs.value = parseHHmmToTs(task.scheduleValue)
  editorVisible.value = true
}

function resolveScheduleValue(): string | null {
  if (editorScheduleType.value === 'interval') {
    const hours = editorIntervalHours.value
    if (!Number.isInteger(hours) || (hours ?? 0) < 1 || (hours ?? 0) > 168) {
      return null
    }
    return String(hours)
  }
  if (editorDailyTimeTs.value === null) {
    return null
  }
  return formatTsToHHmm(editorDailyTimeTs.value)
}

async function submitEditor() {
  const scheduleValue = resolveScheduleValue()
  if (!scheduleValue) {
    faToast.error(editorScheduleType.value === 'interval' ? '间隔需为 1-168 的整数小时' : '请选择每日执行时刻')
    return
  }
  if (editorIsEdit.value) {
    const response = await apiSchedule.updateScheduleTask({
      taskId: editorTaskId.value,
      scheduleType: editorScheduleType.value,
      scheduleValue,
      scheduleTimezone: editorScheduleTimezone.value,
    })
    if (response.data.isSuccess) {
      faToast.success('计划任务已更新')
      editorVisible.value = false
      triggerLoad()
    }
    return
  }
  if (!editorInstanceId.value) {
    faToast.error('请选择目标实例')
    return
  }
  const response = await apiSchedule.createScheduleTask({
    instanceId: editorInstanceId.value,
    kind: editorKind.value,
    scheduleType: editorScheduleType.value,
    scheduleValue,
    scheduleTimezone: editorScheduleTimezone.value,
  })
  if (response.data.isSuccess) {
    faToast.success('计划任务已创建')
    editorVisible.value = false
    triggerLoad()
  }
}

// ---------------------------------------------------------------------------
// 行操作
// ---------------------------------------------------------------------------

async function toggleEnabled(task: ScheduleTaskItem, enabled: boolean) {
  try {
    const response = await apiSchedule.updateScheduleTask({ taskId: task.id, enabled })
    if (response.data.isSuccess) {
      task.enabled = enabled
      faToast.success(enabled ? '任务已启用' : '任务已停用')
      triggerLoad()
    }
  }
  catch {
    faToast.error('操作失败，请稍后重试')
  }
}

function runNow(task: ScheduleTaskItem) {
  dialog.warning({
    title: '立即执行',
    content: `确定立即执行「${kindMeta[task.kind].label}」？`,
    positiveText: '执行',
    negativeText: '取消',
    onPositiveClick: async () => {
      // 乐观反馈：接口同步等待执行完成，先把该行置为执行中并抑制重复的右上角通知
      task.lastRunStatus = 'running'
      task.lastRunMessage = '执行中…'
      suppressScheduleRunNotificationOnce(task.id)
      try {
        const response = await apiSchedule.runScheduleTaskNow({ taskId: task.id })
        faToast[response.data.message?.startsWith('skipped') ? 'warning' : 'success'](response.data.message ?? '已触发执行')
      }
      catch {
        faToast.error('执行失败，请稍后重试')
      }
      triggerLoad()
    },
  })
}

function removeTask(task: ScheduleTaskItem) {
  dialog.error({
    title: '删除计划任务',
    content: `确定删除「${kindMeta[task.kind].label}（${describeSchedule(task)}）」？删除后不再执行。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const response = await apiSchedule.deleteScheduleTask({ taskId: task.id })
        if (response.data.isSuccess) {
          faToast.success('已删除')
          triggerLoad()
        }
      }
      catch {
        faToast.error('删除失败，请稍后重试')
      }
    },
  })
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

const columns = computed<DataTableColumns<ScheduleTaskItem>>(() => {
  const base: DataTableColumns<ScheduleTaskItem> = [
    {
      title: '任务',
      key: 'kind',
      width: 110,
      render: row => h(NTag, { type: kindMeta[row.kind].type, size: 'small', bordered: false }, { default: () => kindMeta[row.kind].label }),
    },
    {
      title: '目标',
      key: 'instanceId',
      minWidth: 140,
      render: row => instanceName(row.instanceId),
    },
    {
      title: '调度',
      key: 'schedule',
      width: 180,
      render: row => describeSchedule(row),
    },
    {
      title: '状态',
      key: 'enabled',
      width: 90,
      render: (row) => {
        return h(NSwitch, {
          value: row.enabled,
          size: 'small',
          onUpdateValue: (value: boolean) => toggleEnabled(row, value),
        })
      },
    },
    {
      title: '执行状态',
      key: 'lastRunStatus',
      width: 110,
      render: (row) => {
        if (!row.lastRunStatus) {
          return h('span', { class: 'text-xs opacity-60' }, '尚未执行')
        }
        const meta = runStatusMeta[row.lastRunStatus]
        return h(NTooltip, null, {
          trigger: () => h(NTag, { type: meta.type, size: 'small', bordered: false }, { default: () => meta.label }),
          default: () => row.lastRunMessage ?? '',
        })
      },
    },
    {
      title: '最近执行时间',
      key: 'lastRunAt',
      width: 170,
      render: row => (row.lastRunAt ? h(NTime, { time: new Date(row.lastRunAt), type: 'datetime' }) : '—'),
    },
    {
      title: '下次执行',
      key: 'nextRunAt',
      width: 170,
      render: row => (row.enabled && row.nextRunAt
        ? h(NTime, { time: new Date(row.nextRunAt), type: 'datetime' })
        : '—'),
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (row) => {
        /**
         * 按权限**构建**按钮数组，而不是渲染出来再禁用：
         * 任务归属的实例看不到时，这些按钮本来也不该出现。
         */
        const actions: ReturnType<typeof h>[] = []
        // 三个按钮同属一个权限点：后端 run-now / update / delete 都是 schedule:write
        // （最初这里写成 schedule:run，那个点位并不存在——类型收紧后才会编译报错）
        if (hasPermission('schedule:write')) {
          actions.push(h(NButton, { size: 'small', secondary: true, disabled: !row.enabled, onClick: () => runNow(row) }, { default: () => '立即执行' }))
          actions.push(h(NButton, { size: 'small', secondary: true, onClick: () => openEditDialog(row) }, { default: () => '编辑' }))
          actions.push(h(NButton, { size: 'small', secondary: true, type: 'error', onClick: () => removeTask(row) }, { default: () => '删除' }))
        }
        return h(NSpace, { size: 8, wrap: false }, { default: () => actions })
      },
    },
  ]
  return base
})
</script>

<template>
  <FaPageMain class="gap-4" main-class="flex flex-col gap-4">
    <div>
      <h2 class="m-0 text-lg font-semibold">
        计划任务
      </h2>
      <p class="mt-1 text-sm text-muted-foreground">
        单机定时任务；错过的执行不会补跑。
      </p>
    </div>

    <div class="flex flex-wrap items-center justify-start gap-3"> 
      <NButton type="primary" @click="openCreateDialog" v-if="hasPermission('schedule:write')">
        新建任务
      </NButton>
    </div>

    <NDataTable
      :columns="columns"
      :data="rows"
      :loading="loading"
      :scroll-x="isMobileMode ? 1100 : undefined"
      :pagination="false"
      :row-class-name="scheduleRowClassName"
      size="small"
    >
      <template #empty>
        <NEmpty size="large" />
      </template>
    </NDataTable>

    <NModal
      v-model:show="editorVisible"
      preset="card"
      :title="editorIsEdit ? '编辑计划任务' : '新建计划任务'"
      class="w-[480px] max-w-[92vw]"
      :mask-closable="false"
    >
      <NForm
        :model="{}"
        :rules="editorRules"
        label-placement="top"
        @submit.prevent="submitEditor"
      >
        <NFormItem label="任务类型">
          <NSelect v-model:value="editorKind" :options="kindOptions" :disabled="editorIsEdit" />
        </NFormItem>
        <NFormItem v-if="editorKind !== 'db_snapshot'" label="目标实例" path="instanceId">
          <NSelect
            v-model:value="editorInstanceId"
            :options="instanceOptions"
            :disabled="editorIsEdit"
            filterable
            placeholder="选择实例"
          />
        </NFormItem>
        <NFormItem v-else label="目标">
          <NInput value="面板数据库（全局）" disabled />
        </NFormItem>
        <NFormItem label="调度方式">
          <NSelect v-model:value="editorScheduleType" :options="scheduleTypeOptions" />
        </NFormItem>
        <NFormItem v-if="editorScheduleType === 'daily'" label="时区">
          <NSelect v-model:value="editorScheduleTimezone" :options="scheduleTimezoneOptions" />
        </NFormItem>
        <NFormItem v-if="editorScheduleType === 'interval'" label="间隔（小时，1-168）">
          <NInputNumber v-model:value="editorIntervalHours" :min="1" :max="168" :step="1" class="w-full" />
        </NFormItem>
        <NFormItem v-else :label="editorScheduleTimezone === 'beijing' ? '每日时刻（北京时间）' : '每日时刻（服务器时区）'">
          <NTimePicker
            v-model:value="editorDailyTimeTs"
            format="HH:mm"
            :minute-step="5"
            class="w-full"
          />
        </NFormItem>
        <div v-if="editorKind === 'backup'" class="mb-3 text-xs opacity-50">
          运行中会先让世界保存一次。
        </div>
        <NSpace justify="end">
          <NButton @click="editorVisible = false">
            取消
          </NButton>
          <NButton type="primary" @click="submitEditor">
            {{ editorIsEdit ? '保存' : '创建' }}
          </NButton>
        </NSpace>
      </NForm>
    </NModal>
  </FaPageMain>
</template>

<style scoped>
:deep(.schedule-row-highlight td) {
  animation: schedule-row-flash 1s ease-in-out 4;
}

@keyframes schedule-row-flash {
  0%,
  100% {
    background-color: transparent;
  }

  50% {
    background-color: rgb(32 128 240 / 18%);
  }
}
</style>
