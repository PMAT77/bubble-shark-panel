import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildSelfCheckReport,
  SELF_CHECK_DISK_FAIL_GB,
  SELF_CHECK_DISK_WARN_GB,
  type SelfCheckInput,
} from './self-check'

function baseInput(overrides: Partial<SelfCheckInput> = {}): SelfCheckInput {
  return {
    releaseVersion: 'v0.5.0',
    runtimeMode: 'docker',
    runtimeStatus: 'running',
    dockerStatus: 'running',
    steamcmdReady: true,
    diskTotalGb: 40,
    diskFreeGb: 20,
    memoryTotalMb: 8192,
    writablePaths: [
      { label: '实例目录', path: '/data/instances', writable: true },
      { label: '备份目录', path: '/data/backups', writable: true },
      { label: '日志目录', path: '/data/logs', writable: true },
    ],
    instanceCount: 1,
    errorInstanceCount: 0,
    notifyEnabled: true,
    failingChannelCount: 0,
    ...overrides,
  }
}

function itemOf(input: SelfCheckInput, id: string) {
  const report = buildSelfCheckReport(input, new Date('2026-09-15T12:00:00.000Z'))
  const item = report.items.find(entry => entry.id === id)
  assert.ok(item, `缺少自检项 ${id}`)
  return item
}

describe('buildSelfCheckReport', () => {
  it('reports an all-clear environment', () => {
    const report = buildSelfCheckReport(baseInput(), new Date('2026-09-15T12:00:00.000Z'))
    assert.equal(report.summary.fail, 0)
    // 未提供 steamUpstream 时「Mod 市场上游」是 warn（还没采集到，不能说没问题），
    // 除此之外不该有别的告警
    assert.equal(report.summary.warn, 1)
    assert.equal(report.generatedAt, '2026-09-15T12:00:00.000Z')
    assert.equal(report.releaseVersion, 'v0.5.0')
    assert.equal(itemOf(baseInput(), 'runtime').status, 'ok')
    assert.match(itemOf(baseInput(), 'version').detail, /v0\.5\.0/)
  })

  it('summarizes the mod market upstream chain', () => {
    const healthy = itemOf(baseInput({
      steamUpstream: {
        configuredSources: ['official', 'html'],
        sourceOrder: ['official', 'html'],
        openSources: [],
        lastSuccessSource: 'official',
        lastSuccessAt: '2026-09-15T11:30:00.000Z',
        proxyEnabled: true,
        proxySource: 'BSP_STEAM_HTTPS_PROXY',
        proxyHost: 'proxy:7890',
        webApiBaseConfigured: false,
        relayConfigured: false,
      },
    }), 'steam-workshop')
    assert.equal(healthy.status, 'ok')
    assert.match(healthy.detail, /official → html/)
    assert.match(healthy.detail, /代理已生效/)
    assert.ok(!healthy.detail.includes('secret'))

    const openCircuit = itemOf(baseInput({
      steamUpstream: {
        configuredSources: ['html'],
        sourceOrder: ['html'],
        openSources: ['html'],
        lastSuccessSource: null,
        lastSuccessAt: null,
        proxyEnabled: false,
        proxySource: null,
        proxyHost: null,
        webApiBaseConfigured: false,
        relayConfigured: false,
      },
    }), 'steam-workshop')
    assert.equal(openCircuit.status, 'warn')
    assert.match(openCircuit.detail, /熔断/)

    // 没配代理也从没成功过：这是国内服务器的典型现场，必须给出可照做的建议
    const neverWorked = itemOf(baseInput({
      steamUpstream: {
        configuredSources: ['html'],
        sourceOrder: ['html'],
        openSources: [],
        lastSuccessSource: null,
        lastSuccessAt: null,
        proxyEnabled: false,
        proxySource: null,
        proxyHost: null,
        webApiBaseConfigured: false,
        relayConfigured: false,
      },
    }), 'steam-workshop')
    assert.equal(neverWorked.status, 'warn')
    assert.match(neverWorked.hint ?? '', /BSP_STEAM_HTTPS_PROXY/)
    assert.match(neverWorked.hint ?? '', /host\.docker\.internal/)
  })

  it('flags a broken runtime in both deployment modes', () => {
    const docker = itemOf(baseInput({ dockerStatus: 'stopped' }), 'runtime')
    assert.equal(docker.status, 'fail')
    assert.match(docker.detail, /Docker/)

    const native = itemOf(baseInput({ runtimeMode: 'native', runtimeStatus: 'stopped' }), 'runtime')
    assert.equal(native.status, 'fail')
    assert.match(native.detail, /服务状态异常/)
    assert.ok(native.hint)
  })

  it('steps disk status by remaining space', () => {
    assert.equal(itemOf(baseInput({ diskFreeGb: 20 }), 'disk').status, 'ok')
    assert.equal(itemOf(baseInput({ diskFreeGb: SELF_CHECK_DISK_WARN_GB - 1 }), 'disk').status, 'warn')
    assert.equal(itemOf(baseInput({ diskFreeGb: SELF_CHECK_DISK_FAIL_GB - 1 }), 'disk').status, 'fail')
    assert.match(itemOf(baseInput({ diskFreeGb: 1 }), 'disk').hint ?? '', /清理磁盘/)
  })

  it('warns on small memory hosts about caves', () => {
    const small = itemOf(baseInput({ memoryTotalMb: 4096 }), 'memory')
    assert.equal(small.status, 'warn')
    assert.ok(small.hint)
    assert.equal(itemOf(baseInput({ memoryTotalMb: 8192 }), 'memory').status, 'ok')
  })

  it('fails when a data directory is not writable and names it', () => {
    const item = itemOf(baseInput({
      writablePaths: [
        { label: '实例目录', path: '/data/instances', writable: true },
        { label: '备份目录', path: '/data/backups', writable: false },
        { label: '日志目录', path: '/data/logs', writable: false },
      ],
    }), 'paths')
    assert.equal(item.status, 'fail')
    assert.match(item.detail, /备份目录、日志目录不可写/)
  })

  it('walks instance state from none to abnormal', () => {
    assert.equal(itemOf(baseInput({ instanceCount: 0 }), 'instances').status, 'skipped')
    assert.equal(itemOf(baseInput({ instanceCount: 3, errorInstanceCount: 0 }), 'instances').status, 'ok')
    const abnormal = itemOf(baseInput({ instanceCount: 3, errorInstanceCount: 2 }), 'instances')
    assert.equal(abnormal.status, 'warn')
    assert.match(abnormal.detail, /2 个处于异常状态/)
  })

  it('treats disabled notifications as skipped and failing channels as a warning', () => {
    assert.equal(itemOf(baseInput({ notifyEnabled: false }), 'notify').status, 'skipped')
    const failing = itemOf(baseInput({ failingChannelCount: 2 }), 'notify')
    assert.equal(failing.status, 'warn')
    assert.match(failing.detail, /2 个渠道/)
  })

  it('warns but does not fail when SteamCMD is not ready yet', () => {
    const item = itemOf(baseInput({ steamcmdReady: false }), 'steamcmd')
    assert.equal(item.status, 'warn')
    assert.ok(item.hint)
  })

  it('counts every status in the summary', () => {
    const report = buildSelfCheckReport(baseInput({
      instanceCount: 0,
      notifyEnabled: false,
      diskFreeGb: 1,
      steamcmdReady: false,
    }))
    const counted = report.summary.ok + report.summary.warn + report.summary.fail + report.summary.skipped
    assert.equal(counted, report.items.length)
    assert.equal(report.summary.fail, 1)
    assert.equal(report.summary.skipped, 2)
  })
})
