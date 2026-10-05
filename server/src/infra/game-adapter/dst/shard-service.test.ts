import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { DbGameInstance } from '../../../shared/db/index'
import { ensureDstClusterConfig } from './cluster-config'
import { resolveClusterPaths, saveClusterConfig } from './cluster-service'
import { initCavesShard, saveShardConfig } from './shard-service'
import {
  isCavesShardConfigured,
  isShardWorldGenerated,
  resolveShardLeveldataPath,
  resolveShardSaveDir,
  resolveShardWorldgenPath,
} from './shard-layout'
import { parseWorldgenOverride } from './worldgen-override'
import { readWorldSeeds } from './panel-config-meta'
const tempDirs: string[] = []

function makeTempInstall(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-shard-svc-'))
  tempDirs.push(dir)
  return dir
}

function makeInstance(installPath: string, overrides: Partial<DbGameInstance> = {}): DbGameInstance {
  return {
    id: 'test-instance',
    name: 'Test',
    nodeId: 'local-node',
    gameCode: '343050',
    status: 'stopped',
    installPath,
    gamePort: 10999,
    containerId: null,
    runtimePid: null,
    runtimeStartedAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as DbGameInstance
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('shard-service', () => {
  it('initCavesShard creates caves config idempotently', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { instanceName: 'Test', gamePort: 10999 })
    const instance = makeInstance(installPath)
    const first = initCavesShard(instance)
    assert.equal(first.alreadyConfigured, false)
    assert.equal(isCavesShardConfigured(installPath), true)
    const second = initCavesShard(instance)
    assert.equal(second.alreadyConfigured, true)
  })

  it('saveShardConfig rejects conflicting caves port', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { gamePort: 10999 })
    const instance = makeInstance(installPath)
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
    assert.throws(
      () => saveShardConfig(instance, {
        instanceId: instance.id,
        shard: 'caves',
        serverPort: 10999,
        steamAuthPort: 8768,
        steamMasterPort: 12348,
        worldgenPreset: 'DST_CAVE',
      }),
      /不能相同|重复/,
    )
  })

  it('rejects saving caves when room shard is disabled', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { gamePort: 10999 })
    const instance = makeInstance(installPath)
    initCavesShard(instance)
    assert.throws(
      () => saveShardConfig(instance, {
        instanceId: instance.id,
        shard: 'caves',
        serverPort: 11000,
        steamAuthPort: 8768,
        steamMasterPort: 12348,
        worldgenPreset: 'DST_CAVE',
      }),
      /洞穴未开启/,
    )
  })

  it('saveShardConfig writes master worldgen', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { gamePort: 10999 })
    const instance = makeInstance(installPath)
    saveShardConfig(instance, {
      instanceId: instance.id,
      shard: 'master',
      serverPort: 11001,
      steamAuthPort: 8766,
      steamMasterPort: 12346,
      worldgenPreset: 'SURVIVAL_TOGETHER',
    })
    const { clusterRoot } = resolveClusterPaths(installPath)
    const ini = fs.readFileSync(path.join(clusterRoot, 'Master', 'server.ini'), 'utf8')
    assert.match(ini, /server_port = 11001/)
  })

  it('saveShardConfig writes preset and world rules into worldgenoverride.lua', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { gamePort: 10999 })
    const instance = makeInstance(installPath)
    saveShardConfig(instance, {
      instanceId: instance.id,
      shard: 'master',
      serverPort: 10999,
      steamAuthPort: 8766,
      steamMasterPort: 12346,
      worldgenPreset: 'SURVIVAL_TOGETHER',
      worldRuleOverrides: { krampus: 'often', day: 'longer' },
      worldgenOverrides: { branching: 'most' },
    })
    const luaPath = resolveShardWorldgenPath(installPath, 'master')
    assert.ok(fs.existsSync(luaPath))
    const parsed = parseWorldgenOverride(fs.readFileSync(luaPath, 'utf8'))
    // 预设与覆盖项必须写在同一个文件：DST 会用它整份替换 world.options
    assert.equal(parsed.preset, 'SURVIVAL_TOGETHER')
    assert.equal(parsed.overrides.krampus, 'often')
    assert.equal(parsed.overrides.day, 'longer')
    assert.equal(parsed.overrides.branching, 'most')
    // 面板不再写 leveldataoverride.lua（会被上面的文件整份覆盖）
    assert.equal(fs.existsSync(resolveShardLeveldataPath(installPath, 'master')), false)
  })

  it('saveShardConfig migrates a legacy leveldataoverride.lua before applying the patch', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { gamePort: 10999 })
    const instance = makeInstance(installPath)
    const legacyPath = resolveShardLeveldataPath(installPath, 'master')
    fs.writeFileSync(legacyPath, [
      'return {',
      '  overrides={',
      '    world_size="small",',
      '  },',
      '}',
      '',
    ].join('\n'), 'utf8')
    saveShardConfig(instance, {
      instanceId: instance.id,
      shard: 'master',
      serverPort: 10999,
      steamAuthPort: 8766,
      steamMasterPort: 12346,
      worldgenPreset: 'SURVIVAL_TOGETHER',
      worldRuleOverrides: { krampus: 'often' },
    })
    assert.equal(fs.existsSync(legacyPath), false)
    const parsed = parseWorldgenOverride(fs.readFileSync(resolveShardWorldgenPath(installPath, 'master'), 'utf8'))
    assert.equal(parsed.overrides.world_size, 'small')
    assert.equal(parsed.overrides.krampus, 'often')
  })

  it('rejects worldgen overrides after world is generated', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { gamePort: 10999 })
    const instance = makeInstance(installPath)
    const saveDir = resolveShardSaveDir(installPath, 'master')
    fs.mkdirSync(saveDir, { recursive: true })
    fs.writeFileSync(path.join(saveDir, 'session'), 'x')
    assert.equal(isShardWorldGenerated(installPath, 'master'), true)
    assert.throws(
      () => saveShardConfig(instance, {
        instanceId: instance.id,
        shard: 'master',
        serverPort: 10999,
        steamAuthPort: 8766,
        steamMasterPort: 12346,
        worldgenPreset: 'SURVIVAL_TOGETHER',
        worldgenOverrides: { branching: 'most' },
      }),
      /已生成/,
    )
  })

  it('saves, keeps, clears and validates the world seed', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { instanceName: 'Test', gamePort: 10999 })
    const instance = makeInstance(installPath)
    const base = {
      instanceId: instance.id,
      shard: 'master' as const,
      serverPort: 10999,
      steamAuthPort: 8766,
      steamMasterPort: 12346,
      worldgenPreset: 'SURVIVAL_TOGETHER' as const,
    }

    saveShardConfig(instance, { ...base, worldSeed: '1608382646' })
    assert.deepEqual(readWorldSeeds(installPath), { master: '1608382646' })

    // 省略字段 = 不变更（与其余差异提交字段一致）
    saveShardConfig(instance, { ...base })
    assert.deepEqual(readWorldSeeds(installPath), { master: '1608382646' })

    assert.throws(() => saveShardConfig(instance, { ...base, worldSeed: '12a' }), /位数字/)
    assert.deepEqual(readWorldSeeds(installPath), { master: '1608382646' })

    // null = 清除，回到游戏随机
    saveShardConfig(instance, { ...base, worldSeed: null })
    assert.deepEqual(readWorldSeeds(installPath), {})
  })

  it('allows changing the world seed after the world is generated', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { gamePort: 10999 })
    const instance = makeInstance(installPath)
    const saveDir = resolveShardSaveDir(installPath, 'master')
    fs.mkdirSync(saveDir, { recursive: true })
    fs.writeFileSync(path.join(saveDir, 'session'), 'x')
    assert.equal(isShardWorldGenerated(installPath, 'master'), true)

    // 种子只在下一次生成地图时被读取，与地图生成参数不同，不设「世界已生成」闸门
    saveShardConfig(instance, {
      instanceId: instance.id,
      shard: 'master',
      serverPort: 10999,
      steamAuthPort: 8766,
      steamMasterPort: 12346,
      worldgenPreset: 'SURVIVAL_TOGETHER',
      worldSeed: '777',
    })
    assert.deepEqual(readWorldSeeds(installPath), { master: '777' })
  })
})
