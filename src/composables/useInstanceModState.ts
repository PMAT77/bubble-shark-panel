import type { MaybeRefOrGetter } from 'vue'
import type { ModDownloadQueueDto, ModInstallJobDto, ModInstallJobPhase, ModInstallPayload, ModItemDto, ModListDto } from '@/api/modules/mod'
import { computed, onScopeDispose, ref, toValue } from 'vue'
import apiMod from '@/api/modules/mod'
import { createModDownloadQueuePoller, shouldPollModDownloadQueue } from './modDownloadQueuePoller'
import type { ModDownloadQueuePoller } from './modDownloadQueuePoller'

export interface ModInstallHandlers {
  onUpdate?: (job: ModInstallJobDto) => void
  onTerminal?: (job: ModInstallJobDto) => void
  onQueueChange?: (queue: ModDownloadQueueDto) => void
}

/** 下载状态统一来自实例队列；请求失败只影响观察，不改写任务状态。 */
export function useInstanceModState(instanceId: MaybeRefOrGetter<string>) {
  const optimisticWorkshopIds = ref<Set<string>>(new Set())
  const activeInstallJobs = ref<ModInstallJobDto[]>([])
  const pendingModRecords = ref<ModItemDto[]>([])
  const downloadQueue = ref<ModDownloadQueueDto | null>(null)
  const handlersById = new Map<string, ModInstallHandlers | undefined>()
  const submittingIds = new Set<string>()
  let queueHandler: ModInstallHandlers['onQueueChange']
  let poller: ModDownloadQueuePoller | null = null
  let generation = 0
  let signature = ''
  let fetching: { id: string, promise: Promise<ModDownloadQueueDto> } | null = null
  const resolveId = () => toValue(instanceId).trim()
  function fetchQueue(id: string) {
    if (fetching?.id === id) return fetching.promise
    const promise = apiMod.getModDownloadQueue(id).then(({ data }) => data)
    const request = { id, promise }
    fetching = request
    void promise.finally(() => { if (fetching === request) fetching = null }).catch(() => {})
    return promise
  }

  const pendingWorkshopIds = computed(() => new Set([
    ...optimisticWorkshopIds.value,
    ...(downloadQueue.value?.currentWorkshopIds ?? []),
    ...(downloadQueue.value?.queueWorkshopIds ?? []),
  ]))
  const subscribingPhases = computed(() => {
    const phases = new Map<string, ModInstallJobPhase>()
    for (const item of downloadQueue.value?.items ?? []) {
      if (item.phase === 'downloading' || item.phase === 'waiting_steamcmd') phases.set(item.workshopId, item.phase)
      else if (item.phase === 'queued') phases.set(item.workshopId, 'waiting_steamcmd')
    }
    return phases
  })
  const downloadingMods = computed(() => pendingModRecords.value.filter(mod => mod.installStatus === 'pending' && pendingWorkshopIds.value.has(mod.workshopId)))

  function clearOptimistic(id: string) {
    optimisticWorkshopIds.value = new Set([...optimisticWorkshopIds.value].filter(value => value !== id))
  }
  function applyJob(job: ModInstallJobDto) {
    activeInstallJobs.value = activeInstallJobs.value.filter(item => item.workshopId !== job.workshopId)
    if (job.status === 'downloading') activeInstallJobs.value.push(job)
    else clearOptimistic(job.workshopId)
  }
  function applyQueue(queue: ModDownloadQueueDto) {
    downloadQueue.value = queue
    for (const item of queue.items) {
      if (submittingIds.has(item.workshopId)) continue
      const terminal = item.phase === 'ready' || item.phase === 'failed'
      if (terminal) clearOptimistic(item.workshopId)
      pendingModRecords.value = pendingModRecords.value.map(mod => mod.workshopId === item.workshopId
        ? { ...mod, installStatus: item.installStatus, installError: item.error } : mod)
      if (!handlersById.has(item.workshopId)) continue
      const job: ModInstallJobDto = { instanceId: queue.instanceId, workshopId: item.workshopId,
        status: item.phase === 'ready' ? 'success' : item.phase === 'failed' ? 'failed' : 'downloading',
        phase: item.phase === 'downloading' || item.phase === 'waiting_steamcmd' ? item.phase : null,
        error: item.error, startedAt: queue.startedAt, finishedAt: terminal ? queue.updatedAt : null }
      const handlers = handlersById.get(item.workshopId)
      applyJob(job)
      handlers?.onUpdate?.(job)
      if (terminal) { handlersById.delete(item.workshopId); handlers?.onTerminal?.(job) }
    }
    const next = `${queue.status}:${queue.success}:${queue.failed}`
    if (next !== signature) {
      const previous = signature
      signature = next
      if (previous) queueHandler?.(queue)
    }
    syncPolling()
  }
  function syncPolling() {
    const pendingCount = Math.max(downloadQueue.value?.eligibleCount ?? 0, optimisticWorkshopIds.value.size,
      pendingModRecords.value.filter(mod => mod.installStatus === 'pending').length)
    if (!shouldPollModDownloadQueue({ status: downloadQueue.value?.status ?? null, pendingCount })) {
      poller?.stop(); poller = null; return
    }
    if (poller?.isRunning() || !resolveId()) return
    const id = resolveId()
    const current = generation
    poller = createModDownloadQueuePoller({
      fetchQueue: () => fetchQueue(id),
      onUpdate: queue => { if (generation === current && resolveId() === id) applyQueue(queue) },
      getIntervalMs: () => downloadQueue.value?.status === 'running' || downloadQueue.value?.status === 'pausing' ? 3000 : 15000,
      isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    })
    poller.start()
  }
  async function refreshQueue() {
    const id = resolveId()
    const current = generation
    if (!id) return
    try {
      const data = await fetchQueue(id)
      if (current === generation && resolveId() === id) applyQueue(data)
    }
    catch { /* 下次观察再试，不将网络错误作为下载终态。 */ }
  }
  function stopBackgroundPolling() {
    generation += 1
    fetching = null
    poller?.stop(); poller = null
    handlersById.clear()
    submittingIds.clear()
    signature = ''
  }
  function resetState() {
    stopBackgroundPolling()
    optimisticWorkshopIds.value = new Set()
    activeInstallJobs.value = []
    pendingModRecords.value = []
    downloadQueue.value = null
    queueHandler = undefined
  }
  async function restoreInstallJobs(handlers?: ModInstallHandlers & { modList?: ModListDto }) {
    const id = resolveId()
    const current = generation
    if (!id) { resetState(); return }
    if (handlers?.onQueueChange) queueHandler = handlers.onQueueChange
    const data = handlers?.modList ?? (await apiMod.getModList(id)).data
    if (current !== generation || id !== resolveId()) return
    pendingModRecords.value = data.mods.filter(mod => mod.installStatus !== 'ready')
    await refreshQueue()
  }
  function resumeBackgroundPoll(id: string, handlers?: ModInstallHandlers) {
    handlersById.set(id, handlers)
    syncPolling()
  }
  function syncPendingWorkshopIds(ids: string[], handlers?: ModInstallHandlers) {
    if (handlers?.onQueueChange) queueHandler = handlers.onQueueChange
    optimisticWorkshopIds.value = new Set([...optimisticWorkshopIds.value, ...ids])
    syncPolling()
  }
  async function installMod(payload: ModInstallPayload, handlers?: ModInstallHandlers) {
    const id = resolveId()
    const current = generation
    if (!id) throw new Error('实例 ID 不能为空')
    if (handlers?.onQueueChange) queueHandler = handlers.onQueueChange
    optimisticWorkshopIds.value = new Set([...optimisticWorkshopIds.value, payload.workshopId])
    submittingIds.add(payload.workshopId)
    handlersById.set(payload.workshopId, handlers)
    try {
      const { data: job } = await apiMod.installMod(id, payload)
      if (current !== generation || id !== resolveId()) return job
      submittingIds.delete(payload.workshopId)
      applyJob(job)
      if (job.status !== 'downloading') {
        handlersById.delete(payload.workshopId)
        handlers?.onTerminal?.(job)
      }
      await refreshQueue()
      return job
    }
    catch (error) {
      if (current === generation) { submittingIds.delete(payload.workshopId); clearOptimistic(payload.workshopId); handlersById.delete(payload.workshopId) }
      throw error
    }
  }
  const isPendingWorkshop = (id: string) => pendingWorkshopIds.value.has(id)
  const resolveSubscribeButtonText = (id: string, subscribed: boolean) => subscribed ? '取消订阅' : isPendingWorkshop(id) ? '订阅中' : '订阅'
  onScopeDispose(stopBackgroundPolling)
  return { subscribingWorkshopIds: optimisticWorkshopIds, subscribingPhases, activeInstallJobs, pendingModRecords,
    pendingWorkshopIds, downloadingMods, downloadQueue, isPendingWorkshop, resolveSubscribeButtonText,
    restoreInstallJobs, installMod, resumeBackgroundPoll, syncPendingWorkshopIds, refreshQueue, resetState, stopBackgroundPolling }
}
