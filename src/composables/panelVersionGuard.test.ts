import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizePanelVersion,
  readBuiltPanelVersion,
  resolvePanelVersionMismatch,
} from './panelVersionGuard.ts'

describe('normalizePanelVersion', () => {
  it('strips the v prefix and whitespace so package.json and release tags compare equal', () => {
    assert.equal(normalizePanelVersion('v1.2.3'), '1.2.3')
    assert.equal(normalizePanelVersion(' 1.2.3 '), '1.2.3')
    assert.equal(normalizePanelVersion('V1.2.3'), '1.2.3')
    assert.equal(normalizePanelVersion(null), '')
    assert.equal(normalizePanelVersion(undefined), '')
  })
})

describe('resolvePanelVersionMismatch', () => {
  it('reports a stale page when the running panel is newer', () => {
    const mismatch = resolvePanelVersionMismatch('1.2.3', 'v1.2.4')
    assert.deepEqual(mismatch, {
      builtVersion: '1.2.3',
      runningVersion: '1.2.4',
      stale: true,
    })
  })

  it('reports no mismatch when versions agree, regardless of the v prefix', () => {
    assert.deepEqual(resolvePanelVersionMismatch('1.2.3', 'v1.2.3'), {
      builtVersion: '1.2.3',
      runningVersion: '1.2.3',
      stale: false,
    })
  })

  it('never guesses when either side is unknown', () => {
    // 开发构建、未设置 BSP_RELEASE_VERSION 的部署、/health 取不到：一律不提示
    assert.equal(resolvePanelVersionMismatch('', 'v1.2.3'), null)
    assert.equal(resolvePanelVersionMismatch('1.2.3', null), null)
    assert.equal(resolvePanelVersionMismatch('1.2.3', ''), null)
    assert.equal(resolvePanelVersionMismatch(null, undefined), null)
  })
})

describe('readBuiltPanelVersion', () => {
  it('returns an empty version when the build-time constant is absent (dev / tests)', () => {
    // 单元测试里没有 vite define 注入，读到空串即代表「不判定」，且不能抛错
    assert.equal(readBuiltPanelVersion(), '')
  })
})
