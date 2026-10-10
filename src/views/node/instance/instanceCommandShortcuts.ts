import type { ClusterGameMode } from '@/api/modules/cluster'

/** DST 游戏模式英文 → 中文（cluster.gameMode 枚举全覆盖，未知值兜底展示原文） */
export const DST_GAME_MODE_LABELS: Record<ClusterGameMode, string> = {
  survival: '生存',
  endless: '无尽',
  wilderness: '荒野',
  easy: '轻松',
  darkandwildernes: '黑暗荒野',
}

/** DST 官方四季英文 → 中文（Mod 自定义季节兜底展示原文） */
export const DST_SEASON_LABELS: Record<string, string> = {
  autumn: '秋季',
  winter: '冬季',
  spring: '春季',
  summer: '夏季',
}

export function dstGameModeLabel(mode: ClusterGameMode | null | undefined): string {
  if (!mode) {
    return '—'
  }
  return DST_GAME_MODE_LABELS[mode] ?? mode
}

export function dstSeasonLabel(season: string | null | undefined): string {
  if (!season) {
    return '—'
  }
  return DST_SEASON_LABELS[season] ?? season
}
