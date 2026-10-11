import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { InstanceItem } from '@/api/modules/instance'
import { getInstanceState, resolveRuntimeReadinessView } from './instanceDisplay.ts'
import type { InstanceStartupSnapshot } from '@/api/modules/instance'

const NOW = Date.parse('2026-10-02T12:00:00.000Z')

function makeInstance(overrides: Partial<InstanceItem> = {}): InstanceItem {
  return {
    status: 'running',
    runtimeReadyAt: null,
    runtimeStartedAt: '2026-10-02T11:57:00.000Z',
    runtimeFailureKind: null,
    ...overrides,
  } as InstanceItem
}

/**
 * 「运行中」不等于「能接客」：加载 Mod 与世界期间房间还没向大厅注册。
 * 语气（tone）交给后端的 `runtimeFailureKind`，前端不复刻阈值判断卡没卡住。
 */
describe('resolveRuntimeReadinessView', () => {
  it('新任务加载期间优先显示启动中，不沿用上一轮错误或内存保护状态', () => {
    for (const status of ['queued', 'running'] as const) {
      const startup = { status, phase: 'master_loading', elapsedSeconds: 18, remainingSeconds: 282, diagnosis: null,
        master: { state: 'loading', memoryPeakMb: null }, caves: { state: 'pending', memoryPeakMb: null } } as InstanceStartupSnapshot
      const instance = makeInstance({ status: 'error', runtimeFailureKind: 'memory_protection', lastErrorPhase: 'runtime', lastError: '主世界启动失败：等待主世界就绪超时（300 秒）', startup })
      assert.equal(getInstanceState(instance).label, '启动中')
      assert.deepEqual(resolveRuntimeReadinessView(instance, NOW), { label: '主世界加载中（已等待 18 秒，本阶段剩余 282 秒）', tone: 'ok' })
      const failed = { ...instance, runtimeFailureKind: null, startup: { ...startup, status: 'failed' as const, phase: 'failed' as const, diagnosis: { code: 'timeout', message: '本轮超时' } }, lastError: '启动失败：本轮超时' }
      assert.equal(getInstanceState(failed).label, '启动失败')
    }
  })
  it('主世界已就绪但洞穴还在加载时保留启动中状态', () => {
    const startup = { status: 'running', phase: 'caves_loading', elapsedSeconds: 150, remainingSeconds: 250, diagnosis: null,
      master: { state: 'ready', memoryPeakMb: null }, caves: { state: 'loading', memoryPeakMb: null } } as InstanceStartupSnapshot
    const instance = makeInstance({ runtimeReadyAt: '2026-10-02T11:58:00.000Z', startup })
    assert.equal(getInstanceState(instance).label, '启动中')
    assert.equal(resolveRuntimeReadinessView(instance, NOW)?.label, '洞穴加载中（已等待 150 秒，本阶段剩余 250 秒）')
  })
  it('历史启动失败不会覆盖停止状态或后来的安装失败', () => {
    const startup = { status: 'failed' } as InstanceStartupSnapshot
    assert.equal(getInstanceState(makeInstance({ status: 'stopped', startup })).label, '已停止')
    assert.equal(getInstanceState(makeInstance({ status: 'error', lastErrorPhase: 'install', startup })).label, '安装失败')
  })
  it('没在运行的实例不显示就绪信息', () => {
    assert.equal(resolveRuntimeReadinessView(makeInstance({ status: 'stopped' })), null)
  })

  it('写过就绪时刻就直接说已就绪', () => {
    const view = resolveRuntimeReadinessView(makeInstance({ runtimeReadyAt: '2026-10-02T11:58:00.000Z' }), NOW)
    assert.deepEqual(view, { label: '世界已就绪', tone: 'ok' })
  })

  it('还没就绪时报出已加载多久，语气不吓人', () => {
    const view = resolveRuntimeReadinessView(makeInstance(), NOW)
    assert.equal(view?.label, '世界尚未就绪（已加载 3 分钟）')
    assert.equal(view?.tone, 'ok')
  })

  it('后端已给出未就绪归因时换成警示语气', () => {
    const view = resolveRuntimeReadinessView(makeInstance({ runtimeFailureKind: 'memory' }), NOW)
    assert.equal(view?.tone, 'warn')
  })

  it('启动时刻缺失时只说未就绪，不编造时长', () => {
    const view = resolveRuntimeReadinessView(makeInstance({ runtimeStartedAt: null }), NOW)
    assert.deepEqual(view, { label: '世界尚未就绪', tone: 'ok' })
  })
})
