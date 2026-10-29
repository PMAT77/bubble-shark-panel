import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModDownloadQueueDto } from '../../../../../shared/contracts/mod.ts'
import { resolveModDownloadAction, resolveModDownloadHelp, resolveModDownloadItemLabel, summarizeModDownloadFailure } from './modDownloadPresentation.ts'

function queue(overrides: Partial<ModDownloadQueueDto> = {}): ModDownloadQueueDto {
  return { instanceId: 'test', status: 'idle', phase: null, items: [], eligibleCount: 0, inactiveMissingCount: 0,
    retryableFailedCount: 0, total: 0, queued: 0, downloading: 0, success: 0, failed: 0, currentWorkshopIds: [],
    queueWorkshopIds: [], batchSize: 5, currentBatchIndex: 0, nextBatchAt: null, startedAt: null, updatedAt: null,
    lastError: null, warnings: [], ...overrides }
}
const failure = (error: string) => queue({ items: [{ workshopId: '100', phase: 'failed', installStatus: 'failed', error, nextRetryAt: null }], retryableFailedCount: 1 })

describe('download presentation', () => {
  it('shows actual percentages and keeps verification and installation separate from readiness', () => {
    const item = { workshopId: '1', installStatus: 'pending' as const, phase: 'downloading' as const, error: null, nextRetryAt: null }
    assert.equal(resolveModDownloadItemLabel(item), '下载中')
    assert.equal(resolveModDownloadItemLabel({ ...item, phase: 'preparing_download' }), '准备下载')
    assert.equal(resolveModDownloadItemLabel({ ...item, phase: 'waiting_download' }), '等待下载')
    assert.equal(resolveModDownloadItemLabel({ ...item, phase: 'waiting_install' }), '等待安装')
    assert.equal(resolveModDownloadItemLabel({ ...item, progress: { downloadedBytes: 45, totalBytes: 100, percent: 45 } }), '下载中 45%')
    assert.equal(resolveModDownloadItemLabel({ ...item, progress: { downloadedBytes: 100, totalBytes: 100, percent: 100 } }), '下载完成，正在校验')
    assert.equal(resolveModDownloadItemLabel({ ...item, phase: 'installing' }), '下载完成，正在安装')
    assert.equal(resolveModDownloadItemLabel(item, 'paused'), '已暂停')
    assert.equal(resolveModDownloadHelp(queue({ status: 'running', phase: 'verifying' })).summary, '正在校验 Mod 文件。')
  })
  it('distinguishes preparation and bootstrap failures from Workshop downloading', () => {
    assert.equal(resolveModDownloadHelp(queue({ status: 'running', phase: 'preparing_steamcmd' })).summary, '正在准备下载环境。')
    assert.equal(summarizeModDownloadFailure('SteamCMD 自更新超时，尚未开始下载 Mod'), '下载环境准备超时，Mod 下载尚未开始。')
    assert.equal(resolveModDownloadAction(queue({ status: 'running', phase: 'preparing_steamcmd' }))?.label, '暂停下载')
  })
  it('shows only evidenced causes and keeps unknown output out of user guidance', () => {
    assert.equal(summarizeModDownloadFailure('Mod 下载超时，请检查 Steam 网络连接后重试'), '下载超时。')
    assert.match(summarizeModDownloadFailure('Mod 下载失败：实例目录权限不足'), /权限不足.*管理员/)
    assert.match(resolveModDownloadHelp(failure('Mod 下载失败：实例目录权限不足')).retryHint ?? '', /先由管理员处理目录权限.*再.*重试/)
    const help = resolveModDownloadHelp(failure('SteamCMD output: unrecognized failure'))
    assert.match(help.summary, /1 个 Mod/)
    assert.deepEqual(help.reasons, ['下载未完成，具体原因请查看技术信息。'])
    assert.doesNotMatch(help.reasons.join(''), /网络|代理|SteamCMD output/)
    assert.equal(summarizeModDownloadFailure('Mod 下载失败：unrecognized output mentioning 下载超时'), '下载未完成，具体原因请查看技术信息。')
    assert.match(help.retryHint ?? '', /失败条目.*重试/)
  })
  it('does not ask users to retry while automatic retry is pending', () => {
    const help = resolveModDownloadHelp(queue({ status: 'running', phase: 'retry_wait' }))
    assert.match(help.summary, /等待自动重试/)
    assert.equal(help.retryHint, null)
  })
  it('does not interpret missing observations or cancellation as a download failure', () => {
    assert.equal(resolveModDownloadHelp(queue(), { status: 'unknown', observedAt: null, message: null }).summary, '尚无下载记录。')
    const cancelled = resolveModDownloadHelp(queue(), { status: 'cancelled', observedAt: '2026-10-04T00:00:00Z', message: '下载已取消' })
    assert.match(cancelled.summary, /已取消/)
    assert.equal(cancelled.retryHint, null)
    assert.match(resolveModDownloadHelp(queue({ success: 1 })).summary, /没有下载失败/)
  })
  it('keeps failure recovery visible when there are other active items', () => {
    assert.match(resolveModDownloadHelp({ ...failure('Mod 下载超时'), status: 'running', phase: 'downloading' }).summary, /1 个 Mod/)
    assert.equal(resolveModDownloadHelp(queue({ lastError: 'unknown worker error' })).retryHint, null)
  })
  it('keeps one control visible throughout pause and resume without allowing overlapping downloads', () => {
    for (const phase of ['downloading', 'waiting_steamcmd', 'retry_wait', null] as const) {
      const active = queue({ status: 'running', phase, eligibleCount: 2 })
      assert.deepEqual(resolveModDownloadAction(active), { action: 'pause', label: '暂停下载', disabled: false })
      assert.deepEqual(resolveModDownloadAction({ ...active, status: 'pausing' }), { action: 'pause', label: '正在暂停…', disabled: true })
      assert.deepEqual(resolveModDownloadAction({ ...active, status: 'paused', phase: null }), { action: 'start', label: '恢复下载', disabled: false })
    }
  })
  it('retains the initial download entry and hides controls once nothing is pending', () => {
    assert.deepEqual(resolveModDownloadAction(queue({ eligibleCount: 2 })), { action: 'start', label: '开始下载', disabled: false })
    assert.equal(resolveModDownloadAction(null), null)
    assert.equal(resolveModDownloadAction(queue({ success: 2 })), null)
    assert.equal(resolveModDownloadAction(queue({ status: 'paused', success: 2 })), null)
    assert.equal(resolveModDownloadAction(failure('offline')), null)
    assert.match(resolveModDownloadHelp(queue({ status: 'paused', eligibleCount: 2, lastError: 'offline' })).retryHint ?? '', /上方.*恢复下载/)
  })
})
