import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { DbGameInstance } from '../../../shared/db/index'
import { getClusterConfig, resolveInstanceInstallPath, saveClusterConfig } from './cluster-service'
import { resolveCavesServerIniPath } from './shard-layout'

const tempDirs: string[] = []

function createTempInstallDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-cluster-'))
  tempDirs.push(dir)
  return dir
}

function buildInstance(installPath: string | null, id = 'test-instance'): DbGameInstance {
  return {
    id,
    nodeId: 'local-node',
    name: 'Test DST',
    gameCode: '343050',
    status: 'stopped',
    installPath,
    configPath: null,
    queryPort: null,
    gamePort: 10999,
    rconPort: null,
    containerId: null,
    runtimePid: null,
    runtimeStartedAt: null,
    lastCommand: null,
    lastError: null,
    lastErrorPhase: null,
    runtimeWarning: null,
    lastExitCode: null,
    unexpectedExitAt: null,
    installPercent: null,
    installLogStatus: null,
    installLogUpdatedAt: null,
    updateAvailable: false,
    localBuildId: null,
    remoteBuildId: null,
    updateCheckedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('cluster-service', () => {
  it('resolves install path from db value', () => {
    const installPath = createTempInstallDir()
    assert.equal(resolveInstanceInstallPath(buildInstance(installPath)), installPath)
  })

  it('persists cluster.ini and reads it back after save', () => {
    const installPath = createTempInstallDir()
    const instance = buildInstance(installPath)
    saveClusterConfig(instance, {
      instanceId: instance.id,
      networkMode: 'offline',
      clusterName: 'My Saved Room',
      clusterDescription: 'desc',
      clusterPassword: 'pwd',
      gameMode: 'survival',
      maxPlayers: 10,
      pvp: true,
      pauseWhenEmpty: false,
      voteEnabled: true,
      clusterIntention: 'cooperative',
      tickRate: 20,
      maxSnapshots: 8,
      shardEnabled: true,
      bindIp: '127.0.0.1',
      masterIp: '127.0.0.1',
      masterPort: 10999,
      clusterKey: 'secret-key',
      steamGroupOnly: false,
      steamGroupId: '12345',
      steamGroupAdmins: false,
    })

    const loaded = getClusterConfig(instance)
    assert.equal(loaded.clusterName, 'My Saved Room')
    assert.equal(loaded.clusterTokenMasked, null)
    assert.equal(loaded.maxPlayers, 10)
    assert.equal(loaded.pvp, true)
    assert.equal(loaded.shardEnabled, true)
    assert.equal(loaded.steamGroupId, '12345')
  })

  it('does not return plaintext cluster token on read', () => {
    const installPath = createTempInstallDir()
    const instance = buildInstance(installPath)
    const token = 'pds-g^KU_testtoken123='
    saveClusterConfig(instance, {
      instanceId: instance.id,
      networkMode: 'public',
      clusterName: 'Public Room',
      clusterDescription: '',
      clusterPassword: 'room-secret',
      gameMode: 'survival',
      maxPlayers: 6,
      pvp: false,
      pauseWhenEmpty: true,
      voteEnabled: true,
      clusterIntention: 'cooperative',
      tickRate: 15,
      maxSnapshots: 6,
      shardEnabled: false,
      bindIp: '127.0.0.1',
      masterIp: '127.0.0.1',
      masterPort: 10888,
      clusterKey: 'supersecretkey',
      steamGroupOnly: false,
      steamGroupId: '0',
      steamGroupAdmins: false,
      clusterToken: token,
    })

    const loaded = getClusterConfig(instance)
    assert.equal(loaded.clusterPassword, 'room-secret')
    assert.equal(loaded.clusterTokenConfigured, true)
    assert.match(loaded.clusterTokenMasked ?? '', /^pds-\*\*\*\*/)
    assert.ok(!('clusterToken' in loaded))
  })

  it('auto-scaffolds caves config when enabling shard on room save', () => {
    const installPath = createTempInstallDir()
    const instance = buildInstance(installPath)
    saveClusterConfig(instance, {
      instanceId: instance.id,
      networkMode: 'offline',
      clusterName: 'Shard Room',
      clusterDescription: '',
      clusterPassword: '',
      gameMode: 'survival',
      maxPlayers: 6,
      pvp: false,
      pauseWhenEmpty: true,
      voteEnabled: true,
      clusterIntention: 'cooperative',
      tickRate: 15,
      maxSnapshots: 6,
      shardEnabled: true,
      bindIp: '127.0.0.1',
      masterIp: '127.0.0.1',
      masterPort: 10888,
      clusterKey: 'secret-key',
      steamGroupOnly: false,
      steamGroupId: '0',
      steamGroupAdmins: false,
    })
    const cavesIni = resolveCavesServerIniPath(installPath)
    assert.ok(fs.existsSync(cavesIni))
    const content = fs.readFileSync(cavesIni, 'utf8')
    assert.match(content, /is_master = false/)
    assert.match(content, /server_port = 11000/)
  })

  it('reports caves-not-ready as a warning instead of a hint', () => {
    const installPath = createTempInstallDir()
    const instance = buildInstance(installPath)
    saveClusterConfig(instance, {
      instanceId: instance.id,
      networkMode: 'offline',
      clusterName: 'Shard Room',
      clusterDescription: '',
      clusterPassword: '',
      gameMode: 'survival',
      maxPlayers: 6,
      pvp: false,
      pauseWhenEmpty: true,
      voteEnabled: true,
      clusterIntention: 'cooperative',
      tickRate: 15,
      maxSnapshots: 6,
      shardEnabled: true,
      bindIp: '127.0.0.1',
      masterIp: '127.0.0.1',
      masterPort: 10888,
      clusterKey: 'secret-key',
      steamGroupOnly: false,
      steamGroupId: '0',
      steamGroupAdmins: false,
    })
    // 洞穴配置就绪：无异常，提示恒为空（说明已内联到页面）
    const ready = getClusterConfig(instance)
    assert.deepEqual(ready.warnings, [])
    assert.deepEqual(ready.effectiveHints, [])

    // 洞穴配置缺失：降级为「需要处理」的警告，而不是常驻提示
    fs.rmSync(path.dirname(resolveCavesServerIniPath(installPath)), { recursive: true, force: true })
    const missing = getClusterConfig(instance)
    assert.match(missing.warnings.join('；'), /洞穴配置尚未就绪/)
    assert.deepEqual(missing.effectiveHints, [])
  })

  it('keeps caves files when disabling shard on room save', () => {
    const installPath = createTempInstallDir()
    const instance = buildInstance(installPath)
    const payload = {
      instanceId: instance.id,
      networkMode: 'offline' as const,
      clusterName: 'Shard Room',
      clusterDescription: '',
      clusterPassword: '',
      gameMode: 'survival' as const,
      maxPlayers: 6,
      pvp: false,
      pauseWhenEmpty: true,
      voteEnabled: true,
      clusterIntention: 'cooperative' as const,
      tickRate: 15,
      maxSnapshots: 6,
      shardEnabled: true,
      bindIp: '127.0.0.1',
      masterIp: '127.0.0.1',
      masterPort: 10888,
      clusterKey: 'secret-key',
      steamGroupOnly: false,
      steamGroupId: '0',
      steamGroupAdmins: false,
    }
    saveClusterConfig(instance, payload)
    assert.ok(fs.existsSync(resolveCavesServerIniPath(installPath)))
    saveClusterConfig(instance, { ...payload, shardEnabled: false })
    assert.ok(fs.existsSync(resolveCavesServerIniPath(installPath)))
    const loaded = getClusterConfig(instance)
    assert.equal(loaded.shardEnabled, false)
  })
})
