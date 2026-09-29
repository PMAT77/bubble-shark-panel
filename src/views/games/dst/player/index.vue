<script setup lang="ts">
import type { DataTableColumns } from 'naive-ui'
import type { PlayerSummariesDto } from '@/api/modules/dst-summary'
import { NAlert, NButton, NDataTable, NEmpty, NTag } from 'naive-ui'
import { computed, h, onMounted, ref } from 'vue'
import AdminListToolbar from '@/components/AdminListToolbar.vue'
import apiDstSummary from '@/api/modules/dst-summary'
import { useAdminPageState } from '@/composables/useAdminPageState'
import { routeToDstPlayerManage, routeToNodeInstance } from '@/navigation/game-routes'
import { statusTagType } from '@/constants/statusDictionary'
import { getInstanceState } from '@/views/node/instance/instanceDisplay'

defineOptions({
  name: 'DstPlayerList',
})

const router = useRouter()
// 「前往实例管理」按钮只在有实例管理权限时才渲染：无权限的账号没注册这条路由，
// 按路由名跳会在解析阶段直接抛 "No match"（守卫兜不住）
const { auth: hasPermission } = useAppAuth()
const appSettingsStore = useAppSettingsStore()
/**
 * 这一页只拿「玩家投影」：服务端按 `player:read` 放行，只回房间名（这些玩家在哪个房间）、
 * 在线人数与上限。所以本页不需要「查看实例」，菜单也不会因为取消「查看实例」而消失。
 */
type PlayerRow = PlayerSummariesDto['items'][number]

const rows = ref<PlayerRow[]>([])
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

const filteredRows = computed(() => {
  const keyword = keywordFilter.value.trim().toLowerCase()
  if (!keyword) {
    return rows.value
  }
  return rows.value.filter((row) => {
    const haystack = [
      row.instance.name,
      row.player.clusterName ?? '',
    ].join(' ').toLowerCase()
    return haystack.includes(keyword)
  })
})

const hasFilteredRows = computed(() => filteredRows.value.length > 0)
const showFilteredEmpty = computed(() => initialLoadDone.value && !loading.value && rows.value.length > 0 && !hasFilteredRows.value)

const columns: DataTableColumns<PlayerRow> = [
  {
    title: '实例名称',
    key: 'instanceName',
    render: row => row.instance.name,
  },
  {
    title: '房间名称',
    key: 'clusterName',
    render: row => row.player.clusterName ?? '—',
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
    title: '操作',
    key: 'actions',
    width: 140,
    fixed: 'right',
    render: row => h(
      NButton,
      {
        size: 'small',
        type: 'info',
        text: true,
        onClick: () => openManage(row.instance.id),
      },
      { default: () => '管理玩家' },
    ),
  },
]

function openManage(instanceId: string) {
  router.push(routeToDstPlayerManage(instanceId))
}

function goToInstanceManagement() {
  router.push(routeToNodeInstance())
}

function formatOnlinePlayers(row: PlayerRow): string {
  if (row.instance.status !== 'running') {
    return '—'
  }
  if (row.player.onlinePlayerCount === null || row.player.maxPlayers === null) {
    return '—'
  }
  return `${row.player.onlinePlayerCount} / ${row.player.maxPlayers}`
}

async function loadRows() {
  await runLoad(async () => {
    const response = await apiDstSummary.getPlayerSummaries()
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
        玩家列表
      </h1>
      <p class="mt-1 text-sm text-muted-foreground">
        每个房间的玩家都在自己的页面里管理：查看在线玩家、踢出或封禁，以及维护管理员 / 白名单 / 黑名单名单。
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
        :scroll-x="800"
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
                {{ row.player.clusterName || '尚未配置房间名称' }}
              </p>
            </div>
            <NTag size="small" :bordered="false" :type="statusTagType(getInstanceState(row.instance).tone)">
              {{ getInstanceState(row.instance).label }}
            </NTag>
          </div>
          <dl class="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <div>
              <dt class="text-muted-foreground">在线人数</dt>
              <dd>{{ formatOnlinePlayers(row) }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">房间</dt>
              <dd>{{ row.player.clusterName || '—' }}</dd>
            </div>
          </dl>
          <NButton block @click="openManage(row.instance.id)">
            管理玩家
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
    <NEmpty v-else-if="showEmpty" description="暂无已安装的饥荒（DST）实例">
      <template #extra>
        <NButton type="primary" @click="goToInstanceManagement" v-if="hasPermission('instance:read')">
          前往实例管理
        </NButton>
      </template>
    </NEmpty>
  </FaPageMain>
</template>
