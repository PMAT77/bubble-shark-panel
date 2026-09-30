import type { MaybeRefOrGetter } from 'vue'
import type {
  ModDownloadQueueDto,
  ModInstallJobDto,
  ModInstallJobPhase,
  ModInstallPayload,
  ModItemDto,
  ModListDto,
} from '@/api/modules/mod'
import { computed, onScopeDispose, ref, shallowRef, toValue } from 'vue'
import apiMod from '@/api/modules/mod'
import { createModDownloadQueuePoller, shouldPollModDownloadQueue } from './modDownloadQueuePoller'
import type { ModDownloadQueuePoller } from './modDownloadQueuePoller'

export interface ModInstallHandlers {
  onUpdate?: (job: ModInstallJobDto) => void
  onTerminal?: (job: ModInstallJobDto) => void
  /**
   * 队列进度变化（成功/失败数或运行状态变了）时回调。
   *
   * 批量场景不再逐 Mod 轮询，调用方靠这一个回调重新拉列表即可。
   */
  onQueueChange?: (queue: ModDownloadQueueDto) => void
}

/**
 * 实例 Mod 状态。
 *
 * 下载进度只有一个来源——实例级队列接口：整页只留一个 3 秒轮询器，
 * 不再为每个 pending Mod 各起一个轮询（迁移包带进来几十个 Mod 时，
 * 那是每秒十几个请求，还会把后端的同步 DB/文件操作一起带崩）。
 *
 * 例外只有一处：用户显式订阅某个 Mod 时，为它单独轮询一次任务状态，
 * 这样按钮能立刻给出「订阅中 → 成功/失败」的反馈。
 */
export function useInstanceModState(instanceId: MaybeRefOrGetter<string>) {
  const optimisticWorkshopIds = ref<Set<string>>(new Set())
  const activeInstallJobs = ref<ModInstallJobDto[]>([])
  const pendingModRecords = ref<ModItemDto[]>([])
  const downloadQueue = ref<ModDownloadQueueDto | null>(null)

  const singleJobPollers = new Map<string, AbortController>()
  let queuePoller: ModDownloadQueuePoller | null = null
  let handlersRef = shallowRef<ModInstallHandlers | undefined>(undefined)
  let lastQueueSignature = ''

  const pendingWorkshopIds = computed(() => {
    const ids = new Set(optimisticWorkshopIds.value)
    for (const mod of pendingModRecords.value) {
      if (mod.installStatus === 'pending') {
        ids.add(mod.workshopId)
      }
    }
    const queue = downloadQueue.value
    if (queue) {
      for (const workshopId of [...queue.currentWorkshopIds, ...queue.queueWorkshopIds]) {
        ids.add(workshopId)
      }
    }
    return ids
  })

  const subscribingPhases = computed(() => {
    const phases = new Map<string, ModInstallJobPhase>()
    const queue = downloadQueue.value
    if (queue) {
      for (const workshopId of queue.queueWorkshopIds) {
        phases.set(workshopId, 'waiting_steamcmd')
      }
      for (const workshopId of queue.currentWorkshopIds) {
        phases.set(workshopId, 'downloading')
      }
    }
    return phases
  })

  const downloadingMods = computed(() => {
    const byWorkshopId = new Map<string, ModItemDto>()
    for (const mod of pendingModRecords.value) {
      if (mod.installStatus === 'pending') {
        byWorkshopId.set(mod.workshopId, mod)
      }
    }
    const queue = downloadQueue.value
    if (queue) {
      for (const workshopId of [...queue.currentWorkshopIds, ...queue.queueWorkshopIds]) {
        if (byWorkshopId.has(workshopId)) {
          continue
        }
        byWorkshopId.set(workshopId, {
          id: workshopId,
          workshopId,
          name: `Workshop Mod ${workshopId}`,
          previewImage: null,
          rating: null,
          enabled: false,
          loadOrder: 0,
          version: null,
          installStatus: 'pending',
          installError: null,
          localUpdatedAt: null,
          remoteUpdatedAt: null,
          updateCheckedAt: null,
          updateStatus: 'unknown',
          dependencyIds: [],
          missingDependencyIds: [],
          dependentModIds: [],
          createdAt: queue.startedAt ?? '',
          updatedAt: queue.updatedAt ?? '',
        })
      }
    }
    return [...byWorkshopId.values()]
  })

  function resolveInstanceId(): string {
    return toValue(instanceId).trim()
  }

  function getPollerKey(targetInstanceId: string, workshopId: string): string {
    return `${targetInstanceId}:${workshopId}`
  }

  function getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
      return error.message
    }
    if (typeof error === 'object' && error && 'error' in error) {
      return String((error as { error?: unknown }).error ?? '订阅失败，请稍后重试')
    }
    return '订阅失败，请稍后重试'
  }

  function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
  }

  function buildQueueSignature(queue: ModDownloadQueueDto): string {
    return `${queue.status}:${queue.success}:${queue.failed}`
  }

  /**
   * 收敛乐观标记：一旦队列或列表能表达这个 Mod 的状态，就不再靠本地猜测。
   *
   * 批量更新（一次性几十个）没有逐个 Mod 的轮询，标记不会像以前那样在任务终态时被清掉；
   * 不收敛的话，Mod 早已就绪、界面还会一直显示「订阅中」，按钮也跟着算错。
   */
  function reconcileOptimisticIds() {
    if (optimisticWorkshopIds.value.size === 0) {
      return
    }
    const queue = downloadQueue.value
    const tracked = new Set<string>([
      ...(queue?.currentWorkshopIds ?? []),
      ...(queue?.queueWorkshopIds ?? []),
      ...pendingModRecords.value.map(mod => mod.workshopId),
    ])
    const next = new Set<string>()
    for (const workshopId of optimisticWorkshopIds.value) {
      if (tracked.has(workshopId)) {
        next.add(workshopId)
      }
    }
    if (next.size !== optimisticWorkshopIds.value.size) {
      optimisticWorkshopIds.value = next
    }
  }

  function applyQueue(queue: ModDownloadQueueDto) {
    downloadQueue.value = queue
    reconcileOptimisticIds()
    syncQueuePolling()
    const signature = buildQueueSignature(queue)
    if (signature === lastQueueSignature) {
      return
    }
    lastQueueSignature = signature
    handlersRef.value?.onQueueChange?.(queue)
  }

  /** 待下载的 Mod 数：列表里的 pending 加上「刚点订阅、列表还没刷新」的乐观标记 */
  function countPendingIds(): number {
    const ids = new Set(optimisticWorkshopIds.value)
    for (const mod of pendingModRecords.value) {
      if (mod.installStatus === 'pending') {
        ids.add(mod.workshopId)
      }
    }
    return ids.size
  }

  /**
   * 按当前状态决定轮询启停：队列空闲且没有待下载项时停下，
   * 否则「全部就绪」的实例上会一直挂着 3 秒一次的请求。
   */
  function syncQueuePolling() {
    if (shouldPollModDownloadQueue({
      status: downloadQueue.value?.status ?? null,
      pendingCount: countPendingIds(),
    })) {
      startQueuePolling()
      return
    }
    stopQueuePolling()
  }

  function stopQueuePolling() {
    queuePoller?.stop()
    queuePoller = null
  }

  function startQueuePolling() {
    const id = resolveInstanceId()
    if (!id) {
      return
    }
    if (queuePoller?.isRunning()) {
      return
    }
    queuePoller = createModDownloadQueuePoller({
      fetchQueue: async () => {
        const { data } = await apiMod.getModDownloadQueue(id)
        return data
      },
      onUpdate: applyQueue,
      isVisible: () => (typeof document === 'undefined'
        ? true
        : document.visibilityState !== 'hidden'),
    })
    queuePoller.start()
  }

  function stopBackgroundPolling() {
    stopQueuePolling()
    for (const controller of singleJobPollers.values()) {
      controller.abort()
    }
    singleJobPollers.clear()
    lastQueueSignature = ''
  }

  function finalizeJobState(job: ModInstallJobDto) {
    activeInstallJobs.value = activeInstallJobs.value.filter(
      item => item.workshopId !== job.workshopId,
    )
    if (job.status === 'downloading') {
      activeInstallJobs.value = [...activeInstallJobs.value, job]
      return
    }
    clearOptimistic(job.workshopId)
    if (job.status === 'failed') {
      const existing = pendingModRecords.value.some(mod => mod.workshopId === job.workshopId)
      pendingModRecords.value = existing
        ? pendingModRecords.value.map(mod => (
            mod.workshopId === job.workshopId
              ? { ...mod, installStatus: 'failed', installError: job.error }
              : mod
          ))
        : pendingModRecords.value
      return
    }
    if (job.status === 'success') {
      pendingModRecords.value = pendingModRecords.value.filter(
        mod => mod.workshopId !== job.workshopId,
      )
    }
  }

  function clearOptimistic(workshopId: string) {
    if (!optimisticWorkshopIds.value.has(workshopId)) {
      return
    }
    const next = new Set(optimisticWorkshopIds.value)
    next.delete(workshopId)
    optimisticWorkshopIds.value = next
  }

  function isPendingWorkshop(workshopId: string): boolean {
    return pendingWorkshopIds.value.has(workshopId)
  }

  function resolveSubscribeButtonText(workshopId: string, subscribed: boolean): string {
    if (subscribed) {
      return '取消订阅'
    }
    if (isPendingWorkshop(workshopId)) {
      return '订阅中'
    }
    return '订阅'
  }

  /** 单 Mod 轮询：只用于用户显式订阅/更新的那一个 Mod */
  function resumeBackgroundPoll(workshopId: string, handlers?: ModInstallHandlers) {
    const id = resolveInstanceId()
    const pollerKey = getPollerKey(id, workshopId)
    if (!id || singleJobPollers.has(pollerKey)) {
      return
    }
    const controller = new AbortController()
    singleJobPollers.set(pollerKey, controller)
    void (async () => {
      try {
        const job = await apiMod.pollModInstallJob(id, workshopId, {
          signal: controller.signal,
          onUpdate: (current) => {
            if (current.status === 'downloading') {
              activeInstallJobs.value = [...activeInstallJobs.value, current]
            }
            else {
              finalizeJobState(current)
            }
            handlers?.onUpdate?.(current)
          },
        })
        finalizeJobState(job)
        handlers?.onTerminal?.(job)
      }
      catch (error) {
        if (isAbortError(error)) {
          return
        }
        const job: ModInstallJobDto = {
          instanceId: id,
          workshopId,
          status: 'failed',
          phase: null,
          error: getErrorMessage(error),
          startedAt: null,
          finishedAt: new Date().toISOString(),
        }
        finalizeJobState(job)
        handlers?.onTerminal?.(job)
      }
      finally {
        if (singleJobPollers.get(pollerKey) === controller) {
          singleJobPollers.delete(pollerKey)
        }
      }
    })()
  }

  async function refreshQueue() {
    const id = resolveInstanceId()
    if (!id) {
      downloadQueue.value = null
      return
    }
    try {
      const { data } = await apiMod.getModDownloadQueue(id)
      applyQueue(data)
    }
    catch {
      // 队列状态取不到不影响列表渲染：等下一次轮询
    }
  }

  async function restoreInstallJobs(handlers?: ModInstallHandlers & {
    modList?: ModListDto
  }) {
    const id = resolveInstanceId()
    if (!id) {
      stopBackgroundPolling()
      optimisticWorkshopIds.value = new Set()
      activeInstallJobs.value = []
      pendingModRecords.value = []
      downloadQueue.value = null
      return
    }
    handlersRef.value = handlers
    let mods = handlers?.modList?.mods ?? []
    if (!handlers?.modList) {
      const { data } = await apiMod.getModList(id)
      mods = data.mods
    }
    pendingModRecords.value = mods.filter(
      mod => mod.installStatus === 'pending' || mod.installStatus === 'failed',
    )
    // 列表是权威状态：乐观标记只在「刚点订阅、列表还没刷新」的窗口里有意义
    optimisticWorkshopIds.value = new Set()
    await refreshQueue()
    // 有待下载项或队列在跑才轮询；全部就绪时不必挂着 3 秒一次的请求
    syncQueuePolling()
  }

  async function installMod(payload: ModInstallPayload, handlers?: ModInstallHandlers) {
    const id = resolveInstanceId()
    if (!id) {
      throw new Error('实例 ID 不能为空')
    }
    handlersRef.value = handlers
    const next = new Set(optimisticWorkshopIds.value)
    next.add(payload.workshopId)
    optimisticWorkshopIds.value = next
    syncQueuePolling()
    try {
      const { data: initialJob } = await apiMod.installMod(id, payload)
      activeInstallJobs.value = [...activeInstallJobs.value, initialJob]
      if (initialJob.status === 'downloading') {
        resumeBackgroundPoll(payload.workshopId, handlers)
        return initialJob
      }
      finalizeJobState(initialJob)
      handlers?.onTerminal?.(initialJob)
      return initialJob
    }
    catch (error) {
      const failedJob: ModInstallJobDto = {
        instanceId: id,
        workshopId: payload.workshopId,
        status: 'failed',
        phase: null,
        error: getErrorMessage(error),
        startedAt: null,
        finishedAt: new Date().toISOString(),
      }
      finalizeJobState(failedJob)
      handlers?.onTerminal?.(failedJob)
      throw error
    }
  }

  /**
   * 批量任务（批量更新、导入后的补齐）只标记为等待中并交给队列轮询：
   * 以前这里会为每个 id 各起一个轮询，30 个 Mod 就是 30 条长轮询。
   */
  function syncPendingWorkshopIds(ids: string[], handlers?: ModInstallHandlers) {
    const id = resolveInstanceId()
    if (!id) {
      return
    }
    handlersRef.value = handlers
    const next = new Set(optimisticWorkshopIds.value)
    for (const workshopId of ids) {
      next.add(workshopId)
    }
    optimisticWorkshopIds.value = next
    syncQueuePolling()
  }

  function resetState() {
    stopBackgroundPolling()
    optimisticWorkshopIds.value = new Set()
    activeInstallJobs.value = []
    pendingModRecords.value = []
    downloadQueue.value = null
    handlersRef.value = undefined
  }

  onScopeDispose(stopBackgroundPolling)

  return {
    subscribingWorkshopIds: optimisticWorkshopIds,
    subscribingPhases,
    activeInstallJobs,
    pendingModRecords,
    pendingWorkshopIds,
    downloadingMods,
    downloadQueue,
    isPendingWorkshop,
    resolveSubscribeButtonText,
    restoreInstallJobs,
    installMod,
    resumeBackgroundPoll,
    syncPendingWorkshopIds,
    refreshQueue,
    resetState,
    stopBackgroundPolling,
  }
}
