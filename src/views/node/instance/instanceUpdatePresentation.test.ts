import assert from 'node:assert/strict'
import { it } from 'node:test'
import { buildInstanceUpdateCheckNotice, canForceUpdateInstance, canUpdateInstance, isInstanceUpToDate, resolveInstanceUpdateState } from './instanceUpdatePresentation'
import type { InstanceItem } from '../../../../shared/contracts/instance'

const latest = { id: 'one', name: 'one', localBuildId: '25643504', remoteBuildId: '25643504',
  updateCheckedAt: '2026-10-03T00:00:00Z', updateAvailable: false }

it('distinguishes unknown, latest, available, mixed and empty update results', () => {
  assert.equal(buildInstanceUpdateCheckNotice([]).tone, 'info')
  assert.match(buildInstanceUpdateCheckNotice([]).message, /没有可检查/)
  assert.equal(buildInstanceUpdateCheckNotice([latest]).tone, 'success')
  const unknown = { ...latest, remoteBuildId: null }
  assert.match(buildInstanceUpdateCheckNotice([unknown]).message, /无法判断/)
  assert.match(buildInstanceUpdateCheckNotice([{ ...unknown, message: '无法获取 Steam 远端版本信息' }]).message,
    /one：无法获取 Steam 远端版本信息/)
  const old = { ...latest, localBuildId: '25540104', updateAvailable: true }
  assert.match(buildInstanceUpdateCheckNotice([old]).message, /1 个实例可更新/)
  assert.match(buildInstanceUpdateCheckNotice([old, unknown]).message, /1 个实例可更新，1 个实例无法判断/)
  assert.equal(isInstanceUpToDate(unknown), false)
  assert.equal(isInstanceUpToDate({ ...latest, localBuildId: '25540104' }), false)
  assert.equal(isInstanceUpToDate(latest), true)
  const mismatchedContent = { ...latest, updateAvailable: true }
  assert.equal(isInstanceUpToDate(mismatchedContent), false)
  assert.equal(buildInstanceUpdateCheckNotice([mismatchedContent]).tone, 'info')
  assert.match(buildInstanceUpdateCheckNotice([mismatchedContent]).message, /1 个实例可更新/)
})

it('offers file recovery only when stopped or in error', () => {
  for (const status of ['stopped', 'error'] as const) {
    assert.equal(canForceUpdateInstance({ status }), true)
  }
  for (const status of ['running', 'installing', 'pending_install'] as const) {
    assert.equal(canForceUpdateInstance({ status }), false)
  }
})

it('ordinary updates require a confirmed update, while installation failures may retry', () => {
  const row = { ...latest, status: 'stopped', installLogStatus: 'success', lastErrorPhase: null } as InstanceItem
  assert.equal(canUpdateInstance(row), false)
  assert.equal(canUpdateInstance({ ...row, updateAvailable: true }), true)
  const unknown = { ...row, updateCheckError: '无法核对内容清单', updateAvailable: true }
  assert.equal(resolveInstanceUpdateState(unknown), 'unknown')
  assert.equal(isInstanceUpToDate(unknown), false)
  assert.equal(canUpdateInstance(unknown), false)
  assert.equal(canUpdateInstance({ ...row, remoteBuildId: null }), false)
  assert.equal(canUpdateInstance({ ...row, status: 'error', lastErrorPhase: 'install', installLogStatus: 'failed' }), true)
  assert.equal(canUpdateInstance({ ...row, status: 'running', updateAvailable: true }), false)
})
