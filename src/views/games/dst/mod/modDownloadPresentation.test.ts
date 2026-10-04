import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModDownloadQueueDto } from '../../../../../shared/contracts/mod.ts'
import { resolveModDownloadDetails, resolveModDownloadHelp, summarizeModDownloadFailure } from './modDownloadPresentation.ts'

function queue(overrides: Partial<ModDownloadQueueDto> = {}): ModDownloadQueueDto {
  return { instanceId: 'test', status: 'idle', phase: null, items: [], eligibleCount: 0, inactiveMissingCount: 0,
    retryableFailedCount: 0, total: 0, queued: 0, downloading: 0, success: 0, failed: 0, currentWorkshopIds: [],
    queueWorkshopIds: [], batchSize: 5, currentBatchIndex: 0, nextBatchAt: null, startedAt: null, updatedAt: null,
    lastError: null, warnings: [], ...overrides }
}
const failure = (error: string) => queue({ items: [{ workshopId: '100', phase: 'failed', installStatus: 'failed', error, nextRetryAt: null }], retryableFailedCount: 1 })

describe('download presentation', () => {
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
  it('removes running and cancellation text from completed and paused downloads', () => {
    const completed = resolveModDownloadDetails(queue({ success: 1, currentBatchIndex: 1 }))
    assert.deepEqual(completed, ['本次下载已结束：成功 1 个，失败 0 个。'])
    assert.doesNotMatch(completed.join(''), /当前处理|正在处理|取消|当前第/)
    const paused = resolveModDownloadDetails(queue({ status: 'paused', eligibleCount: 2, currentBatchIndex: 1 }))
    assert.match(paused.join(''), /2 个 Mod/)
    assert.doesNotMatch(paused.join(''), /取消当前批次|正在处理/)
  })
  it('distinguishes waiting, retrying and actual downloading', () => {
    assert.match(resolveModDownloadDetails(queue({ status: 'running', phase: 'waiting_steamcmd', currentWorkshopIds: ['100'] })).join(''), /轮到本次任务/)
    assert.match(resolveModDownloadDetails(queue({ status: 'running', phase: 'retry_wait' })).join(''), /自动重试/)
    assert.match(resolveModDownloadDetails(queue({ status: 'running', phase: 'downloading', currentBatchIndex: 2, currentWorkshopIds: ['100', '101'] })).join(''), /第 2 批.*处理 2 个/)
    assert.doesNotMatch(resolveModDownloadDetails(queue({ status: 'pausing', phase: 'waiting_steamcmd' })).join(''), /当前下载完成后|取消当前批次/)
    assert.deepEqual(resolveModDownloadDetails(queue({ status: 'running', phase: 'downloading' })), ['正在准备下一批下载。'])
  })
})
