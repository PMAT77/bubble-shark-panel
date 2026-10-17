import type { ModAccessObservation, ModDownloadQueueDto, ModDownloadQueueItemDto } from '../../../../../shared/contracts/mod'

export function resolveModDownloadItemLabel(item?: ModDownloadQueueItemDto, status?: ModDownloadQueueDto['status']) {
  if (item?.phase === 'failed') return '下载失败'
  if (status === 'paused' && item?.installStatus === 'pending') return '已暂停'
  if (item?.phase === 'verifying') return '下载完成，正在校验'
  if (item?.phase === 'installing') return '下载完成，正在安装'
  if (item?.phase === 'downloading') return item.progress ? item.progress.percent >= 100 ? '下载完成，正在校验' : `下载中 ${Math.floor(item.progress.percent)}%` : '下载中'
  return item?.phase === 'preparing_download' ? '准备下载' : item?.phase === 'preparing_steamcmd' ? '准备下载环境' : item?.phase === 'waiting_steamcmd' ? '等待其他任务' : item?.phase === 'retry_wait' ? '等待重试' : item?.phase === 'queued' ? '等待下载' : '待下载'
}

/** 只使用下载结果中已经明确的原因；未识别的输出留在技术信息中。 */
export function summarizeModDownloadFailure(error: string | null): string {
  if (error?.startsWith('SteamCMD 自更新超时')) return '下载环境准备超时，Mod 下载尚未开始。'
  if (error?.startsWith('Mod 下载超时') || error?.startsWith('Steam 请求超时')) return '下载超时。'
  if (error === 'Mod 下载失败：实例目录权限不足') return '实例目录权限不足，需由管理员处理。'
  if (error?.startsWith('无法下载该 Mod，请确认创意工坊 ID 有效且为公开 Mod')) return '无法下载该 Mod，请确认创意工坊 ID 有效且为公开 Mod。'
  if (error?.startsWith('Mod 文件未能安装到服务器目录：')) return 'Mod 文件未能安装到服务器目录。'
  if (error?.startsWith('文件已安装，但状态保存失败')) return '文件已安装，但状态保存失败。'
  return '下载未完成，具体原因请查看技术信息。'
}

export function resolveModDownloadHelp(queue: ModDownloadQueueDto | null, files?: ModAccessObservation) {
  const failed = queue?.items.filter(item => item.phase === 'failed') ?? []
  const errors = failed.map(item => item.error)
  if (queue?.lastError) errors.push(queue.lastError)
  const reasons = [...new Set(errors.map(summarizeModDownloadFailure))].slice(0, 3)
  if (queue?.status === 'running' && queue.phase === 'retry_wait') {
    return { summary: '部分 Mod 下载失败，正在等待自动重试。', reasons, retryHint: null }
  }
  if (failed.length || queue?.lastError) {
    return {
      summary: failed.length ? `${failed.length} 个 Mod 未完成下载。` : '本次下载未完成。',
      reasons,
      retryHint: reasons.some(reason => reason.includes('目录权限不足')) ? '请先由管理员处理目录权限，再点击失败条目中的“重试”。'
        : failed.length > 1 ? '可点击失败条目中的“重试”，或使用“重试全部失败”。'
        : failed.length ? '可点击失败条目中的“重试”。'
        : queue && queue.eligibleCount > 0 && queue.status !== 'running' && queue.status !== 'pausing' ? `可点击上方的“${queue.status === 'paused' ? '恢复下载' : '开始下载'}”。` : null,
    }
  }
  if (queue?.status === 'pausing') return { summary: '正在暂停下载，未完成项会保留。', reasons: [], retryHint: null }
  if (queue?.status === 'paused') return { summary: '下载已暂停，未完成项仍可恢复下载。', reasons: [], retryHint: null }
  if (queue?.status === 'running') return { summary: queue.phase === 'waiting_steamcmd' ? '正在等待其他安装或下载任务完成。'
    : queue.phase === 'preparing_steamcmd' || queue.phase === 'preparing_download' ? '正在准备下载环境。'
      : queue.phase === 'verifying' ? '正在校验 Mod 文件。' : queue.phase === 'installing' ? '正在安装 Mod 文件。' : '正在下载 Mod。', reasons: [], retryHint: null }
  if (queue?.success || queue?.startedAt || files?.status === 'success') return { summary: '当前没有下载失败的 Mod。', reasons: [], retryHint: null }
  if (files?.status === 'failed') return { summary: '最近一次文件下载未完成。', reasons: [summarizeModDownloadFailure(files.message)], retryHint: null }
  if (files?.status === 'cancelled') return { summary: '上次下载已取消，未完成项仍可继续下载。', reasons: [], retryHint: null }
  return { summary: '尚无下载记录。', reasons: [], retryHint: null }
}

/** 工具栏始终只提供一个下载控制；停止完成前不允许启动第二个任务。 */
export function resolveModDownloadAction(queue: ModDownloadQueueDto | null): {
  action: 'start' | 'pause'
  label: string
  disabled: boolean
} | null {
  if (!queue) return null
  if (queue.status === 'running') return { action: 'pause', label: '暂停下载', disabled: false }
  if (queue.status === 'pausing') return { action: 'pause', label: '正在暂停…', disabled: true }
  if (queue.eligibleCount > 0) return { action: 'start', label: queue.status === 'paused' ? '恢复下载' : '开始下载', disabled: false }
  return null
}
