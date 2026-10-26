import assert from 'node:assert/strict'
import { it } from 'node:test'
import { buildInstanceUpdateCheckNotice, canForceUpdateInstance, canUpdateInstance, getUpdateInstanceButtonTitle, isInstanceUpToDate, resolveInstanceUpdateState, INSTANCE_VERSION_UNKNOWN_NOTICE } from './instanceUpdatePresentation'
import type { InstanceItem } from '../../../../shared/contracts/instance'

const latest = { id: 'one', name: 'one', localBuildId: '25643504', remoteBuildId: '25643504',
  updateCheckedAt: '2026-10-03T00:00:00Z', updateAvailable: false }

it('distinguishes unknown, latest, available, mixed and empty update results', () => {
  assert.equal(buildInstanceUpdateCheckNotice([]).tone, 'info')
  assert.match(buildInstanceUpdateCheckNotice([]).message, /没有可检查/)
  assert.equal(buildInstanceUpdateCheckNotice([latest]).tone, 'success')
  const unknown = { ...latest, remoteBuildId: null }
  assert.equal(buildInstanceUpdateCheckNotice([unknown]).message, INSTANCE_VERSION_UNKNOWN_NOTICE)
  assert.match(buildInstanceUpdateCheckNotice([{ ...unknown, message: '无法获取 Steam 远端版本信息' }]).message,
    /请重新检查更新/)
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

it('版本检查的操作说明和结果通知不展示原始 SteamCMD 日志', () => {
  const raw = `SteamCMD 版本查询失败：${'[----] Update complete, launching Steamcmd...\n'.repeat(60)}WARNING: setlocale failed /root/Steam/logs/stderr.txt\nERROR! Info request returned error Timeout`
  const row = { ...latest, status: 'stopped', installLogStatus: 'success', updateCheckError: raw } as InstanceItem
  assert.equal(getUpdateInstanceButtonTitle(row), INSTANCE_VERSION_UNKNOWN_NOTICE)
  assert.equal(canUpdateInstance(row), false)
  for (const item of [{ ...row, message: raw }, { ...row, updateCheckError: null, remoteBuildId: null, message: raw }]) {
    const notice = buildInstanceUpdateCheckNotice([item])
    assert.equal(notice.tone, 'warning')
    assert.equal(notice.message, INSTANCE_VERSION_UNKNOWN_NOTICE)
    assert.doesNotMatch(notice.message, /Steamcmd|stderr|Timeout|WARNING/i)
    assert.ok(notice.message.length < 100)
  }
  assert.equal(getUpdateInstanceButtonTitle({ ...row, status: 'running' }), '请先停止实例')
  assert.equal(getUpdateInstanceButtonTitle({ ...row, status: 'installing' }), '安装进行中')
  assert.equal(getUpdateInstanceButtonTitle({ ...row, updateCheckError: null }), '已是最新版本')
  assert.equal(getUpdateInstanceButtonTitle({ ...row, installLogStatus: 'failed' }), '重试安装服务端文件')
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
