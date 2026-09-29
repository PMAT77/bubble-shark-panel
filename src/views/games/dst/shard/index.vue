<script setup lang="ts">
import type { DataTableColumns } from 'naive-ui'
import type { WorldSummariesDto } from '@/api/modules/dst-summary'
import { NAlert, NButton, NDataTable, NEmpty, NTag, NTooltip } from 'naive-ui'
import { computed, h, onMounted, ref } from 'vue'
import AdminListToolbar from '@/components/AdminListToolbar.vue'
import apiDstSummary from '@/api/modules/dst-summary'
import { useAdminPageState } from '@/composables/useAdminPageState'
import { routeToDstWorldSettings, routeToNodeInstance } from '@/navigation/game-routes'
import { CONFIG_ERROR_STATUS, resolveShardDisplayStatus, statusTagType, type ShardDisplayFacts } from '@/constants/statusDictionary'
import { getInstanceState } from '@/views/node/instance/instanceDisplay'

defineOptions({
  name: 'DstWorldList',
})

const router = useRouter()
// 「前往实例管理」按钮只在有实例管理权限时才渲染：无权限的账号没注册这条路由，
// 按路由名跳会在解析阶段直接抛 "No match"（守卫兜不住）
const { auth: hasPermission } = useAppAuth()
const appSettingsStore = useAppSettingsStore()
/**
 * 这一页只拿「世界投影」：服务端按 `world:read` 放行，只回分片配置与容器状态。
 * 所以本页不需要「查看实例」，菜单也不会因为取消「查看实例」而消失。
 */
type WorldRow = WorldSummariesDto['items'][number]

const rows = ref<WorldRow[]>([])
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

function renderShardStatusTag(shard: ShardDisplayFacts) {
  const descriptor = resolveShardDisplayStatus(shard)
  return h(
    NTag,
    { size: 'small', bordered: false, type: statusTagType(descriptor.tone) },
    { default: () => descriptor.label },
  )
}

function shardStatusText(row: WorldRow, shardId: 'master' | 'caves'): string {
  const shard = row.world[shardId]
  return shard ? resolveShardDisplayStatus(shard).label : '—'
}

const filteredRows = computed(() => {
  const keyword = keywordFilter.value.trim().toLowerCase()
  if (!keyword) {
    return rows.value
  }
  return rows.value.filter(row =>
    row.instance.name.toLowerCase().includes(keyword),
  )
})

const hasFilteredRows = computed(() => filteredRows.value.length > 0)
const showFilteredEmpty = computed(() => initialLoadDone.value && !loading.value && rows.value.length > 0 && !hasFilteredRows.value)

const columns: DataTableColumns<WorldRow> = [
  {
    title: '实例名称',
    key: 'instanceName',
    render: row => row.instance.name,
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
    title: '洞穴功能',
    key: 'clusterShard',
    render: (row) => {
      const enabled = row.world.clusterShardEnabled
      if (enabled === null) {
        if (row.world.error) {
          return h(
            NTooltip,
            { trigger: 'hover' },
            {
              trigger: () => h(
                NTag,
                { size: 'small', type: statusTagType(CONFIG_ERROR_STATUS.tone), bordered: false },
                { default: () => CONFIG_ERROR_STATUS.label },
              ),
              default: () => row.world.error,
            },
          )
        }
        return '—'
      }
      return h(
        NTag,
        { size: 'small', bordered: false, type: statusTagType(enabled ? 'success' : 'neutral') },
        { default: () => (enabled ? '已开启' : '未开启') },
      )
    },
  },
  {
    title: '地上世界',
    key: 'master',
    render: (row) => {
      const master = row.world.master
      return master ? renderShardStatusTag(master) : '—'
    },
  },
  {
    title: '洞穴服务器',
    key: 'caves',
    render: (row) => {
      const caves = row.world.caves
      return caves ? renderShardStatusTag(caves) : '—'
    },
  },
  {
    title: '操作',
    key: 'actions',
    width: 120,
    fixed: 'right',
    render: row => h(
      NButton,
      {
        size: 'small',
        type: 'info',
        text: true,
        disabled: row.instance.status === 'pending_install',
        onClick: () => openSettings(row.instance.id),
      },
      { default: () => '配置世界' },
    ),
  },
]

function openSettings(instanceId: string) {
  router.push(routeToDstWorldSettings(instanceId))
}

function goToInstanceManagement() {
  router.push(routeToNodeInstance())
}

async function loadRows() {
  await runLoad(async () => {
    const response = await apiDstSummary.getWorldSummaries()
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
        世界列表
      </h1>
      <p class="mt-1 text-sm text-muted-foreground">
        查看地上与洞穴世界的运行状态；洞穴开启后可在此调整端口、地图与世界规则。
      </p>
    </div>

    <AdminListToolbar
      v-model:keyword="keywordFilter"
      keyword-placeholder="实例名称"
      :search-loading="loading"
      :reset-disabled="!keywordFilter"
      @search="() => {}"
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
        :scroll-x="860"
      />
      <div v-else class="space-y-3" :aria-busy="loading">
        <article
          v-for="row in filteredRows"
          :key="row.instance.id"
          class="rounded-lg border border-border bg-card p-4 space-y-3"
        >
          <div class="flex items-start justify-between gap-3">
            <h2 class="min-w-0 truncate font-medium">
              {{ row.instance.name }}
            </h2>
            <NTag size="small" :bordered="false" :type="statusTagType(getInstanceState(row.instance).tone)">
              {{ getInstanceState(row.instance).label }}
            </NTag>
          </div>
          <dl class="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <div>
              <dt class="text-muted-foreground">洞穴功能</dt>
              <dd>{{ row.world.clusterShardEnabled === null ? '—' : row.world.clusterShardEnabled ? '已开启' : '未开启' }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">地上世界</dt>
              <dd>{{ shardStatusText(row, 'master') }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground">洞穴服务器</dt>
              <dd>{{ shardStatusText(row, 'caves') }}</dd>
            </div>
            <div v-if="row.world.error" class="col-span-2 text-amber-600 dark:text-amber-400">
              {{ row.world.error }}
            </div>
          </dl>
          <NButton block :disabled="row.instance.status === 'pending_install'" @click="openSettings(row.instance.id)">
            配置世界
          </NButton>
        </article>
      </div>
    </template>
    <div
      v-else-if="showFilteredEmpty"
      class="text-muted-foreground py-12 text-center text-sm"
    >
      没有匹配「{{ keywordFilter }}」的世界，请调整关键词或重置筛选。
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
