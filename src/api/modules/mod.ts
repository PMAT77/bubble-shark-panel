import type {
  ModBatchUpdatePayload,
  ModConfigDto,
  ModConfigPayload,
  ModConfigSaveResult,
  ModDeleteResult,
  ModDownloadQueueDto,
  ModInstallJobDto,
  ModInstallPayload,
  ModListDto,
  ModMutationResult,
  ModReorderPayload,
  ModReorderResult,
  ModUpdateCheckPayload,
  ModUpdateCheckResult,
  SteamModListQueryResult,
  SteamModDetailDto,
  ModContentLocale,
  SteamModSort,
  SteamModTrendDays,
  ModUpdatePayload,
} from '../../../shared/contracts/mod'
import api from '../index'

export type {
  ModBatchUpdatePayload,
  ModConfigDefinition,
  ModConfigDto,
  ModConfigOption,
  ModConfigPayload,
  ModConfigSaveResult,
  ModConfigValues,
  ModDeleteResult,
  ModDownloadQueueDto,
  ModDownloadQueueStatus,
  ModInstallJobDto,
  ModInstallJobPhase,
  ModInstallJobStatus,
  ModInstallPayload,
  ModInstallStatus,
  ModItemDto,
  ModListDto,
  ModMutationResult,
  ModReorderPayload,
  ModReorderResult,
  ModUpdateCheckPayload,
  ModUpdateCheckResult,
  ModUpdateCheckSummary,
  ModUpdateInfo,
  ModUpdateStatus,
  SteamModListQueryResultItem,
  SteamModListMeta,
  SteamModListQueryResult,
  SteamModDetailDto,
  ModContentLocale,
  SteamModSort,
  SteamModTrendDays,
  ModUpdatePayload,
} from '../../../shared/contracts/mod'

const MOD_INSTALL_JOB_POLL_INTERVAL_MS = 2000

function createAbortError(): Error {
  const error = new Error('Mod 安装任务轮询已取消')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal)
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      globalThis.clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(createAbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isModInstallJobTerminal(status: ModInstallJobDto['status']): boolean {
  return status === 'success' || status === 'failed' || status === 'not_found'
}

export default {
  getModList: (instanceId: string, options?: { enrich?: string }) =>
    api.get(`app/instances/${instanceId}/mods`, {
      params: options?.enrich ? { enrich: options.enrich } : undefined,
    }) as Promise<{ data: ModListDto }>,
  getSteamModList: (
    instanceId: string,
    params?: {
      keyword?: string
      page?: number
      pageSize?: number
      sort?: SteamModSort
      trendDays?: SteamModTrendDays
    },
    options?: {
      signal?: AbortSignal
    },
  ) => api.get(`app/instances/${instanceId}/mods/steam`, {
    params,
    signal: options?.signal,
    // 单独给超时：后端对上游的总预算是 10 秒，走到降级也会在这个量级返回结果。
    // 沿用全局 60 秒的话，上游被干扰时用户要对着转圈等一分钟才知道「连不上」。
    timeout: 15_000,
  }) as Promise<{ data: SteamModListQueryResult }>,
  getSteamModDetail: (
    instanceId: string,
    workshopId: string,
    options?: { locale?: ModContentLocale },
  ) => api.get(`app/instances/${instanceId}/mods/steam/${workshopId}`, {
    params: options?.locale ? { locale: options.locale } : undefined,
  }) as Promise<{ data: SteamModDetailDto }>,
  installMod: (instanceId: string, payload: ModInstallPayload) =>
    api.post(`app/instances/${instanceId}/mods/install`, payload) as Promise<{ data: ModInstallJobDto }>,
  batchUpdateMods: (instanceId: string, payload: ModBatchUpdatePayload) =>
    api.post(`app/instances/${instanceId}/mods/batch-update`, payload) as Promise<{ data: ModInstallJobDto[] }>,
  checkModUpdates: (instanceId: string, payload?: ModUpdateCheckPayload) =>
    api.post(`app/instances/${instanceId}/mods/check-updates`, payload ?? {}) as Promise<{ data: ModUpdateCheckResult }>,
  getModInstallJob: (instanceId: string, workshopId: string) =>
    api.get(`app/instances/${instanceId}/mods/install-jobs/${workshopId}`) as Promise<{ data: ModInstallJobDto }>,
  listModInstallJobs: (instanceId: string, workshopIds?: string[]) =>
    api.get(`app/instances/${instanceId}/mods/install-jobs`, {
      params: workshopIds?.length ? { workshopIds: workshopIds.join(',') } : undefined,
    }) as Promise<{ data: ModInstallJobDto[] }>,
  pollModInstallJob: async (
    instanceId: string,
    workshopId: string,
    options?: {
      intervalMs?: number
      onUpdate?: (job: ModInstallJobDto) => void
      signal?: AbortSignal
    },
  ): Promise<ModInstallJobDto> => {
    const intervalMs = options?.intervalMs ?? MOD_INSTALL_JOB_POLL_INTERVAL_MS
    while (true) {
      throwIfAborted(options?.signal)
      const { data } = await api.get(`app/instances/${instanceId}/mods/install-jobs/${workshopId}`, {
        signal: options?.signal,
      }) as { data: ModInstallJobDto }
      options?.onUpdate?.(data)
      if (isModInstallJobTerminal(data.status)) {
        return data
      }
      await sleep(intervalMs, options?.signal)
    }
  },
  updateMod: (instanceId: string, modId: string, payload: ModUpdatePayload) =>
    api.put(`app/instances/${instanceId}/mods/${modId}`, payload) as Promise<{ data: ModMutationResult }>,
  getModConfig: (instanceId: string, modId: string) =>
    api.get(`app/instances/${instanceId}/mods/${modId}/config`) as Promise<{ data: ModConfigDto }>,
  updateModConfig: (instanceId: string, modId: string, payload: ModConfigPayload) =>
    api.put(`app/instances/${instanceId}/mods/${modId}/config`, payload) as Promise<{ data: ModConfigSaveResult }>,
  reorderMods: (instanceId: string, payload: ModReorderPayload) =>
    api.put(`app/instances/${instanceId}/mods/reorder`, payload) as Promise<{ data: ModReorderResult }>,
  /** 实例级下载队列状态：前端只轮询这一个接口，不再为每个 Mod 各起一个轮询 */
  getModDownloadQueue: (instanceId: string) =>
    api.get(`app/instances/${instanceId}/mods/download-queue`) as Promise<{ data: ModDownloadQueueDto }>,
  startModDownloadQueue: (instanceId: string) =>
    api.post(`app/instances/${instanceId}/mods/download-queue/start`, {}) as Promise<{ data: ModDownloadQueueDto }>,
  pauseModDownloadQueue: (instanceId: string) =>
    api.post(`app/instances/${instanceId}/mods/download-queue/pause`, {}) as Promise<{ data: ModDownloadQueueDto }>,
  cancelModDownloadQueue: (instanceId: string) =>
    api.post(`app/instances/${instanceId}/mods/download-queue/cancel`, {}) as Promise<{ data: ModDownloadQueueDto }>,
  deleteMod: (instanceId: string, modId: string) =>
    api.delete(`app/instances/${instanceId}/mods/${modId}`) as Promise<{ data: ModDeleteResult }>,
}
