import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { InstanceStartupSnapshot } from '@/api/modules/instance'
import { createStartupNoticeTracker, isInstanceWorldReady, shouldPollStartup, startupPhaseLabel } from './startupPresentation'

function snapshot(overrides: Partial<InstanceStartupSnapshot> = {}): InstanceStartupSnapshot {
  return {
    taskId: 'task-1', status: 'running', phase: 'caves_loading',
    startedAt: '2026-10-10T10:00:00.000Z', phaseStartedAt: '2026-10-10T10:01:00.000Z',
    updatedAt: '2026-10-10T10:02:00.000Z', phaseDeadlineAt: null,
    elapsedSeconds: 120, remainingSeconds: 240,
    master: { state: 'ready', memoryPeakMb: 2000 }, caves: { state: 'loading', memoryPeakMb: 1300 }, diagnosis: null,
    ...overrides,
  }
}

describe('完整启动展示', () => {
  it('主世界ready不能遮盖洞穴加载或互联等待', () => {
    const instance = { status: 'running' as const, runtimeReadyAt: '2026-10-10T10:01:00Z', startup: snapshot() }
    assert.equal(isInstanceWorldReady(instance), false)
    assert.equal(shouldPollStartup(instance), true)
    assert.equal(startupPhaseLabel(instance.startup), '洞穴加载中')
    assert.equal(startupPhaseLabel(snapshot({ phase: 'connecting' })), '验证分片连接')
    assert.equal(isInstanceWorldReady({ ...instance, startup: snapshot({ status: 'success', phase: 'ready' }) }), true)
    assert.equal(shouldPollStartup({ ...instance, startup: snapshot({ status: 'success', phase: 'ready' }) }), false)
  })
  it('停止实例不会因历史成功记录而显示就绪或继续轮询', () => {
    const instance = { status: 'stopped' as const, runtimeReadyAt: null, startup: snapshot({ status: 'success', phase: 'ready' }) }
    assert.equal(isInstanceWorldReady(instance), false)
    assert.equal(shouldPollStartup(instance), false)
  })
})

describe('启动终态通知', () => {
  it('swap notices remain deduplicated after page reload, with a fallback when storage is unavailable', (t) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
    const values = new Map<string, string>()
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    } })
    t.after(() => {
      if (original) Object.defineProperty(globalThis, 'sessionStorage', original)
      else Reflect.deleteProperty(globalThis, 'sessionStorage')
    })
    const swapAdvice = { state: 'low' as const, message: '追加 2 GiB swap', command: 'sudo bsp setup-swap' }
    const active = snapshot({ swapAdvice })
    assert.deepEqual(createStartupNoticeTracker().consumeSwap('instance', active), swapAdvice)
    assert.equal(createStartupNoticeTracker().consumeSwap('instance', active), null)
    assert.deepEqual(createStartupNoticeTracker().consumeSwap('instance', snapshot({ taskId: 'task-2', swapAdvice })), swapAdvice)
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { throw new Error('storage denied') } })
    const tracker = createStartupNoticeTracker()
    assert.deepEqual(tracker.consumeSwap('instance', active), swapAdvice)
    assert.equal(tracker.consumeSwap('instance', active), null)
  })
  it('swap notices ignore history, cancelled tasks, unknown and adequate readings', () => {
    const tracker = createStartupNoticeTracker()
    const swapAdvice = { state: 'low' as const, message: '追加 2 GiB swap', command: 'sudo bsp setup-swap' }
    assert.equal(tracker.consumeSwap('instance', snapshot({ status: 'failed', swapAdvice })), null)
    assert.equal(tracker.consumeSwap('instance', snapshot({ status: 'cancelled', swapAdvice })), null)
    assert.equal(tracker.consumeSwap('instance', snapshot({ swapAdvice: { ...swapAdvice, state: 'unknown' } })), null)
    assert.equal(tracker.consumeSwap('instance', snapshot({ swapAdvice: { ...swapAdvice, state: 'ready' } })), null)
    assert.deepEqual(tracker.consumeSwap('instance', snapshot({ swapAdvice })), swapAdvice)
    assert.equal(tracker.consumeSwap('instance', snapshot({ swapAdvice })), null)
    assert.equal(tracker.consumeSwap('instance', snapshot({ status: 'failed', swapAdvice })), null)
  })
  it('fast failures of accepted tasks notify once, and new starts can notify again', () => {
    const tracker = createStartupNoticeTracker()
    const swapAdvice = { state: 'none' as const, message: '创建 2 GiB swap', command: 'sudo bsp setup-swap' }
    tracker.accept('instance', 0, 'task-2')
    assert.equal(tracker.consumeSwap('instance', snapshot({ swapAdvice })), null)
    const failed = snapshot({ taskId: 'task-2', status: 'failed', swapAdvice })
    assert.deepEqual(tracker.consumeSwap('instance', failed), swapAdvice)
    assert.equal(tracker.consume('instance', failed), 'failed')
    assert.equal(tracker.consumeSwap('instance', failed), null)
    assert.deepEqual(tracker.consumeSwap('instance', snapshot({ taskId: 'task-3', swapAdvice })), swapAdvice)
  })
  it('按受理taskId匹配，不受客户端与服务器时钟偏差影响', () => {
    const tracker = createStartupNoticeTracker()
    tracker.accept('instance', Date.parse('2026-10-10T11:00:00Z'), 'task-2')
    assert.equal(tracker.consume('instance', snapshot({ status: 'success' })), null)
    assert.equal(tracker.pending('instance'), true)
    assert.equal(tracker.consume('instance', snapshot({ taskId: 'task-2', status: 'success', phase: 'ready' })), 'success')
  })
  it('请求受理后忽略旧任务，完整成功只通知一次', () => {
    const tracker = createStartupNoticeTracker()
    tracker.accept('instance', Date.parse('2026-10-10T09:59:59Z'))
    assert.equal(tracker.consume('instance', snapshot({ startedAt: '2026-10-10T09:50:00Z', status: 'success' })), null)
    assert.equal(tracker.consume('instance', snapshot()), null)
    assert.equal(tracker.consume('instance', snapshot({ status: 'success', phase: 'ready' })), 'success')
    assert.equal(tracker.consume('instance', snapshot({ status: 'success', phase: 'ready' })), null)
  })
  it('重新启动后旧响应不产生新任务的成功提示', () => {
    const tracker = createStartupNoticeTracker()
    tracker.accept('instance', Date.parse('2026-10-10T09:59:59Z'))
    tracker.consume('instance', snapshot())
    tracker.accept('instance', Date.parse('2026-10-10T10:05:00Z'))
    assert.equal(tracker.consume('instance', snapshot({ status: 'success' })), null)
    assert.equal(tracker.consume('instance', snapshot({ taskId: 'task-2', startedAt: '2026-10-10T10:05:01Z', status: 'success' })), 'success')
  })
  it('取消、打开历史页面、被其他任务替换不会虚报启动成功', () => {
    const tracker = createStartupNoticeTracker()
    assert.equal(tracker.consume('instance', snapshot({ status: 'success' })), null)
    tracker.accept('instance', 0)
    tracker.consume('instance', snapshot())
    assert.equal(tracker.consume('instance', snapshot({ taskId: 'other-task', status: 'success' })), null)
    assert.equal(tracker.pending('instance'), false)
    tracker.accept('instance', 0)
    assert.equal(tracker.consume('instance', snapshot({ status: 'cancelled' })), null)
    assert.equal(tracker.pending('instance'), false)
  })
})
