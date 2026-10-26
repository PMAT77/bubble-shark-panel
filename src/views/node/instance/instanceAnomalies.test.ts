import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { InstanceItem, InstanceStartupSnapshot } from '@/api/modules/instance'
import { collectInstanceAnomalies, createInstanceAnomalyTracker, instanceAnomalyText } from './instanceAnomalies'

function instance(overrides: Partial<InstanceItem> = {}): InstanceItem {
  return { id: 'one', name: '联机房间', status: 'error', lastError: null, runtimeWarning: null, ...overrides } as InstanceItem
}
function startup(overrides: Partial<InstanceStartupSnapshot> = {}): InstanceStartupSnapshot {
  return { taskId: 'task-1', status: 'failed', master: { state: 'failed' }, caves: { state: 'stopped' }, diagnosis: null, ...overrides } as InstanceStartupSnapshot
}

it('同义警告、错误和诊断合并，保留世界范围及独立错误', () => {
  const reason = '等待主世界就绪超时（300 秒），请检查控制台和服务器配置'
  const anomalies = collectInstanceAnomalies(instance({
    runtimeWarning: reason, lastError: `主世界启动失败：${reason}`,
    startup: startup({ diagnosis: { code: 'timeout', message: reason } }),
  }))
  assert.deepEqual(anomalies, [{ reason, world: 'master' }])
  assert.equal(instanceAnomalyText(anomalies[0]), `地上：${reason}`)
  assert.equal(collectInstanceAnomalies(instance({ runtimeWarning: reason, lastError: '存档读取失败' })).length, 2)
})

it('通用启动失败前缀与旧字段兼容，地上和洞穴的独立失败不会丢失', () => {
  const reason = '连接失败'
  assert.equal(collectInstanceAnomalies(instance({ runtimeWarning: reason, lastError: `启动失败: ${reason}` })).length, 1)
  assert.deepEqual(collectInstanceAnomalies(instance({ runtimeWarning: `地上启动失败：${reason}`, lastError: `洞穴启动失败：${reason}` })), [
    { reason, world: 'master' }, { reason, world: 'caves' },
  ])
  assert.equal(collectInstanceAnomalies(instance({ lastError: '实例进程反复重启，请检查配置' }))[0].reason, '实例进程反复重启，请检查配置')
})

it('主世界健康时只展示洞穴失败，并读取分片诊断', () => {
  const anomalies = collectInstanceAnomalies(instance({ status: 'running', startup: startup({
    master: { state: 'ready', memoryPeakMb: null },
    caves: { state: 'failed', memoryPeakMb: null, diagnosis: { code: 'timeout', message: '未能连接主世界' } },
    diagnosis: { code: 'timeout', message: '未能连接主世界' },
  }) }))
  assert.deepEqual(anomalies, [{ reason: '未能连接主世界', world: 'caves' }])
})

it('版本查询原始错误保留在异常详情，独立于世界启动错误', () => {
  const raw = `SteamCMD 版本查询失败：${'Waiting for client config...\n'.repeat(60)}ERROR! Timeout`
  assert.deepEqual(collectInstanceAnomalies(instance({ status: 'stopped', updateCheckError: raw })), [{ reason: raw, world: null }])
  assert.deepEqual(collectInstanceAnomalies(instance({ updateCheckError: raw, startup: startup() })), [
    { reason: '启动失败，请查看控制台日志和服务器配置', world: 'master' },
    { reason: raw, world: null },
  ])
})

it('安装失败保留；安装过程中和已停止实例不展示历史启动诊断', () => {
  assert.equal(collectInstanceAnomalies(instance({ lastErrorPhase: 'install', lastError: '安装包下载失败' })).length, 1)
  assert.deepEqual(collectInstanceAnomalies(instance({ status: 'installing', lastError: '旧安装失败', startup: startup() })), [])
  assert.deepEqual(collectInstanceAnomalies(instance({ status: 'stopped', startup: startup({ diagnosis: { code: 'old', message: '历史失败' } }) })), [])
  assert.deepEqual(collectInstanceAnomalies(null), [])
  assert.equal(collectInstanceAnomalies(instance({ startup: startup() }))[0].world, 'master')
})

it('新启动排队与加载期间忽略旧错误，保留本轮实际分片失败', () => {
  const old = { status: 'error' as const, lastError: '主世界启动失败：等待主世界就绪超时（300 秒）', runtimeWarning: '等待主世界就绪超时（300 秒）' }
  for (const status of ['queued', 'running'] as const) {
    const active = startup({ taskId: 'new-task', status, master: { state: 'loading', memoryPeakMb: null }, diagnosis: null })
    assert.deepEqual(collectInstanceAnomalies(instance({ ...old, startup: active })), [])
    const failed = { ...active, master: { state: 'failed' as const, memoryPeakMb: null, diagnosis: { code: 'exit', message: '本轮进程退出' } } }
    assert.deepEqual(collectInstanceAnomalies(instance({ ...old, startup: failed })), [{ reason: '本轮进程退出', world: 'master' }])
    assert.deepEqual(collectInstanceAnomalies(instance({ ...old, lastError: null, runtimeWarning: null, startup: { ...failed, status: 'failed' } })), [{ reason: '本轮进程退出', world: 'master' }])
  }
})

it('轮询、返回和重新加载去重；新原因、新任务和解除后再次发生可以提醒', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  const tracker = createInstanceAnomalyTracker(storage)
  const anomalies = [{ reason: '异常原因', world: 'master' as const }]
  assert.equal(tracker.consume('one', 'task-1', anomalies), true)
  assert.equal(tracker.consume('one', 'task-1', anomalies), false)
  assert.equal(createInstanceAnomalyTracker(storage).consume('one', 'task-1', anomalies), false)
  assert.equal(tracker.consume('two', 'task-1', anomalies), true)
  assert.equal(tracker.consume('one', 'task-1', [...anomalies, { reason: '另一个原因', world: 'master' }]), true)
  assert.equal(tracker.consume('one', 'task-2', anomalies), true)
  assert.equal(tracker.consume('one', 'task-2', []), false)
  assert.equal(tracker.consume('one', 'task-2', anomalies), true)
})

it('浏览器存储不可用或内容损坏时仍能去重', () => {
  for (const storage of [
    { getItem: () => '{invalid', setItem: () => {}, removeItem: () => {} },
    { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => { throw new Error('blocked') } },
  ]) {
    const tracker = createInstanceAnomalyTracker(storage)
    const anomalies = [{ reason: '异常', world: null }]
    assert.equal(tracker.consume('one', null, anomalies), true)
    assert.equal(tracker.consume('one', null, anomalies), false)
    assert.equal(tracker.consume('one', null, []), false)
  }
})

it('补齐世界范围不重复提醒；部分原因解除后复发以及另一世界失败仍会提醒', () => {
  const tracker = createInstanceAnomalyTracker()
  const master = { reason: '连接失败', world: 'master' as const }
  const caves = { reason: '连接失败', world: 'caves' as const }
  assert.equal(tracker.consume('one', 'task', [{ ...master, world: null }]), true)
  assert.equal(tracker.consume('one', 'task', [master]), false)
  assert.equal(tracker.consume('one', 'task', [master, caves]), true)
  assert.equal(tracker.consume('one', 'task', [master]), false)
  assert.equal(tracker.consume('one', 'task', [master, caves]), true)
})
