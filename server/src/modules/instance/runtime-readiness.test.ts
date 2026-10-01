import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveRuntimeReadiness } from './runtime-readiness.ts'

const NOW = Date.parse('2026-10-02T12:00:00.000Z')

/**
 * 线上读数：卡片写着「运行中」，游戏里却搜不到房间——进程在跑，世界还没加载完。
 * 三种状态必须能分开：已就绪 / 正在加载 / 迟迟未就绪。
 */
describe('resolveRuntimeReadiness', () => {
  it('没有实例在跑时不参与状态展示', () => {
    const readiness = resolveRuntimeReadiness({
      status: 'stopped',
      runtimeReadyAt: null,
      runtimeStartedAt: null,
      notReadyAfterSec: 900,
      now: NOW,
    })
    assert.equal(readiness.state, 'not_running')
    assert.equal(readiness.loadingSeconds, null)
  })

  it('本轮写过就绪时刻就是已就绪，哪怕进程已经跑了很久', () => {
    const readiness = resolveRuntimeReadiness({
      status: 'running',
      runtimeReadyAt: '2026-10-02T11:05:00.000Z',
      runtimeStartedAt: '2026-10-02T11:00:00.000Z',
      notReadyAfterSec: 900,
      now: NOW,
    })
    assert.equal(readiness.state, 'ready')
  })

  it('还没就绪时给出已加载时长', () => {
    const readiness = resolveRuntimeReadiness({
      status: 'running',
      runtimeReadyAt: null,
      runtimeStartedAt: '2026-10-02T11:57:00.000Z',
      notReadyAfterSec: 900,
      now: NOW,
    })
    assert.equal(readiness.state, 'loading')
    assert.equal(readiness.loadingSeconds, 180)
  })

  it('超过等主世界就绪的上限还没就绪就是卡住，不再算「加载慢」', () => {
    const readiness = resolveRuntimeReadiness({
      status: 'running',
      runtimeReadyAt: null,
      runtimeStartedAt: '2026-10-02T11:39:00.000Z',
      notReadyAfterSec: 900,
      now: NOW,
    })
    assert.equal(readiness.state, 'stalled')
    assert.equal(readiness.loadingSeconds, 1260)
  })

  it('启动时刻读不到时只说「未就绪」，不编造时长也不判卡住', () => {
    const readiness = resolveRuntimeReadiness({
      status: 'running',
      runtimeReadyAt: null,
      runtimeStartedAt: null,
      notReadyAfterSec: 900,
      now: NOW,
    })
    assert.equal(readiness.state, 'loading')
    assert.equal(readiness.loadingSeconds, null)
  })

  it('就绪时刻是无效值时不能当成已就绪（旧数据、手改库）', () => {
    const readiness = resolveRuntimeReadiness({
      status: 'running',
      runtimeReadyAt: 'not-a-time',
      runtimeStartedAt: '2026-10-02T11:57:00.000Z',
      notReadyAfterSec: 900,
      now: NOW,
    })
    assert.equal(readiness.state, 'loading')
  })
})
