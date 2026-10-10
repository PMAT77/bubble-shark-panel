import type { SaveImportResult } from '../../../../../shared/contracts/backup'

/** 只合并已被结果区覆盖的已知提示；其他警告仍完整展示。 */
export function collectSaveImportNotices(result: SaveImportResult) {
  const coveredWarnings = new Set<string>()
  if (result.tokenSource === 'none') {
    coveredWarnings.add('未配置 Klei 集群令牌，公网游玩需在「房间设置」粘贴后才能被搜到')
    coveredWarnings.add('未配置 Klei 集群令牌，公网游玩需在房间设置补填')
  }
  const missingCount = result.missingWorkshopContent.length
  if (missingCount > 0) {
    coveredWarnings.add(`${missingCount} 个 Mod 文件尚未准备好，请在「Mod 管理 → 已订阅」处理缺失 Mod`)
    coveredWarnings.add(`${missingCount} 个 Mod 只恢复了配置，请在 Mod 页手动补齐文件`)
  }

  const warnings: string[] = []
  const notes: string[] = []
  for (const warning of result.warnings) {
    if (coveredWarnings.has(warning)) continue
    if (result.gamePortSynced && /^实例游戏端口已按本机配置重写为 \d+（原档端口 \d+）$/.test(warning)) {
      notes.push(warning)
    }
    else {
      warnings.push(warning)
    }
  }
  return { warnings, notes }
}
