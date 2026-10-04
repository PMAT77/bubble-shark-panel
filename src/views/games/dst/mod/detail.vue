<script setup lang="ts">
import type { SteamModDetailDto } from '@/api/modules/mod'
import dayjs from 'dayjs'
import {
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NEmpty,
  NImage,
  NScrollbar,
  NSpin,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { resolveModLocalizedText } from '../../../../../shared/contracts/mod'
import AdminSettingsSection from '@/components/AdminSettingsSection.vue'
import apiMod from '@/api/modules/mod'
import { useInstanceModState } from '@/composables/useInstanceModState'
import { useModContentLocale } from '@/composables/useModContentLocale'
import { routeToDstModList } from '@/navigation/game-routes'

defineOptions({
  name: 'DstModDetail',
})

interface BusinessErrorLike {
  error?: string
  code?: string
}

const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const { auth: hasPermission } = useAppAuth()
const { locale: contentLocale } = useModContentLocale()
const unsubscribing = ref(false)

const loading = ref(true)
const detail = ref<SteamModDetailDto | null>(null)
let detailRequest = 0

const workshopId = computed(() => String(route.params.workshopId ?? '').trim())
const instanceId = computed(() => {
  const queryValue = route.query.instanceId
  return typeof queryValue === 'string' ? queryValue.trim() : ''
})

const {
  isPendingWorkshop,
  restoreInstallJobs,
  installMod,
  resetState,
  downloadQueue,
} = useInstanceModState(() => instanceId.value)

const isDownloading = computed(() => isPendingWorkshop(workshopId.value))

const displayTitle = computed(() => {
  if (!detail.value) {
    return 'Mod 详情'
  }
  const resolved = resolveModLocalizedText(detail.value.titles, contentLocale.value)
  return resolved.value || detail.value.title
})

const displayDescription = computed(() => {
  if (!detail.value) {
    return ''
  }
  const resolved = resolveModLocalizedText(detail.value.descriptions, contentLocale.value)
  return resolved.value || detail.value.description
})

const isSubscribedReady = computed(() =>
  Boolean(detail.value && (detail.value.installed || detail.value.subscribeStatus === 'ready')),
)

const installButtonText = computed(() => {
  if (!detail.value) {
    return '订阅'
  }
  if (isSubscribedReady.value) {
    return '管理已订阅'
  }
  if (isDownloading.value) return pendingDownloadLabel()
  if (detail.value.subscribeStatus === 'pending') return '下载'
  if (detail.value.subscribeStatus === 'failed') {
    return '重试订阅'
  }
  return '订阅'
})

const installButtonDisabled = computed(() =>
  !detail.value
  || !instanceId.value
  || isDownloading.value,
)

function pendingDownloadLabel(): string {
  const phase = downloadQueue.value?.items.find(item => item.workshopId === workshopId.value)?.phase
  return phase === 'downloading' ? '下载中' : phase === 'waiting_steamcmd' ? '等待其他任务' : phase === 'retry_wait' ? '等待重试' : phase === 'queued' ? '等待下载' : '待下载'
}

function syncDetailFromQueue() {
  const item = downloadQueue.value?.items.find(item => item.workshopId === workshopId.value)
  if (!item || !detail.value || detail.value.workshopId !== workshopId.value) return
  if (item.installStatus === 'ready' && isDownloading.value) return
  detail.value = { ...detail.value, subscribed: true, subscribeStatus: item.installStatus, installed: item.installStatus === 'ready' }
}
watch(() => [downloadQueue.value, isDownloading.value], syncDetailFromQueue)

function formatDateTime(value: string | null): string {
  if (!value) {
    return '-'
  }
  return dayjs(value).format('YYYY-MM-DD HH:mm:ss')
}

function formatFileSize(bytes: number | null): string {
  if (bytes === null || bytes < 0) {
    return '-'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (typeof error === 'object' && error && 'error' in error) {
    const apiError = error as BusinessErrorLike
    if (apiError.error) {
      return apiError.error
    }
  }
  return fallback
}

function isAuthUnauthorizedError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as BusinessErrorLike).code === 'AUTH_UNAUTHORIZED'
}

function showSubscribeSuccessGuide() {
  message.success(hasPermission('mod:toggle') ? 'Mod 文件已准备好，可在已订阅列表开启，重启实例后生效。' : 'Mod 文件已准备好；开启时请联系有权限的管理员。')
}

/** 回到当前实例的本地管理，不依赖世界配置权限。 */
function goToEnableMod() {
  if (!instanceId.value) {
    return
  }
  router.push(routeToDstModList(instanceId.value, 'subscribed'))
}

function confirmUnsubscribe() {
  if (!detail.value || !instanceId.value) {
    return
  }
  dialog.warning({
    title: '取消订阅',
    content: `确定从当前实例取消订阅「${displayTitle.value}」吗？`,
    positiveText: '取消订阅',
    negativeText: '保留',
    onPositiveClick: async () => {
      unsubscribing.value = true
      try {
        await apiMod.deleteMod(instanceId.value, detail.value!.workshopId)
        message.success('已取消订阅')
        router.push(routeToDstModList(instanceId.value, 'subscribed'))
      }
      catch (error: unknown) {
        if (isAuthUnauthorizedError(error)) {
          return
        }
        message.error(getErrorMessage(error, '取消订阅失败，请稍后重试'))
      }
      finally {
        unsubscribing.value = false
      }
    },
  })
}

function renderSubscribeStatusLabel(): string {
  if (!detail.value) {
    return '未订阅'
  }
  if (detail.value.subscribeStatus === 'pending' || isDownloading.value) {
    return pendingDownloadLabel()
  }
  if (detail.value.subscribeStatus === 'failed') {
    return '已订阅 · 下载失败'
  }
  if (detail.value.subscribed || detail.value.installed) {
    return '已订阅'
  }
  return '未订阅'
}

function renderSubscribeStatusType(): 'default' | 'success' | 'warning' | 'error' {
  if (!detail.value) {
    return 'default'
  }
  if (detail.value.subscribeStatus === 'pending' || isDownloading.value) {
    return 'warning'
  }
  if (detail.value.subscribeStatus === 'failed') {
    return 'error'
  }
  if (detail.value.subscribed || detail.value.installed) {
    return 'success'
  }
  return 'default'
}

async function handleInstallJobTerminal(job: Awaited<ReturnType<typeof apiMod.pollModInstallJob>>) {
  if (job.status === 'success' && detail.value) {
    detail.value = {
      ...detail.value,
      subscribed: true,
      subscribeStatus: 'ready',
      installed: true,
    }
    showSubscribeSuccessGuide()
    return
  }
  if (job.status === 'failed' && detail.value) {
    detail.value = {
      ...detail.value,
      subscribed: true,
      subscribeStatus: 'failed',
      installed: false,
    }
    message.error(job.error || '订阅失败，请稍后重试')
    return
  }
  if (job.status === 'not_found') {
    await loadDetail()
  }
}

async function loadDetail() {
  const current = ++detailRequest
  const id = instanceId.value
  const itemId = workshopId.value
  if (!workshopId.value) {
    detail.value = null
    loading.value = false
    return
  }
  if (!instanceId.value) {
    detail.value = null
    loading.value = false
    return
  }
  loading.value = true
  try {
    const response = await apiMod.getSteamModDetail(id, itemId, {
      locale: contentLocale.value,
    })
    if (current !== detailRequest || id !== instanceId.value || itemId !== workshopId.value) return
    detail.value = response.data
    syncDetailFromQueue()
  }
  catch (error: unknown) {
    if (current !== detailRequest || id !== instanceId.value || itemId !== workshopId.value) return
    detail.value = null
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '加载 Mod 详情失败'))
  }
  finally {
    if (current === detailRequest) loading.value = false
  }
}

async function installModAction() {
  if (!detail.value || !instanceId.value || installButtonDisabled.value) {
    return
  }
  if (isSubscribedReady.value) {
    goToEnableMod()
    return
  }
  if (detail.value.subscribeStatus !== 'failed') {
    detail.value = {
      ...detail.value,
      subscribed: true,
      subscribeStatus: 'pending',
      installed: false,
    }
  }
  try {
    await installMod({
      workshopId: detail.value.workshopId,
      name: detail.value.title,
      previewImage: detail.value.previewImage ?? undefined,
    }, {
      onTerminal: job => void handleInstallJobTerminal(job),
    })
  }
  catch (error: unknown) {
    if (isAuthUnauthorizedError(error)) {
      return
    }
    message.error(getErrorMessage(error, '订阅失败，请稍后重试'))
  }
}

function goBack() {
  router.push(routeToDstModList(instanceId.value, 'subscribed'))
}

onMounted(async () => {
  if (!instanceId.value) {
    loading.value = false
    return
  }
  loading.value = true
  await Promise.all([
    restoreInstallJobs({
      onTerminal: job => void handleInstallJobTerminal(job),
    }),
    loadDetail(),
  ])
})

watch([instanceId, workshopId], async ([value]) => {
  detailRequest += 1
  detail.value = null
  resetState()
  if (value) {
    loading.value = true
    await Promise.all([
      restoreInstallJobs({
        onTerminal: job => void handleInstallJobTerminal(job),
      }),
      loadDetail(),
    ])
  }
})

watch(contentLocale, () => {
  if (!instanceId.value || !workshopId.value) {
    return
  }
  void loadDetail()
})
</script>

<template>
  <!-- 整屏工作台：高度用 layout 的内容区高度变量自撑，不再用 `absolute inset-0`（父级高度为 0 会把整页裁掉） -->
  <div class="dst-mod-detail-page flex h-[var(--g-main-content-height)] flex-col overflow-hidden p-4">
    <FaPageMain
      class="flex min-h-0 flex-1 flex-col overflow-hidden !m-0 h-full"
      main-class="flex min-h-0 flex-1 flex-col"
    >
      <template #title>
        <div class="flex flex-wrap items-center justify-between gap-4">
          <h1 class="text-lg font-semibold">
            {{ displayTitle }}
          </h1>
          <NButton quaternary @click="goBack">
            返回 Mod 列表
          </NButton>
        </div>
      </template>

      <NSpin v-if="loading" size="large" class="mx-auto my-8" />

      <NEmpty
        v-else-if="!instanceId"
        class="py-16"
        description="缺少实例信息，请从 Mod 列表进入详情页。"
      >
        <template #extra>
          <NButton @click="goBack">
            返回 Mod 列表
          </NButton>
        </template>
      </NEmpty>

      <NEmpty
        v-else-if="!detail"
        class="py-16"
        description="未能加载 Mod 详情，请稍后重试。"
      >
        <template #extra>
          <NButton @click="goBack">
            返回 Mod 列表
          </NButton>
          <NButton v-if="instanceId && workshopId" class="ml-2" @click="loadDetail">
            重试
          </NButton>
        </template>
      </NEmpty>

      <div v-else class="flex min-h-0 flex-1 flex-col gap-4">
        <NCard size="small" class="shrink-0">
          <AdminSettingsSection
            title="基本信息"
            description="创意工坊元数据与当前实例的订阅状态。"
          />
          <div class="mt-4 flex flex-col gap-4 lg:flex-row">
            <div class="shrink-0">
              <NImage
                v-if="detail.previewImage"
                :src="detail.previewImage"
                width="160"
                height="160"
                object-fit="cover"
                lazy
                class="rounded"
              />
              <div
                v-else
                class="flex size-40 items-center justify-center rounded bg-muted text-sm text-muted-foreground"
              >
                无缩略图
              </div>
            </div>

            <NDescriptions
              :column="1"
              label-placement="left"
              class="min-w-0 flex-1"
            >
              <NDescriptionsItem label="Mod 名称">
                {{ displayTitle }}
              </NDescriptionsItem>
              <NDescriptionsItem v-if="detail.cache" label="详情数据">
                {{ detail.cache.source === 'cache-offline' ? '离线缓存' : detail.cache.source === 'cache-fresh' ? '缓存' : '实时获取' }} · {{ formatDateTime(detail.cache.fetchedAt) }}
              </NDescriptionsItem>
              <NDescriptionsItem label="创作者">
                {{ detail.creatorName ?? '-' }}
              </NDescriptionsItem>
              <NDescriptionsItem label="创意工坊 ID">
                {{ detail.workshopId }}
              </NDescriptionsItem>
              <NDescriptionsItem label="文件大小">
                {{ formatFileSize(detail.fileSize) }}
              </NDescriptionsItem>
              <NDescriptionsItem label="标签">
                <div v-if="detail.tags.length > 0" class="flex flex-wrap gap-1">
                  <NTag
                    v-for="tag in detail.tags"
                    :key="tag"
                    size="small"
                    :bordered="false"
                  >
                    {{ tag }}
                  </NTag>
                </div>
                <span v-else class="text-muted-foreground">-</span>
              </NDescriptionsItem>
              <NDescriptionsItem label="发布时间">
                {{ formatDateTime(detail.publishedAt) }}
              </NDescriptionsItem>
              <NDescriptionsItem label="更新时间">
                {{ formatDateTime(detail.updatedAt) }}
              </NDescriptionsItem>
              <NDescriptionsItem label="订阅状态">
                <NTag
                  size="small"
                  :bordered="false"
                  :type="renderSubscribeStatusType()"
                >
                  {{ renderSubscribeStatusLabel() }}
                </NTag>
              </NDescriptionsItem>
            </NDescriptions>
          </div>
        </NCard>

        <NCard
          size="small"
          class="dst-mod-detail-desc-card flex min-h-0 flex-1 flex-col"
          content-class="flex min-h-0 flex-1 flex-col"
        >
          <AdminSettingsSection
            title="描述"
            description="创意工坊原文说明，用于确认 Mod 功能与兼容性。"
          />
          <NScrollbar class="mt-4 min-h-0 flex-1">
            <p
              v-if="displayDescription"
              class="whitespace-pre-wrap pr-3 text-sm leading-relaxed"
            >
              {{ displayDescription }}
            </p>
            <p v-else class="text-sm text-muted-foreground">
              暂无描述
            </p>
          </NScrollbar>
        </NCard>

        <div class="flex shrink-0 justify-center gap-2">
          <NButton
            v-if="isSubscribedReady || hasPermission('mod:install')"
            type="primary"
            :disabled="installButtonDisabled"
            @click="installModAction"
          >
            {{ installButtonText }}
          </NButton>
          <NButton
            v-if="isSubscribedReady && hasPermission('mod:install')"
            :loading="unsubscribing"
            @click="confirmUnsubscribe"
          >
            取消订阅
          </NButton>
          <NButton
            tag="a"
            :href="detail.detailUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            在 Steam 查看
          </NButton>
        </div>
      </div>
    </FaPageMain>
  </div>
</template>

<style scoped>
.dst-mod-detail-page :deep(.group\/pagemain) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.dst-mod-detail-desc-card :deep(.n-card-header) {
  flex-shrink: 0;
}

.dst-mod-detail-desc-card :deep(.n-card__content) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
</style>
