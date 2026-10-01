import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { InstanceItem } from '@/api/modules/instance'
import { resolveRuntimeReadinessView } from './instanceDisplay.ts'

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
