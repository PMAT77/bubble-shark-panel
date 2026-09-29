<script setup lang="ts">
import type { DataTableColumns } from 'naive-ui'
import type { ClusterNetworkMode } from '@/api/modules/cluster'
import type { RoomSummariesDto } from '@/api/modules/dst-summary'
import { NAlert, NButton, NDataTable, NEmpty, NTag, NTooltip } from 'naive-ui'
import { computed, h, onMounted, ref } from 'vue'
import AdminListToolbar from '@/components/AdminListToolbar.vue'
import apiDstSummary from '@/api/modules/dst-summary'
import { useAdminPageState } from '@/composables/useAdminPageState'
import { routeToDstRoomSettings, routeToNodeInstance } from '@/navigation/game-routes'
import { CAVES_FEATURE_STATUS, CONFIG_ERROR_STATUS, statusTagType } from '@/constants/statusDictionary'
import { getInstanceState } from '@/views/node/instance/instanceDisplay'

defineOptions({
  name: 'DstRoomList',
})

const router = useRouter()
// 「前往实例管理」按钮只在有实例管理权限时才渲染：无权限的账号没注册这条路由，
// 按路由名跳会在解析阶段直接抛 "No match"（守卫兜不住）
const { auth: hasPermission } = useAppAuth()
const appSettingsStore = useAppSettingsStore()
/**
 * 这一页只拿「房间投影」：服务端按 `room:read` 放行，只回房间名、联网模式、洞穴开关、
 * 人数这几列要用的字段（房间名与人数之外的世界细节不在这里）。所以本页不需要「查看实例」，
 * 菜单也不会因为取消「查看实例」而消失。
 */
type RoomRow = RoomSummariesDto['items'][number]

const rows = ref<RoomRow[]>([])
const keywordFilter = ref('')
const isMobileMode = computed(() => appSettingsStore.mode === 'mobile')

const {
  loading,
  error,
  showEmpty,
  showError,
  initialLoadDone,
  runLoad,
} = useAdminPageState(rows)

const networkModeLabel: Record<ClusterNetworkMode, string> = {
  offline: '离线',
  lan_only: '仅局域网',
  public: '公网',
}

const filteredRows = computed(() => {
  const keyword = keywordFilter.value.trim().toLowerCase()
  if (!keyword) {
    return rows.value
  }
  return rows.value.filter((row) => {
    const haystack = [
      row.instance.name,
      row.room.clusterName ?? '',
      row.instance.gameCode ?? '',
    ].join(' ').toLowerCase()
    return haystack.includes(keyword)
  })
})

const hasFilteredRows = computed(() => filteredRows.value.length > 0)
const showFilteredEmpty = computed(() => initialLoadDone.value && !loading.value && rows.value.length > 0 && !hasFilteredRows.value)

const columns: DataTableColumns<RoomRow> = [
  {
    title: '实例名称',
    key: 'instanceName',
    render: row => row.instance.name,
  },
  {
    title: '房间名称',
    key: 'clusterName',
    render: row => row.room.clusterName ?? '—',
  },
  {
    title: '运行状态',
    key: 'status',
    render: (row) => {
      const state = getInstanceState(row.instance)
      return h(
        NTag,
        { size: 'small', bordered: false, type: statusTagType(state.tone) },
        { default: () => state.label },
      )
    },
  },
  {
    title: '在线人数',
    key: 'onlinePlayers',
    width: 100,
    align: 'right',
    render: row => formatOnlinePlayers(row),
  },
  {
    title: '联网模式',
    key: 'networkMode',
    render: (row) => {
      if (row.room.networkMode) {
        return networkModeLabel[row.room.networkMode]
      }
      if (row.room.error) {
        return h(
          NTooltip,
          { trigger: 'hover' },
          {
            trigger: () => h(
              NTag,
              { size: 'small', type: statusTagType(CONFIG_ERROR_STATUS.tone), bordered: false },
              { default: () => CONFIG_ERROR_STATUS.label },
            ),
            default: () => row.room.error,
          },
        )
      }
      return '—'
    },
  },
  {
    title: '洞穴',
    key: 'caves',
    render: (row) => {
      const summary = buildCavesSummary(row.room.shardEnabled, row.room.cavesConfigured ?? undefined)
      return h(NTag, { size: 'small', bordered: false, type: summary.type }, { default: () => summary.label })
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 120,
    fixed: 'right',
    render: (row) => {
      const installing = row.instance.status === 'pending_install' || row.instance.status === 'installing'
      return h(
        NTooltip,
        { disabled: !installing },
        {
          trigger: () => h(
            NButton,
            {
              size: 'small',
              type: 'info',
              text: true,
              onClick: () => openSettings(row.instance.id),
            },
            { default: () => '配置房间' },
          ),
          default: () => '实例安装中也可以先配置，安装完成后自动生效',
        },
      )
    },
  },
]

function openSettings(instanceId: string) {
  router.push(routeToDstRoomSettings(instanceId))
}

function goToInstanceManagement() {
  router.push(routeToNodeInstance())
}

/** 洞穴功能三态：未开启（用户没开）/ 已开启 / 配置异常（开了但配置缺失） */
function buildCavesSummary(shardEnabled: boolean | null, cavesConfigured: boolean | undefined): { label: string, type: ReturnType<typeof statusTagType> } {
  if (shardEnabled === null) {
    return { label: '—', type: 'default' }
  }
  if (!shardEnabled) {
    return { label: CAVES_FEATURE_STATUS.off.label, type: statusTagType(CAVES_FEATURE_STATUS.off.tone) }
  }
  if (!cavesConfigured) {
    return { label: CAVES_FEATURE_STATUS.error.label, type: statusTagType(CAVES_FEATURE_STATUS.error.tone) }
  }
  return { label: CAVES_FEATURE_STATUS.on.label, type: statusTagType(CAVES_FEATURE_STATUS.on.tone) }
}

function formatOnlinePlayers(row: RoomRow): string {
  if (row.instance.status !== 'running') {
    return '—'
  }
  if (row.room.onlinePlayerCount === null || row.room.maxPlayers === null) {
    return '—'
  }
  return `${row.room.onlinePlayerCount} / ${row.room.maxPlayers}`
}

async function loadRows() {
  await runLoad(async () => {
    const response = await apiDstSummary.getRoomSummaries()
    rows.value = response.data.items
  })
}

function resetFilters() {
  keywordFilter.value = ''
}

onMounted(() => {
  void loadRows()
})
</script>

<template>
  <FaPageMain main-class="flex flex-col gap-4">
    <div>
      <h1 class="text-lg font-semibold">
        房间列表
      </h1>
      <p class="mt-1 text-sm text-muted-foreground">
        让朋友加入你的服务器：先在这里配置房间名称、密码与联机方式；公网联机需要 Klei 令牌。
      </p>
    </div>

    <AdminListToolbar
      v-model:keyword="keywordFilter"
      keyword-placeholder="实例名称 / 房间名称"
      :show-search="false"
      :reset-disabled="!keywordFilter"
      @reset="resetFilters"
    >
      <template #actions>
        <NButton :loading="loading" @click="loadRows">
          刷新
        </NButton>
      </template>
    </AdminListToolbar>

    <div v-if="showError" class="space-y-3" role="alert">
      <NAlert type="error" title="加载失败">
        {{ error }}
      </NAlert>
      <NButton size="small" @click="loadRows">
        重试
      </NButton>
    </div>
    <template v-else-if="hasFilteredRows">
      <NDataTable
        v-if="!isMobileMode"
        :bordered="false"
        :single-line="false"
        :columns="columns"
        :data="filteredRows"
        :loading="loading"
        :scroll-x="1000"
      />
      <div v-else class="space-y-3" :aria-busy="loading">
        <article
          v-for="row in filteredRows"
          :key="row.instance.id"
          class="rounded-lg border border-border bg-card p-4 space-y-3"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="truncate font-medium">
                {{ row.instance.name }}
              </h2>
              <p class="mt-1 text-sm text-muted-foreground truncate">
                {{ row.room.clusterName || '尚未配置房间名称' }}
              </p>
            </div>
            <NTag size="small" :bordered="false" :type="statusTagType(getInstanceState(row.instance).tone)">
              {{ getInstanceState(row.instance).label }}
            </NTag>
          </div>
          <dl class="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <div>
              <dt class="text-muted-foreground">联机模式</dt>
              <dd>{{ row.room.networkMode ? networkModeLabel[row.room.networkMode] : '—' }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">在线人数</dt>
              <dd>{{ formatOnlinePlayers(row) }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">洞穴</dt>
              <dd>{{ buildCavesSummary(row.room.shardEnabled, row.room.cavesConfigured ?? undefined).label }}</dd>
            </div>
            <div v-if="row.room.error" class="col-span-2 text-amber-600 dark:text-amber-400">
              {{ row.room.error }}
            </div>
          </dl>
          <NButton block @click="openSettings(row.instance.id)">
            配置房间
          </NButton>
        </article>
      </div>
    </template>
    <div
      v-else-if="showFilteredEmpty"
      class="text-muted-foreground py-12 text-center text-sm"
    >
      没有匹配「{{ keywordFilter }}」的房间，请调整关键词或重置筛选。
    </div>
    <NEmpty v-else-if="showEmpty" description="暂无已安装的 DST 实例">
      <template #extra>
        <NButton type="primary" @click="goToInstanceManagement" v-if="hasPermission('instance:read')">
          前往实例管理
        </NButton>
      </template>
    </NEmpty>
  </FaPageMain>
</template>
