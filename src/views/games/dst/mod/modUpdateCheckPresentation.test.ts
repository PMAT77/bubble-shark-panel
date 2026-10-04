import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModUpdateCheckSummary } from '../../../../shared/contracts/mod.ts'
import {
  resolveModUpdateCheckNotice,
} from './modUpdateCheckPresentation.ts'

function summary(partial: Partial<ModUpdateCheckSummary>): ModUpdateCheckSummary {
  return {
    total: partial.total ?? 0,
    outdated: partial.outdated ?? 0,
    upToDate: partial.upToDate ?? 0,
    unknown: partial.unknown ?? 0,
  }
}

describe('resolveModUpdateCheckNotice', () => {
  it('never calls partially checked mods up to date', () => {
    // 列表里还有「未检查 + 重新下载」的行时，提示不能是「都是最新版本」
    const notice = resolveModUpdateCheckNotice({
      summary: summary({ total: 8, upToDate: 6, unknown: 2 }),
      upstreamOk: true,
      message: null,
    })

    assert.equal(notice.kind, 'message')
    assert.equal(notice.tone, 'warning')
    assert.equal(notice.content.includes('都是创意工坊上的最新版本'), false)
    assert.match(notice.content, /6 个 Mod 已是最新/)
    assert.match(notice.content, /2 个无法判断版本/)
    assert.match(notice.content, /重新下载/)
  })

  it('reports every mod as unknown without claiming they are up to date', () => {
    const notice = resolveModUpdateCheckNotice({
      summary: summary({ total: 3, unknown: 3 }),
      upstreamOk: true,
      message: null,
    })

    assert.equal(notice.tone, 'warning')
    assert.match(notice.content, /有 3 个 Mod 无法判断版本/)
    assert.equal(notice.content.includes('都是创意工坊上的最新版本'), false)
  })

  it('confirms all up to date only when every mod was actually judged', () => {
    const notice = resolveModUpdateCheckNotice({
      summary: summary({ total: 5, upToDate: 5 }),
      upstreamOk: true,
      message: null,
    })

    assert.equal(notice.kind, 'message')
    assert.equal(notice.tone, 'success')
    assert.match(notice.content, /当前 5 个 Mod 都是创意工坊上的最新版本/)
  })

  it('announces outdated mods with a notification and mentions the unjudged ones', () => {
    const notice = resolveModUpdateCheckNotice({
      summary: summary({ total: 4, outdated: 2, upToDate: 1, unknown: 1 }),
      upstreamOk: true,
      message: null,
    })

    assert.equal(notice.kind, 'notification')
    assert.equal(notice.tone, 'info')
    assert.equal(notice.title, '发现 2 个 Mod 有新版本')
    assert.match(notice.content, /另有 1 个 Mod 无法判断版本/)
  })

  it('appends the workshop-side reason and the self-service hint on partial upstream failure', () => {
    const notice = resolveModUpdateCheckNotice({
      summary: summary({ total: 4, upToDate: 3, unknown: 1 }),
      upstreamOk: false,
      message: '无法连接 Steam 创意工坊',
    })

    assert.match(notice.content, /无法连接 Steam 创意工坊/)
    assert.match(notice.content, /沿用上次结果/)
    assert.match(notice.content, /下载遇到问题/)
    assert.match(notice.content, /本地 ZIP 导入/)
  })

  it('does not present previously up-to-date records as a successful offline check', () => {
    const notice = resolveModUpdateCheckNotice({
      summary: summary({ total: 5, upToDate: 5 }),
      upstreamOk: false,
      message: null,
    })
    assert.equal(notice.tone, 'warning')
    assert.match(notice.content, /检查时间/)
    assert.match(notice.content, /5 个检查时最新/)
    assert.equal(notice.content.includes('都是创意工坊上的最新版本'), false)
  })

  it('stays neutral when the instance has no subscribed mods', () => {
    const notice = resolveModUpdateCheckNotice({
      summary: summary({ total: 0 }),
      upstreamOk: true,
      message: null,
    })

    assert.equal(notice.tone, 'info')
    assert.match(notice.content, /还没有已订阅的 Mod/)
  })
})
