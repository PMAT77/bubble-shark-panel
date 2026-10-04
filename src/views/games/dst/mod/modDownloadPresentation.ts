import type { ModAccessObservation, ModDownloadQueueDto } from '../../../../../shared/contracts/mod'

/** 只使用下载结果中已经明确的原因；未识别的输出留在技术信息中。 */
export function summarizeModDownloadFailure(error: string | null): string {
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
        : queue && queue.eligibleCount > 0 && queue.status !== 'running' && queue.status !== 'pausing' ? '可点击下载状态条中的“继续下载”。' : null,
    }
  }
  if (queue?.status === 'pausing') return { summary: '正在暂停下载，未完成项会保留。', reasons: [], retryHint: null }
  if (queue?.status === 'paused') return { summary: '下载已暂停，未完成项仍可继续下载。', reasons: [], retryHint: null }
  if (queue?.status === 'running') return { summary: queue.phase === 'waiting_steamcmd' ? '正在等待其他安装或下载任务完成。' : '正在下载 Mod。', reasons: [], retryHint: null }
  if (queue?.success || queue?.startedAt || files?.status === 'success') return { summary: '当前没有下载失败的 Mod。', reasons: [], retryHint: null }
  if (files?.status === 'failed') return { summary: '最近一次文件下载未完成。', reasons: [summarizeModDownloadFailure(files.message)], retryHint: null }
  if (files?.status === 'cancelled') return { summary: '上次下载已取消，未完成项仍可继续下载。', reasons: [], retryHint: null }
  return { summary: '尚无下载记录。', reasons: [], retryHint: null }
}

export function resolveModDownloadDetails(queue: ModDownloadQueueDto | null): string[] {
  if (!queue) return []
  if (queue.status === 'pausing') return [queue.phase === 'downloading' ? '当前下载完成后暂停，未完成项会保留。' : '正在暂停下载，未完成项会保留。']
  if (queue.status === 'running') {
    if (queue.phase === 'waiting_steamcmd') return ['轮到本次任务后开始下载。等待期间也可以暂停或取消。']
    if (queue.phase === 'retry_wait') return ['正在等待自动重试，未完成项会继续下载。']
    if (queue.currentWorkshopIds.length === 0) return ['正在准备下一批下载。']
    const batch = queue.currentBatchIndex > 0 ? `当前第 ${queue.currentBatchIndex} 批；` : ''
    return [
      `${batch}正在处理 ${queue.currentWorkshopIds.length} 个 Mod。`,
      '取消当前批次会停止本次下载并暂停，未完成项仍可继续下载。',
    ]
  }
  if (queue.status === 'paused') return [`未完成项已保留，还有 ${queue.eligibleCount} 个 Mod 未准备好。`]
  if (queue.eligibleCount > 0) return ['下载尚未开始。']
  return [`本次下载已结束：成功 ${queue.success} 个，失败 ${queue.failed} 个。`]
}
