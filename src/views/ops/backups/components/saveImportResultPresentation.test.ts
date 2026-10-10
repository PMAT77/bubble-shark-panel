import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { SaveImportResult } from '../../../../../shared/contracts/backup'
import { collectSaveImportNotices } from './saveImportResultPresentation.ts'

function result(overrides: Partial<SaveImportResult> = {}): SaveImportResult {
  return {
    isSuccess: true,
    importedShards: ['master', 'caves'],
    modCount: 0,
    missingWorkshopContent: [],
    tokenSource: 'existing',
    warnings: [],
    ...overrides,
  }
}

it('merges the covered token and Mod notices from both import paths', () => {
  for (const warnings of [
    [
      '未配置 Klei 集群令牌，公网游玩需在「房间设置」粘贴后才能被搜到',
      '33 个 Mod 文件尚未准备好，请在「Mod 管理 → 已订阅」处理缺失 Mod',
    ],
    [
      '未配置 Klei 集群令牌，公网游玩需在房间设置补填',
      '33 个 Mod 只恢复了配置，请在 Mod 页手动补齐文件',
    ],
  ]) {
    assert.deepEqual(collectSaveImportNotices(result({
      modCount: 33,
      missingWorkshopContent: Array.from({ length: 33 }, (_, index) => String(1000000000 + index)),
      tokenSource: 'none',
      warnings,
    })), { warnings: [], notes: [] })
  }
})

it('preserves failures and unfamiliar warnings, including similar wording and mismatched counts', () => {
  const warnings = [
    '源存档没有 Master 分片，导入后主世界无法启动',
    'Mod 列表写入面板数据库失败，请到 Mod 页面手动核对，否则下次同步可能丢失导入 Mod 配置',
    'Mod 配置文件同步失败，请到 Mod 页面手动核对后再启动实例',
    '未配置 Klei 集群令牌，请联系管理员检查权限',
    '2 个 Mod 文件尚未准备好，请在「Mod 管理 → 已订阅」处理缺失 Mod',
  ]
  assert.deepEqual(collectSaveImportNotices(result({
    tokenSource: 'none', missingWorkshopContent: ['123'], warnings,
  })), { warnings, notes: [] })
})

it('keeps known warnings when no dedicated reminder covers them', () => {
  const warnings = [
    '未配置 Klei 集群令牌，公网游玩需在房间设置补填',
    '1 个 Mod 只恢复了配置，请在 Mod 页手动补齐文件',
  ]
  assert.deepEqual(collectSaveImportNotices(result({ warnings })), { warnings, notes: [] })
  assert.deepEqual(collectSaveImportNotices(result()), { warnings: [], notes: [] })
})

it('shows confirmed port synchronization as a note without losing port details', () => {
  const portNote = '实例游戏端口已按本机配置重写为 10999（原档端口 11000）'
  const unknownWarning = '实例游戏端口同步失败，请检查端口配置'
  assert.deepEqual(collectSaveImportNotices(result({
    gamePortSynced: true, warnings: [portNote, unknownWarning],
  })), { warnings: [unknownWarning], notes: [portNote] })
  assert.deepEqual(collectSaveImportNotices(result({ warnings: [portNote] })), {
    warnings: [portNote], notes: [],
  })
})
