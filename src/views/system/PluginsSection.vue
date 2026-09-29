<script setup lang="ts">
import type { CommercialSupport, PluginAuditResult, PluginListItem, PluginListResult } from '@/api/modules/system'
import type { PluginCardActionView, PluginCardView } from './pluginStorePresentation'
import { NAlert, NButton, NInput, NSpin, NSwitch, NTabPane, NTabs, NTag, useDialog, useMessage } from 'naive-ui'
import { computed, onMounted, ref } from 'vue'
import apiSystem from '@/api/modules/system'
import { AUDIT_OUTCOME_META, formatAuditParams, formatAuditTime } from './auditDisplay'
import PluginDetailDialog from './components/PluginDetailDialog.vue'
import PluginImportDialog from './components/PluginImportDialog.vue'
import {
  buildPluginCard,
  capabilityLabel,
  dangerousCapabilityLabels,
  filterPluginCards,
  groupPluginCards,
  isDangerousCapability,
  resolveCardAction,
  summarizePlugins,
} from './pluginStorePresentation'

/**
 * 插件页 = 货架 + 已装管理台。
 *
 * 三个 tab 对应用户到这里来的三种目的：看自己装的东西在不在跑、找还没装的东西怎么拿、
 * 查插件到底调用过什么。合并成一条长列表就会让这三件事互相挡路。
 *
 * 两条口径纪律（改动前先确认仍成立）：
 * 1. **面板不是收银台**：这里没有下单、没有支付、没有自动下载。「订阅」只在
 *    服务端明确标为可获取的条目上出现，且只负责把人送到面板之外的人工渠道；
 * 2. **尚未开发的能力不给按钮**：`planned` 卡片只有说明，没有入口。
 *    给它配一个能点的按钮，无论叫什么，都是对用户的虚假承诺。
 *
 * 权限：启停、导入、卡片上的获取入口都要 `plugin:manage`——只读账号（游客角色）
 * 能看插件清单与调用记录，但一个都点不动。
 */
const { auth: hasPermission } = useAppAuth()

defineOptions({
  name: 'SystemPluginsSection',
})

/** 卡片视图模型：状态标签、操作按钮与提示文案都在构建时算好，模板只负责画 */
interface CardEntry {
  item: PluginListItem
  card: PluginCardView
  action: PluginCardActionView
}

const message = useMessage()
const dialog = useDialog()

const loading = ref(false)
const toggling = ref<string | null>(null)
const list = ref<PluginListResult | null>(null)
const audit = ref<PluginAuditResult | null>(null)
const errorMessage = ref<string | null>(null)
const keyword = ref('')
const activeTab = ref<'installed' | 'obtainable' | 'audit'>('installed')

const detailVisible = ref(false)
const detailItem = ref<PluginListItem | null>(null)
const importVisible = ref(false)

const support = ref<CommercialSupport | null>(null)
const supportLoading = ref(false)
const contactVisible = ref(false)

function toEntry(item: PluginListItem): CardEntry {
  return {
    item,
    card: buildPluginCard(item),
    action: resolveCardAction(item),
  }
}

const filtered = computed(() => filterPluginCards(list.value?.items ?? [], keyword.value))
const groups = computed(() => groupPluginCards(filtered.value).map(group => ({
  ...group,
  entries: group.items.map(toEntry),
})))
const installedEntries = computed(() => groups.value.find(group => group.key === 'installed')?.entries ?? [])
const shelfGroups = computed(() => groups.value.filter(group => group.key !== 'installed'))
const summary = computed(() => summarizePlugins(list.value?.items ?? []))
const installedCount = computed(() => installedEntries.value.length)
const shelfCount = computed(() => shelfGroups.value.reduce((total, group) => total + group.entries.length, 0))

async function loadPlugins() {
  loading.value = true
  errorMessage.value = null
  try {
    const [listResponse, auditResponse] = await Promise.all([
      apiSystem.getPluginList(),
      apiSystem.getPluginAudit({ limit: 30 }).catch(() => ({ data: null as PluginAuditResult | null })),
    ])
    list.value = listResponse.data
    audit.value = auditResponse.data
  }
  catch {
    list.value = null
    errorMessage.value = '暂时读不到插件列表，不影响面板的其它功能。'
  }
  finally {
    loading.value = false
  }
}

/**
 * 启停。
 *
 * 危险能力的确认文案与卡片上的提示来自同一个来源（`pluginStorePresentation`），
 * 两处各写一遍迟早会出现「卡片说会删备份、确认框只说会联网」这种漏报。
 */
async function applyToggle(item: PluginListItem, enabled: boolean) {
  toggling.value = item.id
  try {
    const { data } = await apiSystem.togglePlugin({ pluginId: item.id, enabled })
    message.success(data.message)
    await loadPlugins()
  }
  catch (error) {
    // 业务失败（缺授权、装载失败的原因）由拦截器统一提示，这里不重复弹一遍
    if (!(error && typeof error === 'object' && 'error' in error)) {
      message.error('操作失败：插件可能装载失败或缺少授权。')
    }
  }
  finally {
    toggling.value = null
  }
}

function handleToggle(item: PluginListItem, enabled: boolean) {
  if (!enabled || !item.hasDangerousCapabilities) {
    void applyToggle(item, enabled)
    return
  }
  const dangerous = dangerousCapabilityLabels(item.capabilities)
  dialog.warning({
    title: `启用「${item.name}」？`,
    content: `该插件申请了会影响实例或对外联网的能力：${dangerous.join('、')}。请确认插件来源可信。`,
    positiveText: '确认启用',
    negativeText: '取消',
    onPositiveClick: () => {
      void apiSystem.togglePlugin({ pluginId: item.id, enabled: true, acknowledgeDangerous: true })
        .then(async ({ data }) => {
          message.success(data.message)
          await loadPlugins()
        })
        .catch(() => {
          message.error('启用失败：请查看卡片上的状态说明。')
        })
    },
  })
}

function openDetail(item: PluginListItem) {
  detailItem.value = item
  detailVisible.value = true
}

/**
 * 订阅：把人送到面板之外的人工渠道。
 *
 * 配置了飞书就打开飞书，否则展开联系方式卡片（微信 / QQ 群）。
 * 面板**不**做下单与收款——这句话也写在卡片下方，避免用户以为点下去会进收银台。
 */
async function handleSubscribe() {
  supportLoading.value = true
  try {
    if (!support.value) {
      /**
       * 联系方式与购买入口来自 `/app/system/commercial`（license:read）。
       * 没有这个权限时不必发请求：直接展开本地联系方式卡片——
       * 用户点「订阅」的意图是"我要怎么联系你们"，而不是"看授权状态"。
       */
      if (!hasPermission('license:read')) {
        contactVisible.value = true
        return
      }
      const { data } = await apiSystem.getCommercialSupport()
      support.value = data
    }
    const feishu = support.value.contact.feishu?.trim()
    if (feishu) {
      window.open(feishu, '_blank', 'noopener,noreferrer')
      return
    }
    contactVisible.value = true
  }
  catch {
    message.error('暂时读不到联系方式，请稍后重试。')
  }
  finally {
    supportLoading.value = false
  }
}

function openRepository() {
  const repository = support.value?.contact.repository
  if (repository) {
    window.open(repository, '_blank', 'noopener,noreferrer')
  }
}

function handleImported(text: string) {
  message.success(text)
  void loadPlugins()
}

onMounted(loadPlugins)
</script>

<template>
  <div class="space-y-3">
    <p class="text-sm text-muted-foreground">
      插件以独立进程运行，崩溃或停用都不影响面板与正在运行的游戏实例。
    </p>

    <div v-if="list" class="rounded-md border px-3 py-2 text-xs text-muted-foreground break-all">
      插件目录：{{ list.pluginsRoot }}
    </div>

    <NAlert v-if="errorMessage" type="warning" :bordered="false">
      {{ errorMessage }}
    </NAlert>

    <div class="flex flex-wrap items-center gap-2">
      <NTag size="small" :bordered="false">
        已安装 {{ summary.installed }}
      </NTag>
      <NTag size="small" :bordered="false" :type="summary.running > 0 ? 'success' : 'default'">
        运行中 {{ summary.running }}
      </NTag>
      <NTag v-if="summary.missingLicense > 0" size="small" :bordered="false" type="warning">
        缺少授权 {{ summary.missingLicense }}
      </NTag>
      <NInput
        v-model:value="keyword"
        size="small"
        class="w-full sm:ml-auto sm:w-56"
        placeholder="搜索插件名称或标识"
        clearable
      />
      <NButton size="small" :loading="loading" @click="loadPlugins">
        刷新
      </NButton>
      <NButton size="small" type="primary" @click="importVisible = true" v-if="hasPermission('plugin:manage')">
        导入插件包
      </NButton>
    </div>

    <NTabs v-model:value="activeTab" type="line" animated>
      <NTabPane name="installed" :tab="`已安装 (${installedCount})`">
        <NSpin :show="loading">
          <p v-if="installedEntries.length === 0" class="text-sm text-muted-foreground">
            还没有安装任何插件。到「可获取」看看能装什么，或把插件包放进上面的目录。
          </p>

          <div v-else class="grid gap-2 lg:grid-cols-2">
            <div
              v-for="entry in installedEntries"
              :key="entry.item.id"
              class="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium">{{ entry.item.name }}</span>
                <span class="text-xs text-muted-foreground">{{ entry.item.id }} · {{ entry.item.version }}</span>
                <NTag size="small" :bordered="false" :type="entry.card.type">
                  {{ entry.card.label }}
                </NTag>
                <NTag v-if="entry.item.kind === 'commercial'" size="small" :bordered="false">
                  商业插件
                </NTag>
                <span class="ml-auto">
                  <NSwitch
                    v-if="hasPermission('plugin:manage')"
                    :value="entry.item.enabled"
                    :disabled="entry.item.state === 'invalid' || toggling === entry.item.id"
                    @update:value="value => handleToggle(entry.item, value)"
                  />
                  <NTag v-else size="small" :bordered="false">
                    {{ entry.item.enabled ? '已启用' : '已停用' }}
                  </NTag>
                </span>
              </div>

              <p v-if="entry.card.summary" class="text-xs text-muted-foreground">
                {{ entry.card.summary }}
              </p>

              <div class="flex flex-wrap items-center gap-1">
                <NTag size="tiny" :bordered="false">
                  {{ entry.item.signed ? `已签名：${entry.item.publisher ?? '未知发布方'}` : '未签名' }}
                </NTag>
                <NTag
                  v-for="capability in entry.item.capabilities"
                  :key="capability"
                  size="tiny"
                  :bordered="false"
                  :type="isDangerousCapability(capability) ? 'warning' : 'default'"
                >
                  {{ capabilityLabel(capability) }}
                </NTag>
              </div>

              <p v-if="entry.item.message" class="text-xs text-muted-foreground">
                {{ entry.item.message }}
              </p>

              <p
                v-if="entry.item.runtime.state === 'crashed' || entry.item.runtime.restarts > 0"
                class="text-xs text-rose-600 dark:text-rose-400"
              >
                <span v-if="entry.item.runtime.pid">进程 {{ entry.item.runtime.pid }}　</span>
                <span v-if="entry.item.runtime.restarts > 0">已尝试重启 {{ entry.item.runtime.restarts }} 次</span>
              </p>

              <div class="mt-auto flex items-center gap-2">
                <NButton size="tiny" @click="openDetail(entry.item)">
                  详情
                </NButton>
                <span class="text-xs text-muted-foreground">
                  {{ entry.item.enabled ? '停用即结束其进程' : '启用后立即启动' }}
                </span>
              </div>
            </div>
          </div>
        </NSpin>
      </NTabPane>

      <NTabPane name="obtainable" :tab="`可获取 (${shelfCount})`">
        <div class="mb-2 rounded-md border px-3 py-2 text-xs text-muted-foreground">
          {{ list?.storeNotice ?? '这里只列官方插件。' }}
        </div>

        <NAlert v-if="contactVisible && support" type="info" :bordered="false" class="mb-2">
          <div class="space-y-1 text-sm">
            <div class="font-medium">
              订阅与获取插件包
            </div>
            <div>微信：{{ support.contact.wechat }}</div>
            <div>QQ 群：{{ support.contact.qqGroup }}</div>
            <div v-if="support.contact.feishu" class="break-all">
              飞书：{{ support.contact.feishu }}
            </div>
            <div class="text-xs text-muted-foreground">
              {{ support.contact.noteHint }}
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs text-muted-foreground">付款与合同在面板之外完成，面板不提供下单与支付。</span>
              <NButton size="tiny" quaternary @click="openRepository">
                项目仓库与文档
              </NButton>
            </div>          </div>
        </NAlert>

        <NSpin :show="loading">
          <p v-if="shelfCount === 0" class="text-sm text-muted-foreground">
            {{ keyword ? '没有匹配的插件，换个关键词试试。' : '暂时没有可获取的插件。' }}
          </p>

          <div v-else class="space-y-4">
            <div v-for="group in shelfGroups" :key="group.key" class="space-y-2">
              <div>
                <div class="text-sm font-medium">
                  {{ group.title }}
                </div>
                <p class="text-xs text-muted-foreground">
                  {{ group.description }}
                </p>
              </div>

              <div class="grid gap-2 lg:grid-cols-2">
                <div
                  v-for="entry in group.entries"
                  :key="entry.item.id"
                  class="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm"
                >
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-medium">{{ entry.item.name }}</span>
                    <NTag size="small" :bordered="false" :type="entry.card.type">
                      {{ entry.card.label }}
                    </NTag>
                    <NTag v-if="entry.item.kind === 'commercial'" size="small" :bordered="false">
                      商业插件
                    </NTag>
                    <span class="text-xs text-muted-foreground">{{ entry.item.publisher ?? '来源未知' }}</span>
                  </div>

                  <p class="text-xs text-muted-foreground">
                    {{ entry.card.summary }}
                  </p>

                  <div class="flex flex-wrap items-center gap-1">
                    <NTag
                      v-for="capability in entry.item.capabilities"
                      :key="capability"
                      size="tiny"
                      :bordered="false"
                      :type="isDangerousCapability(capability) ? 'warning' : 'default'"
                    >
                      {{ capabilityLabel(capability) }}
                    </NTag>
                  </div>

                  <div class="mt-auto space-y-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <NButton size="tiny" @click="openDetail(entry.item)">
                        详情
                      </NButton>
                      <NButton
                        v-if="hasPermission('plugin:manage') && entry.action.action === 'subscribe'"
                        size="tiny"
                        type="primary"
                        :loading="supportLoading"
                        @click="handleSubscribe"
                      >
                        {{ entry.action.label }}
                      </NButton>
                      <NButton
                        v-else-if="hasPermission('plugin:manage') && entry.action.action === 'import'"
                        size="tiny"
                        type="primary"
                        @click="importVisible = true"
                      >
                        {{ entry.action.label }}
                      </NButton>
                    </div>
                    <p class="text-xs text-muted-foreground">
                      {{ entry.action.hint }}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </NSpin>
      </NTabPane>

      <NTabPane name="audit" tab="调用记录">
        <NSpin :show="loading">
          <div class="space-y-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium">插件调用记录</span>
              <span class="text-xs text-muted-foreground">面板侧记录，插件改不了；越权尝试也记下</span>
            </div>

            <p v-if="!audit || audit.records.length === 0" class="text-xs text-muted-foreground">
              还没有插件调用过面板的能力。
            </p>

            <template v-else>
              <ul class="space-y-1">
                <li
                  v-for="record in audit.records"
                  :key="`${record.at}-${record.id}`"
                  class="rounded-md border px-3 py-2 text-xs"
                >
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-muted-foreground">{{ formatAuditTime(record.at) }}</span>
                    <span class="font-medium">{{ record.pluginId }}</span>
                    <span>{{ record.action }}</span>
                    <NTag size="tiny" :bordered="false" :type="AUDIT_OUTCOME_META[record.outcome]?.type ?? 'default'">
                      {{ AUDIT_OUTCOME_META[record.outcome]?.label ?? record.outcome }}
                    </NTag>
                    <span class="text-muted-foreground">{{ record.durationMs }} ms</span>
                  </div>
                  <div v-if="formatAuditParams(record.params)" class="mt-1 text-muted-foreground break-all">
                    {{ formatAuditParams(record.params) }}
                  </div>
                  <div v-if="record.message" class="mt-1 text-muted-foreground">
                    {{ record.message }}
                  </div>
                </li>
              </ul>
              <p class="text-xs text-muted-foreground break-all">
                原始记录：{{ audit.auditRoot }}
              </p>
            </template>
          </div>
        </NSpin>
      </NTabPane>
    </NTabs>

    <PluginDetailDialog v-model:show="detailVisible" :item="detailItem" />
    <PluginImportDialog v-model:show="importVisible" @imported="handleImported" />
  </div>
</template>
