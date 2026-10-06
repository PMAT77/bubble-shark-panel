import type { ModDownloadQueueStatus, ModItemDto } from '@/api/modules/mod'

/**
 * 「更新」入口的目标筛选。
 *
 * 与按钮上的计数必须是同一口径：只按 `updateStatus` 数，会把正在下载中的 Mod 也算进
 * 「全部更新 (N)」，点下去却被「就绪且不在下载中」这一层过滤掉，于是提示
 * 「当前没有需要更新的 Mod」——按钮看起来能用，实际什么也没做。
 */
export function selectUpdatableMods(
  mods: ModItemDto[],
  isDownloading: (workshopId: string) => boolean,
): ModItemDto[] {
  return mods.filter(mod =>
    mod.installStatus === 'ready'
    && mod.updateStatus === 'outdated'
    && !isDownloading(mod.workshopId),
  )
}

/** 创意工坊上有新版本的 Mod 总数（含正在下载中的） */
export function countOutdatedMods(mods: ModItemDto[]): number {
  return mods.filter(mod => mod.updateStatus === 'outdated').length
}

/**
 * 队列自然跑完一轮后仍有可更新项：说明这次更新没让本机内容追平创意工坊。
 *
 * 典型表现是「点了全部更新，过一会儿又跳回全部更新 (N)」——用户只能反复点。
 * 这里负责把原因说清（SteamCMD 报告成功但内容没换、或工坊版本时间取不到），
 * 而不是静默回到原样。手动暂停不算：那是用户的主动选择。
 */
export function resolveUpdateIneffectiveNotice(input: {
  /** 上一刻队列是否在跑（用来识别「刚跑完一轮」这个时刻） */
  wasRunning: boolean
  status: ModDownloadQueueStatus
  updatableCount: number
}): string | null {
  if (!input.wasRunning || input.status !== 'idle' || input.updatableCount === 0) {
    return null
  }
  return `更新已执行，但仍有 ${input.updatableCount} 个 Mod 显示有新版本：本机内容没有追平创意工坊，请查看 SteamCMD 下载日志，检查网络和代理配置后重试。`
}
