<script setup lang="ts">
import type { PanelPortSync, PanelSettingsPayload, PanelUpdateStatus } from '@/api/modules/system'
import { h } from 'vue'
import { NAlert, NCollapse, NCollapseItem, NInputNumber, NSelect, NSpin, useDialog } from 'naive-ui'
import AdminSettingsSection from '@/components/AdminSettingsSection.vue'
import ConfigActionBar from '@/components/ConfigActionBar.vue'
import NotifyPanel from './notify.vue'
import OperationAuditSection from './OperationAuditSection.vue'
import SelfCheckCard from './SelfCheckCard.vue'
import SystemSettingsTabs from './SystemSettingsTabs.vue'
import apiSystem from '@/api/modules/system'
import { copyTextToClipboard } from '@/utils/copyToClipboard'
import { buildPanelUpdatePresentation, MANUAL_UPDATE_NOTE } from './panelUpdatePresentation'

defineOptions({
  name: 'SystemSettings',
})

const loading = ref(false)
const dialog = useDialog()

// 面板设置是写权限：只读账号（游客角色）能看这一页，但保存与面板更新入口不给
const { auth: hasPermission } = useAppAuth()

const appSettingsStore = useAppSettingsStore()
const settingsLoaded = ref(false)
const settingsLoadError = ref<string | null>(null)
const saveLoading = ref(false)
const updateStatusLoading = ref(false)
const downloadLoading = ref(false)
const installLoading = ref(false)
const updateStatus = ref<Awaited<ReturnType<typeof apiSystem.getPanelUpdateStatus>>['data'] | null>(null)

/**
 * 同一个输入框在不同部署形态下管的其实是两个东西，文案必须跟着变，否则就是自相矛盾：
 * - 生产部署：面板对外提供服务的端口（实际值由服务端按发布端口 / 代理头 / Host 判定）；
 * - 本地开发：前端开发服务器（Vite）的端口——保存后由后端写进 panel.env 的 VITE_DEV_WEB_PORT，
 *   此时浏览器地址栏的端口就是它，两者本就该一致。
 * 此前两种情况共用生产文案，于是出现「输入框 8888、旁边却写着当前访问端口 9527」这种
 * 看起来像有两个面板端口的画面。
 */
const isProductionDeployment = ref(true)

/** 面板实际监听的端口（仅生产部署下有唯一含义），由服务端给出 */
const actualPanelPort = ref<number | null>(null)

/** 本地开发时浏览器地址栏的端口就是 Vite 端口，直接读它比猜更准 */
function resolveBrowserAccessPort(): number {
  if (typeof window === 'undefined') {
    return 80
  }
  const parsed = Number.parseInt(window.location.port, 10)
  if (!Number.isNaN(parsed)) {
    return parsed
  }
  return window.location.protocol === 'https:' ? 443 : 80
}

const portFieldTitle = computed(() => (isProductionDeployment.value ? '面板端口' : '前端开发服务器端口'))
/** 只有服务器部署才需要解释这是什么端口；本地开发看标题「前端开发服务器端口」已经足够 */
const portFieldDescription = computed(() => (isProductionDeployment.value ? '面板对外提供服务的端口。' : undefined))

/** 服务器上保存会真的写进部署配置，本地则由重启开发服务器决定 */
const portRestartHint = computed(() => (isProductionDeployment.value
  ? '保存后会写入服务器配置，重启面板后生效；请记得在安全组或防火墙放行新端口。'
  : '修改端口保存后，需重启面板才能生效。'))

/** 正在生效的端口：生产看服务端判定值，本地开发就是浏览器所在的 Vite 端口 */
const activePort = computed(() => (isProductionDeployment.value ? actualPanelPort.value : resolveBrowserAccessPort()))

const form = reactive<PanelSettingsPayload>({
  panelPort: 9527,
  theme: 'system',
  autoUpdate: true,
  checkUpdateBeforeStart: false,
  updateCheckIntervalHours: 3,
  updateSource: 'auto',
})

const themeOptions = [
  { label: '跟随系统', value: 'system' },
  { label: '浅色', value: 'light' },
  { label: '深色', value: 'dark' },
]

const updateSourceOptions = [
  { label: '自动（推荐）', value: 'auto' },
  { label: '仅下载更新包', value: 'offline' },
  { label: '仅在线获取', value: 'pull' },
]

const updateSourceHint = computed(() => {
  switch (form.updateSource) {
    case 'offline':
      return '只下载更新包，拿不到时不会自动改成在线获取。'
    case 'pull':
      return '直接在线获取更新，不下载更新包。'
    default:
      return '优先下载更新包，拿不到时自动改为在线获取。'
  }
})

/** 远端快照：加载/保存成功后更新，用于脏状态判定 */
const savedSnapshot = ref('')
const settingsDirty = computed(() =>
  savedSnapshot.value !== '' && JSON.stringify({ ...form }) !== savedSnapshot.value,
)

const formattedLastCheckedAt = computed(() => formatDisplayDateTime(updateStatus.value?.lastCheckedAt ?? null))
const normalizedCheckError = computed(() => normalizeCheckError(updateStatus.value?.checkError ?? null))

const updateView = computed(() => buildPanelUpdatePresentation(updateStatus.value))
const releaseUrl = computed(() => updateStatus.value?.release?.htmlUrl?.trim() || null)
const manualUpdateCommand = computed(() => updateStatus.value?.manualUpdateCommand?.trim() || null)
const needsManualUpdate = computed(() => updateView.value.needsManualCommand)
const updateButtonLoading = computed(() => downloadLoading.value || installLoading.value)
const updateButtonDisabled = computed(() => {
  const action = updateView.value.action
  return action === 'none' || action === 'busy' || updateButtonLoading.value
})

/** 同一个按钮承担两段：镜像没下完就下载，下完了就安装 */
function handleUpdateAction() {
  if (updateView.value.action === 'install') {
    confirmInstallUpdate()
    return
  }
  void downloadUpdate()
}

const releaseMetaLine = computed(() => {
  const checkedAt = formattedLastCheckedAt.value
  return checkedAt ? `上次检查：${checkedAt}` : null
})

function formatDisplayDateTime(value: string | null): string | null {
  if (!value) {
    return null
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(parsed)
}

function normalizeCheckError(value: string | null): string | null {
  if (!value) {
    return null
  }
  const parts = value
    .split(/[；;\n]+/)
    .map(item => item.trim())
    .filter(Boolean)
  if (parts.length === 0) {
    return null
  }
  return [...new Set(parts)].join('；')
}

async function copyUpdateCommand(command: string, label: string) {
  const value = command.trim()
  if (!value) {
    faToast.warning('暂无可复制的命令')
    return
  }
  const ok = await copyTextToClipboard(value)
  if (!ok) {
    faToast.error('复制失败，请手动选中命令文本复制')
    return
  }
  faToast.success(`${label}已复制`)
}

async function loadSettings(options?: { silent?: boolean }) {
  if (!options?.silent) {
    loading.value = true
  }
  try {
    const res = await apiSystem.getSettings()
    const data = res.data
    form.panelPort = data.panelPort
    actualPanelPort.value = data.apiPort
    isProductionDeployment.value = data.isProduction
    form.theme = data.theme
    form.autoUpdate = data.autoUpdate
    form.checkUpdateBeforeStart = data.checkUpdateBeforeStart ?? false
    form.updateCheckIntervalHours = data.updateCheckIntervalHours ?? 3
    form.updateSource = data.updateSource ?? 'auto'
    savedSnapshot.value = JSON.stringify({ ...form })
    settingsLoaded.value = true
    settingsLoadError.value = null
  }
  catch (error) {
    if (!settingsLoaded.value) {
      const detail = error instanceof Error && error.message ? `：${error.message}` : ''
      settingsLoadError.value = `加载系统设置失败${detail}`
    }
    else if (!options?.silent) {
      faToast.error('刷新失败，请重试。')
    }
  }
  finally {
    if (!options?.silent) {
      loading.value = false
    }
  }
}

async function loadUpdateStatus(options?: { silent?: boolean }): Promise<boolean> {
  try {
    const res = await apiSystem.getPanelUpdateStatus()
    updateStatus.value = res.data
    return true
  }
  catch {
    // 轮询期间（silent）请求失败通常意味着面板正在重启：保留上一次状态，界面才不会闪成"无法获取"
    if (!options?.silent) {
      updateStatus.value = null
    }
    return false
  }
}

/** 连续轮询失败次数：面板重建/重启期间会持续失败，超过上限就停止并提示手动刷新 */
let updatePollFailures = 0
const UPDATE_POLL_INTERVAL_MS = 3000
// 6 分钟：容器重建通常几秒就绪，而 Native 更新要下载、安装并重启面板服务，
// 上限太紧会在更新尚未结束时停掉轮询，让用户以为卡住了。
const UPDATE_POLL_MAX_FAILURES = 120

/** 上一次轮询到的阶段，用于在「下载完成」这一刻提示用户去点安装 */
let previousUpdatePhase: PanelUpdateStatus['updatePhase'] | null = null

/**
 * 更新进度轮询：下载与安装接口都是立即返回，真正的镜像拉取与重建在后台跑，
 * 界面靠这里拿到 preparing / downloading / downloaded / installing / recreating / failed 各阶段。
 */
const updatePoller = usePollingTask(async () => {
  const reachable = await loadUpdateStatus({ silent: true })
  if (!reachable) {
    updatePollFailures += 1
    if (updatePollFailures === 5) {
      faToast.info('面板正在重启，恢复后本页会自动继续刷新。')
    }
    if (updatePollFailures >= UPDATE_POLL_MAX_FAILURES) {
      updatePoller.stop()
      faToast.warning('等待面板重启超时，请手动刷新本页查看结果。')
    }
    return
  }
  updatePollFailures = 0
  const phase = updateStatus.value?.updatePhase
  if (phase === 'downloaded' && previousUpdatePhase === 'downloading') {
    faToast.success('更新已下载，点「立即安装」完成更新。')
  }
  previousUpdatePhase = phase ?? null
  // downloaded 是等用户点「立即安装」的静默态，不必继续轮询
  if (!phase || phase === 'idle' || phase === 'failed' || phase === 'downloaded') {
    updatePoller.stop()
    if (phase === 'failed') {
      faToast.error('更新失败，请查看「面板与游戏版本」区块中的提示')
    }
  }
}, { intervalMs: UPDATE_POLL_INTERVAL_MS })

const offlineUpdateCommand = computed(() => updateStatus.value?.offlineImageCommand?.trim() || null)

const targetImageHint = computed(() => {
  const status = updateStatus.value
  // 下载完成时阶段说明已经说了「点击立即安装」，这里不再重复
  if (!status?.targetImageReady || !status.targetImage || status.updatePhase === 'downloaded') {
    return null
  }
  return '更新包已就绪，安装时无需再次下载。'
})

onBeforeUnmount(() => {
  updatePoller.stop()
})

async function checkHubUpdate() {
  updateStatusLoading.value = true
  try {
    const res = await apiSystem.checkPanelUpdate()
    updateStatus.value = res.data
    if (normalizeCheckError(res.data.checkError)) {
      faToast.warning('暂时无法完成版本检查，请查看下方提示')
    }
    else if (res.data.image.updateAvailable) {
      faToast.info('检测到新版本')
    }
    else {
      faToast.success('已是最新版本')
    }
  }
  finally {
    updateStatusLoading.value = false
  }
}

/** 下载段：只把镜像拉到本地，不打断面板，因此不需要二次确认 */
async function downloadUpdate() {
  downloadLoading.value = true
  try {
    const res = await apiSystem.applyPanelUpdate({ action: 'download' })
    faToast.success(res.data.message)
    await loadUpdateStatus({ silent: true })
    updatePollFailures = 0
    // 后端返回值是主判据；再兜一层刚读到的最新状态，接口口径变化时界面不会停在原地
    if (res.data.status === 'updating' || updateStatus.value?.updating) {
      updatePoller.start()
    }
  }
  catch (error) {
    faToast.error(error instanceof Error ? error.message : '启动下载失败')
  }
  finally {
    downloadLoading.value = false
  }
}

function confirmInstallUpdate() {
  dialog.warning({
    title: '确认安装更新',
    content: '安装时面板会短暂无法访问，游戏服务器不受影响。是否继续？',
    positiveText: '立即安装',
    negativeText: '取消',
    onPositiveClick: () => {
      void installUpdate()
    },
  })
}

/** 安装段：重建面板容器，面板会用刚下载的镜像重新启动 */
async function installUpdate() {
  installLoading.value = true
  try {
    const res = await apiSystem.applyPanelUpdate({ action: 'install' })
    faToast.success(res.data.message)
    await loadUpdateStatus({ silent: true })
    updatePollFailures = 0
    // 后端返回值是主判据；再兜一层刚读到的最新状态，接口口径变化时界面不会停在原地
    if (res.data.status === 'updating' || updateStatus.value?.updating) {
      updatePoller.start()
    }
  }
  catch (error) {
    faToast.error(error instanceof Error ? error.message : '安装更新失败')
  }
  finally {
    installLoading.value = false
  }
}

/**
 * 端口保存后，把「部署配置到底改没改」如实告诉用户：
 * 写进去了就提醒放行新端口，写不进去就把命令摊开；无需处理的情况不打扰。
 */
function notifyPortSyncResult(result: PanelPortSync | null) {
  if (!result || result.status === 'unchanged' || result.status === 'skipped') {
    return
  }
  if (result.status === 'written') {
    faToast.info(`面板将在下次重启后使用 ${result.port} 端口，请先在安全组或防火墙放行`)
    return
  }
  const children = [h('p', { class: 'text-sm' }, result.message)]
  if (result.manualCommand) {
    children.push(h('pre', { class: 'rounded bg-black/5 p-2 text-xs whitespace-pre-wrap break-all' }, result.manualCommand))
  }
  dialog.warning({
    title: '端口配置需要手动修改',
    content: () => h('div', { class: 'space-y-2' }, children),
    positiveText: '知道了',
  })
}

async function saveSettings() {
  if (!settingsLoaded.value || loading.value) {
    faToast.warning('设置尚未加载完成，请稍后重试。')
    return
  }
  if (!Number.isInteger(form.panelPort) || form.panelPort <= 0 || form.panelPort > 65535) {
    faToast.warning('端口号无效，请输入 1-65535 之间的数字')
    return
  }
  if (!Number.isInteger(form.updateCheckIntervalHours) || form.updateCheckIntervalHours < 1 || form.updateCheckIntervalHours > 168) {
    faToast.warning('更新检查间隔应为 1-168 小时')
    return
  }
  saveLoading.value = true
  try {
    const res = await apiSystem.saveSettings({
      panelPort: form.panelPort,
      theme: form.theme,
      autoUpdate: form.autoUpdate,
      checkUpdateBeforeStart: form.checkUpdateBeforeStart,
      updateCheckIntervalHours: form.updateCheckIntervalHours,
      updateSource: form.updateSource,
    })
    appSettingsStore.setColorScheme(form.theme === 'system' ? '' : form.theme)
    faToast.success('系统设置已保存')
    notifyPortSyncResult(res.data.portSync)
    await loadSettings({ silent: true })
  }
  finally {
    saveLoading.value = false
  }
}

/**
 * 更新进行中的状态可能是上一次会话留下的（刷新页面、面板刚重启完）：
 * 只加载一次状态而不恢复轮询，界面会一直停在「更新中」直到用户手动再点一次。
 */
async function resumeUpdatePollingIfNeeded() {
  if (updateStatus.value?.updating) {
    updatePollFailures = 0
    updatePoller.start()
  }
}

onMounted(async () => {
  /**
   * 没有「查看面板设置」权限时一个请求都不发。
   *
   * 这一页对「查看操作记录」权限也开着（菜单是任一语义），那种账号进来只该看到
   * 操作记录 tab——tab 已经按权限过滤，这里再把首屏请求也拦掉，免得刷出一串 403
   * 并让 `settingsLoadError` 把内容区变成错误提示。
   */
  if (!hasPermission('settings:read')) {
    return
  }
  await Promise.all([loadSettings(), loadUpdateStatus()])
  await resumeUpdatePollingIfNeeded()
})
</script>

<template>
  <FaPageMain class="h-full gap-4">
    <div>
      <h2 class="m-0 text-lg font-semibold">
        系统设置
      </h2> 
    </div>
    <SystemSettingsTabs>
      <template #settings>
        <!--
          加载态与失败态收在「面板设置」这个 tab 里面，而不是顶掉整页。

          为什么：菜单对「系统设置」是任一语义，只勾「查看操作记录」的账号也进得来。
          此前这两个请求（settings:read）失败后整页显示"无法加载系统设置"，
          于是**有操作记录权限的账号反而看不到操作记录**——自己有权的那一屏也被挡住了。
        -->
        <NSpin v-if="loading" size="large" class="block mx-auto my-8" />
        <div v-else-if="settingsLoadError || !settingsLoaded" class="space-y-4" role="alert">
          <NAlert type="error" title="无法加载系统设置">
            {{ settingsLoadError ?? '当前设置不可用，请重新加载后再编辑。' }}
          </NAlert>
          <FaButton :loading="loading" @click="loadSettings">
            重试加载
          </FaButton>
        </div>
        <div v-else class="space-y-6">
            <AdminSettingsSection
              :title="portFieldTitle"
              :description="portFieldDescription"
            >
              <!-- 只在「保存的端口还没生效」时提示；两者一致时不必多言 -->
              <p
                v-if="activePort !== null && activePort !== form.panelPort"
                class="text-sm text-muted-foreground"
              >
                当前实际端口：{{ activePort }}
              </p>
              <NInputNumber v-model:value="form.panelPort" :min="1" :max="65535" class="max-w-80 mt-3" placeholder="请输入端口号" />
              <p class="text-xs text-muted-foreground mt-2">
                {{ portRestartHint }}
              </p>
            </AdminSettingsSection>

            <AdminSettingsSection
              title="界面主题"
              description="保存后立即生效。"
            >
              <NSelect v-model:value="form.theme" :options="themeOptions" class="max-w-80" />
            </AdminSettingsSection>

            <AdminSettingsSection
              title="面板与游戏版本"
            >
              <div v-if="updateStatus" class="space-y-2 text-sm">
                <p class="font-medium">
                  {{ updateView.versionLine }}
                </p>
                <p v-if="updateView.progressText" class="text-xs text-muted-foreground tabular-nums">
                  {{ updateView.progressText }}
                </p>
                <p
                  v-if="updateView.phaseLine"
                  class="text-xs whitespace-pre-wrap"
                  :class="updateView.updateFailed ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'"
                >
                  {{ updateView.phaseLine }}
                </p>
                <p v-if="targetImageHint" class="text-xs text-muted-foreground">
                  {{ targetImageHint }}
                </p>
                <p v-if="releaseMetaLine" class="text-xs text-muted-foreground">
                  {{ releaseMetaLine }}
                  <a
                    v-if="releaseUrl"
                    :href="releaseUrl"
                    target="_blank"
                    rel="noopener"
                    class="ml-1 text-primary hover:underline"
                  >
                    更新说明
                  </a>
                </p>
                <p v-if="normalizedCheckError" class="text-xs text-amber-600 dark:text-amber-400">
                  检查提示：{{ normalizedCheckError }}
                </p>
              </div>
              <div v-else class="text-sm text-muted-foreground">
                暂时无法获取版本信息，点「检查更新」重试
              </div>

              <div class="space-y-2 pt-1">
                <div v-if="hasPermission('settings:write')" class="flex flex-wrap gap-2">
                  <FaButton
                    :loading="updateButtonLoading"
                    :disabled="updateButtonDisabled"
                    @click="handleUpdateAction"
                  >
                    {{ updateView.actionLabel }}
                  </FaButton>
                  <FaButton variant="outline" :loading="updateStatusLoading" @click="checkHubUpdate">
                    检查更新
                  </FaButton>
                </div>
                <div v-if="needsManualUpdate" class="space-y-2 text-xs">
                  <p class="text-amber-600 dark:text-amber-400">{{ MANUAL_UPDATE_NOTE }}</p>
                  <div v-if="manualUpdateCommand" class="flex flex-wrap gap-2 items-start">
                    <pre class="text-xs bg-muted overflow-x-auto p-3 rounded-md">{{ manualUpdateCommand }}</pre>
                    <FaButton
                      variant="outline"
                      size="sm"
                      @click="copyUpdateCommand(manualUpdateCommand ?? '', '更新命令')"
                    >
                      复制
                    </FaButton>
                  </div>
                </div>
              </div>

              <div v-if="updateStatus?.runtimeMode !== 'native'" class="space-y-2 max-w-80 pt-1">
                <label class="text-sm text-muted-foreground">更新下载源</label>
                <NSelect v-model:value="form.updateSource" :options="updateSourceOptions" />
                <p class="text-xs text-muted-foreground">
                  {{ updateSourceHint }}
                </p>
              </div>

              <NCollapse v-if="offlineUpdateCommand" class="pt-1">
                <NCollapseItem title="面板下载失败？手动导入更新包" name="offline-update">
                  <div class="space-y-2 text-sm">
                    <p class="text-xs text-muted-foreground">
                      在能联网的电脑上下载更新包，再导入这台服务器：
                    </p>
                    <pre class="text-xs bg-muted overflow-x-auto p-3 rounded-md">{{ offlineUpdateCommand }}</pre>
                    <div class="flex flex-wrap gap-2 items-center">
                      <FaButton
                        variant="outline"
                        size="sm"
                        @click="copyUpdateCommand(offlineUpdateCommand ?? '', '离线更新命令')"
                      >
                        复制
                      </FaButton>
                      <span class="text-xs text-muted-foreground">
                        导入后点「下载更新」即可安装。
                      </span>
                    </div>
                  </div>
                </NCollapseItem>
              </NCollapse>
            </AdminSettingsSection>

            <AdminSettingsSection
              title="自动检查更新"
            >
              <div class="flex gap-3 items-center">
                <FaSwitch v-model="form.autoUpdate" />
              </div>
              <div class="space-y-2 max-w-80">
                <label class="text-sm text-muted-foreground">检查间隔（小时）</label>
                <NInputNumber v-model:value="form.updateCheckIntervalHours" :min="1" :max="168" placeholder="1-168" class="w-full" />
              </div>
            </AdminSettingsSection>

            <AdminSettingsSection
              title="启动前检查游戏更新"
            >
              <div class="flex gap-3 items-center">
                <FaSwitch v-model="form.checkUpdateBeforeStart" />
              </div>
            </AdminSettingsSection>

            <AdminSettingsSection
              title="环境自检"
            >
              <SelfCheckCard />
            </AdminSettingsSection>

            <ConfigActionBar
              v-if="hasPermission('settings:write')"
              :dirty="settingsDirty"
              :busy="saveLoading"
              :saving="saveLoading"
              :show-restart="false"
              save-label="保存设置"
              @reset="loadSettings"
              @save="saveSettings"
            />
        </div>
      </template>

      <template #notify>
        <NotifyPanel />
      </template>

      <template #audit>
        <OperationAuditSection />
      </template>
    </SystemSettingsTabs>
  </FaPageMain>
</template>