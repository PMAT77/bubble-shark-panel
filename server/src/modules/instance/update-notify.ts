import { emitPanelEvent } from '../notify/events'
import type { DbGameInstance } from '../../shared/db/index'

interface UpdateCheckResult {
  updateAvailable: boolean
  localBuildId: string | null
  remoteBuildId: string | null
  checkedAt: string
}

/**
 * 「无更新 → 有更新」跃迁时发布 update_available 事件（通知侧冷却窗口兜底重复推送）。
 * previous 为检查前的 DB 状态，current 为检查完成后的最新状态。
 */
export function maybeEmitUpdateAvailableEvent(
  previous: DbGameInstance,
  result: UpdateCheckResult,
  current: DbGameInstance | undefined,
): void {
  if (!result.updateAvailable || previous.updateAvailable === true) {
    return
  }
  const name = current?.name ?? previous.name
  emitPanelEvent({
    type: 'update_available',
    subjectId: previous.id,
    subjectName: name,
    message: '实例「' + name + '」的服务端版本或游戏文件需要更新（本地 ' + (result.localBuildId ?? '未知') + '，正式分支 ' + (result.remoteBuildId ?? '未知') + '）',
    severity: 'info',
    at: new Date().toISOString(),
  })
}
