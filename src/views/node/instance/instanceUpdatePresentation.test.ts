import assert from 'node:assert/strict'
import { it } from 'node:test'
import { buildInstanceUpdateCheckNotice, canRepairInstance, isInstanceUpToDate } from './instanceUpdatePresentation'

const latest = { id: 'one', name: 'one', localBuildId: '25643504', remoteBuildId: '25643504',
  updateCheckedAt: '2026-10-03T00:00:00Z', updateAvailable: false }

it('distinguishes unknown, latest, available, mixed and empty update results', () => {
  assert.equal(buildInstanceUpdateCheckNotice([]).tone, 'info')
  assert.match(buildInstanceUpdateCheckNotice([]).message, /没有可检查/)
  assert.equal(buildInstanceUpdateCheckNotice([latest]).tone, 'success')
  const unknown = { ...latest, remoteBuildId: null }
  assert.match(buildInstanceUpdateCheckNotice([unknown]).message, /无法判断/)
  const old = { ...latest, localBuildId: '25540104', updateAvailable: true }
  assert.match(buildInstanceUpdateCheckNotice([old]).message, /1 个实例可更新/)
  assert.match(buildInstanceUpdateCheckNotice([old, unknown]).message, /1 个实例可更新，1 个实例无法判断/)
  assert.equal(isInstanceUpToDate(unknown), false)
  assert.equal(isInstanceUpToDate({ ...latest, localBuildId: '25540104' }), false)
  assert.equal(isInstanceUpToDate(latest), true)
})

it('offers file recovery only when stopped or in error', () => {
  for (const status of ['stopped', 'error'] as const) {
    assert.equal(canRepairInstance({ status }), true)
  }
  for (const status of ['running', 'installing', 'pending_install'] as const) {
    assert.equal(canRepairInstance({ status }), false)
  }
})
