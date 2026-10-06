import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getInstanceState, looksLikeRuntimeCommand } from './instanceDisplay.ts'
import { INSTANCE_STATE, INSTANCE_STATUS, MOD_ENABLED_STATUS, MOD_INSTALL_STATUS, resolveShardDisplayStatus, SHARD_CONTAINER_STATUS, statusTagType } from '@/constants/statusDictionary'

describe('statusDictionary', () => {
  it('未就绪显示启动中，就绪后才显示运行中', () => {
    assert.equal(getInstanceState({ status: 'running', lastErrorPhase: null, runtimeReadyAt: null }).label, '启动中')
    assert.equal(getInstanceState({ status: 'running', lastErrorPhase: null, runtimeReadyAt: '2026-10-06T11:00:00Z' }).label, '运行中')
    assert.equal(getInstanceState({ status: 'error', lastErrorPhase: 'runtime', lastError: '启动失败：主世界分片发生 Lua 致命错误' }).label, '启动失败')
  })
  it('every descriptor has a non-empty label and a valid tone', () => {
    const groups = [
      Object.values(INSTANCE_STATE),
      Object.values(INSTANCE_STATUS),
      Object.values(SHARD_CONTAINER_STATUS),
      Object.values(MOD_INSTALL_STATUS),
      Object.values(MOD_ENABLED_STATUS),
    ]
    for (const group of groups) {
      for (const descriptor of group) {
        assert.ok(descriptor.label.trim().length > 0, `descriptor label must not be empty: ${JSON.stringify(descriptor)}`)
        assert.ok(['success', 'info', 'warning', 'error', 'neutral'].includes(descriptor.tone), `invalid tone: ${descriptor.tone}`)
      }
    }
  })

  it('maps tones to naive-ui tag types', () => {
    assert.equal(statusTagType('success'), 'success')
    assert.equal(statusTagType('info'), 'info')
    assert.equal(statusTagType('warning'), 'warning')
    assert.equal(statusTagType('error'), 'error')
    assert.equal(statusTagType('neutral'), 'default')
  })
})

describe('resolveShardDisplayStatus', () => {
  it('reports a running container as 运行中', () => {
    const descriptor = resolveShardDisplayStatus({ configured: true, containerStatus: 'running' })
    assert.equal(descriptor.label, '运行中')
    assert.equal(descriptor.tone, 'success')
  })

  it('reports an existing but stopped container as 未运行', () => {
    const descriptor = resolveShardDisplayStatus({ configured: true, containerStatus: 'stopped' })
    assert.equal(descriptor.label, '未运行')
    assert.equal(descriptor.tone, 'neutral')
  })

  it('reports an unknown container state as 未知', () => {
    assert.equal(resolveShardDisplayStatus({ configured: true, containerStatus: 'unknown' }).label, '未知')
  })

  it('reports a missing container as 未运行 when the shard is configured', () => {
    // 导入存档后实例必然是停止状态，此时面板已删除运行容器
    const descriptor = resolveShardDisplayStatus({ configured: true, containerStatus: 'not_created' })
    assert.equal(descriptor.label, '未运行')
    assert.equal(descriptor.tone, 'neutral')
  })

  it('reports a missing container as 未运行 when the world save already exists', () => {
    const descriptor = resolveShardDisplayStatus({
      configured: false,
      containerStatus: 'not_created',
      worldGenerated: true,
    })
    assert.equal(descriptor.label, '未运行')
    assert.equal(descriptor.tone, 'neutral')
  })

  it('keeps 未配置 only for a shard without config and without a world save', () => {
    const descriptor = resolveShardDisplayStatus({ configured: false, containerStatus: 'not_created' })
    assert.equal(descriptor.label, '未配置')
    assert.equal(descriptor.tone, 'warning')
  })

  it('falls back to 未知 when the shard summary is missing', () => {
    assert.equal(resolveShardDisplayStatus(null).label, '未知')
    assert.equal(resolveShardDisplayStatus(undefined).label, '未知')
  })
})

describe('getInstanceState error split', () => {
  it('reports install failure when the failure phase is install', () => {
    const state = getInstanceState({ status: 'error', lastErrorPhase: 'install' })
    assert.equal(state.key, 'install_failed')
    assert.equal(state.label, '安装失败')
  })

  it('reports runtime failure when the failure phase is runtime', () => {
    const state = getInstanceState({ status: 'error', lastErrorPhase: 'runtime' })
    assert.equal(state.key, 'runtime_error')
    assert.equal(state.label, '运行异常')
  })

  it('reports runtime failure when the phase is unknown', () => {
    // 旧数据没有环节字段：按运行异常兜底，与 INSTANCE_STATUS.error 的口径一致
    assert.equal(getInstanceState({ status: 'error', lastErrorPhase: null }).key, 'runtime_error')
  })

  it('reports runtime failure for a start blocked by host memory pressure', () => {
    // 守卫的说明里同时写了「安装/启动」：靠文案判定会翻成安装失败，按环节判定才是对的
    const instance = {
      status: 'error' as const,
      lastErrorPhase: 'runtime' as const,
      lastError: '宿主机可用内存不足（当前约 3365 MiB，可用 swap 约 0 MiB）。说明：安装/启动按典型峰值估算，并非按容器上限占满内存。',
    }
    assert.equal(getInstanceState(instance).key, 'runtime_error')
  })

  it('passes through non-error statuses from the dictionary', () => {
    assert.equal(getInstanceState({ status: 'running', lastErrorPhase: null }).key, 'running')
    assert.equal(getInstanceState({ status: 'pending_install', lastErrorPhase: null }).label, '未安装')
    assert.equal(getInstanceState({ status: 'installing', lastErrorPhase: null }).label, '安装中')
  })
})

describe('looksLikeRuntimeCommand', () => {
  it('detects game server executables', () => {
    assert.equal(looksLikeRuntimeCommand('./dontstarve_dedicated_server_nullrenderer_x64'), true)
    assert.equal(looksLikeRuntimeCommand('bash launch.sh'), true)
    assert.equal(looksLikeRuntimeCommand('steamcmd +quit'), false)
    assert.equal(looksLikeRuntimeCommand(null), false)
    assert.equal(looksLikeRuntimeCommand('   '), false)
  })
})
