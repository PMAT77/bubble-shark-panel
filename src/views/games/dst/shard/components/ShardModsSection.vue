<script setup lang="ts">
import type { DataTableColumns } from 'naive-ui'
import type { ModItemDto } from '@/api/modules/mod'
import { NAlert, NButton, NDataTable, NEmpty, NSelect, NTag, NTooltip, useMessage } from 'naive-ui'
import { computed, h, ref, watch } from 'vue'
import AdminSettingsSection from '@/components/AdminSettingsSection.vue'
import apiMod from '@/api/modules/mod'
import { MOD_ENABLED_STATUS, MOD_INSTALL_STATUS, MOD_UPDATE_STATUS, statusTagType } from '@/constants/statusDictionary'
import { useInstanceModState } from '@/composables/useInstanceModState'

type ModEnabledFilter = 'all' | 'enabled' | 'disabled'

// 启停 Mod 是写操作：只读账号（游客角色）能看列表与状态，但点不动
const { auth: hasPermission } = useAppAuth()

const props = defineProps<{
  instanceId: string
  memoryWarning?: string | null
}>()

const message = useMessage()
const loadingInstalled = ref(false)
const loadError = ref<string | null>(null)
const mutatingWorkshopIds = ref<Set<string>>(new Set())
const modEnabledFilter = ref<ModEnabledFilter>('all')

const installedMods = ref<ModItemDto[]>([])

const {
  restoreInstallJobs,
  resetState,
} = useInstanceModState(() => props.instanceId)

const hasInstanceId = computed(() => Boolean(props.instanceId.trim()))
const modEnabledFilterOptions = [
  { label: '全部', value: 'all' as const },
  { label: '已开启', value: 'enabled' as const },
  { label: '已关闭', value: 'disabled' as const },
]
// 筛选只作用于已下载的 Mod；下载中/失败行始终可见，避免凭空消失
const filteredInstalledMods = computed(() => {
  if (modEnabledFilter.value === 'all') {
    return installedMods.value
  }
  return installedMods.value.filter((row) => {
    if (row.installStatus !== 'ready') {
      return true
    }
    return modEnabledFilter.value === 'enabled' ? row.enabled : !row.enabled
  })
})

/** 安装状态 = Mod 文件在不在服务器上；是否生效由右边的「开关状态」决定，标签里再说一遍只会打架 */
function renderInstallStatus(row: ModItemDto) {
  const state = MOD_INSTALL_STATUS[row.installStatus]
  const tag = h(
    NTag,
    { size: 'small', bordered: false, type: statusTagType(state.tone) },
    { default: () => state.label },
  )
  return h(
    NTooltip,
    { trigger: 'hover' },
    {
      trigger: () => tag,
      default: () => (row.installStatus === 'ready'
        ? 'Mod 文件已下载并放入服务器目录；是否在游戏里生效看「开关状态」'
        : (row.installError?.trim() || 'Mod 文件尚未就绪，就绪后才能开启')),
    },
  )
}

const installedColumns: DataTableColumns<ModItemDto> = [
  { title: 'Mod 名称', key: 'name', minWidth: 220, render: row => row.name },
  { title: '创意工坊 ID', key: 'workshopId', width: 170, render: row => row.workshopId },
  {
    title: '安装状态',
    key: 'installStatus',
    width: 110,
    render: row => renderInstallStatus(row),
  },
  {
    // 只做展示：更新在「Mod 管理」页执行，这里让服主一眼看到哪个 Mod 需要更新
    title: '版本',
    key: 'updateStatus',
    width: 100,
    render: (row) => {
      const state = MOD_UPDATE_STATUS[row.updateStatus]
      return h(
        NTag,
        { size: 'small', bordered: false, type: statusTagType(state.tone) },
        { default: () => state.label },
      )
    },
  },
  {
    title: '开关状态',
    key: 'enabled',
    width: 110,
    render: (row) => {
      if (row.installStatus !== 'ready') {
        return h('span', { class: 'text-xs text-muted-foreground' }, '-')
      }
      const state = row.enabled ? MOD_ENABLED_STATUS.enabled : MOD_ENABLED_STATUS.disabled
      return h(
        NTag,
        { size: 'small', bordered: false, type: statusTagType(state.tone) },
        { default: () => state.label },
      )
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 150,
    // 启停 Mod 要 mod:toggle：没有就不给这个入口（服务端同样会拒）
    render: row => (hasPermission('mod:toggle')
      ? h(
          NTooltip,
          {
            disabled: row.installStatus === 'ready',
          },
          {
            trigger: () => h(
              NButton,
              {
                size: 'small',
                type: row.enabled ? 'warning' : 'primary',
                ghost: true,
                loading: mutatingWorkshopIds.value.has(row.workshopId),
                disabled: !hasInstanceId.value
                  || mutatingWorkshopIds.value.has(row.workshopId)
                  || row.installStatus !== 'ready',
                onClick: () => void toggleModEnabled(row),
              },
              { default: () => (row.enabled ? '关闭' : '开启') },
            ),
            default: () => (row.installStatus === 'failed'
              ? '下载失败，请在 Mod 管理页重试'
              : '下载完成后才能开启'),
          },
        )
      : null),
  },
]

async function loadInstalledMods() {
  const targetId = props.instanceId
  if (!targetId.trim()) {
    installedMods.value = []
    resetState()
    return
  }
  loadingInstalled.value = true
  loadError.value = null
  try {
    const response = await apiMod.getModList(targetId)
    // 快速切换实例时丢弃过期响应，避免旧实例数据覆盖新实例的 Mod 列表
    if (props.instanceId !== targetId) {
      return
    }
    installedMods.value = response.data.mods
    await restoreInstallJobs({ modList: response.data })
  }
  catch {
    // 全局拦截器已提示错误原因，这里提供可重试的内联错误态
    if (props.instanceId === targetId) {
      loadError.value = '已订阅 Mod 加载失败，请检查实例状态后重试。'
    }
  }
  finally {
    if (props.instanceId === targetId) {
      loadingInstalled.value = false
    }
  }
}

async function toggleModEnabled(item: ModItemDto) {
  if (!hasInstanceId.value || mutatingWorkshopIds.value.has(item.workshopId) || item.installStatus !== 'ready') {
    return
  }
  const nextMutating = new Set(mutatingWorkshopIds.value)
  nextMutating.add(item.workshopId)
  mutatingWorkshopIds.value = nextMutating
  try {
    const response = await apiMod.updateMod(props.instanceId, item.workshopId, {
      enabled: !item.enabled,
    })
    const riskTip = response.data.riskTip?.trim()
    message.success(`${item.enabled ? '已关闭' : '已开启'}该 Mod，重启实例后生效（可在实例管理执行重启）`)
    if (riskTip) {
      message.warning(riskTip)
    }
    installedMods.value = installedMods.value.map(row => (
      row.workshopId === item.workshopId
        ? { ...row, enabled: !row.enabled }
        : row
    ))
  }
  catch {
    message.error('更新 Mod 状态失败，请稍后重试')
  }
  finally {
    const next = new Set(mutatingWorkshopIds.value)
    next.delete(item.workshopId)
    mutatingWorkshopIds.value = next
  }
}

watch(() => props.instanceId, (value) => {
  resetState()
  loadError.value = null
  if (!value.trim()) {
    installedMods.value = []
    return
  }
  void loadInstalledMods()
}, { immediate: true })
</script>

<template>
  <div class="space-y-4">
    <AppHostMemoryAlert
      v-if="memoryWarning"
      title="内存与模组"
      :message="memoryWarning"
    />

    <AdminSettingsSection
      title="已订阅 Mod"
      description="管理当前实例已订阅 Mod 的开启状态；新订阅默认关闭，需在此手动开启。下载未完成时请到 Mod 管理处理。"
    />

    <div class="flex flex-wrap items-center gap-3">
      <NSelect
        v-model:value="modEnabledFilter"
        :options="modEnabledFilterOptions"
        class="w-36"
      />
      <NButton :disabled="loadingInstalled" @click="loadInstalledMods">
        刷新列表
      </NButton>
    </div>

    <NAlert
      v-if="loadError"
      type="error"
      class="mb-3"
      title="加载失败"
    >
      {{ loadError }}
      <NButton size="tiny" class="ml-2" @click="loadInstalledMods">
        重试
      </NButton>
    </NAlert>
    <NDataTable
      v-else
      :bordered="false"
      :single-line="false"
      :columns="installedColumns"
      :data="filteredInstalledMods"
      :loading="loadingInstalled"
      :pagination="false"
    >
      <template #empty>
        <NEmpty size="large" />
      </template>
    </NDataTable>
  </div>
</template>
