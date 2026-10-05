import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { getPlayerList, savePlayerListForInstance } from './player-service'
import { resolveClusterPaths } from './cluster-service'

const tempDirs: string[] = []

function createTempInstallDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-player-service-'))
  tempDirs.push(dir)
  return dir
}

function writeClusterIni(installPath: string, whitelistSlots: number): void {
  const { clusterRoot, clusterIniPath } = resolveClusterPaths(installPath)
  fs.mkdirSync(clusterRoot, { recursive: true })
  fs.writeFileSync(clusterIniPath, [
    '[NETWORK]',
    'cluster_name = Test Room',
    `whitelist_slots = ${whitelistSlots}`,
    '',
    '[GAMEPLAY]',
    'max_players = 6',
    '',
  ].join('\n'), 'utf8')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('player-service', () => {
  it('reports an empty list when no file exists yet', () => {
    const installPath = createTempInstallDir()
    const dto = getPlayerList({ id: 'inst-1', installPath }, 'admin')
    assert.equal(dto.instanceId, 'inst-1')
    assert.equal(dto.kind, 'admin')
    assert.deepEqual(dto.entries, [])
    assert.equal(dto.fileExists, false)
    assert.deepEqual(dto.warnings, [])
    // cluster.ini 不存在时白名单预留位按 0 处理
    assert.equal(dto.whitelistSlots, 0)
  })

  it('reflects whitelist_slots from cluster.ini', () => {
    const installPath = createTempInstallDir()
    writeClusterIni(installPath, 4)
    assert.equal(getPlayerList({ id: 'inst-1', installPath }, 'whitelist').whitelistSlots, 4)
  })

  it('round-trips a saved list through the instance-facing API', () => {
    const installPath = createTempInstallDir()
    writeClusterIni(installPath, 0)
    const target = { id: 'inst-1', installPath }

    const saved = savePlayerListForInstance(target, 'block', [{ kuId: 'KU_banned01' }])
    assert.equal(saved.saved, true)
    assert.deepEqual(saved.entries, [{ kuId: 'KU_banned01' }])

    const dto = getPlayerList(target, 'block')
    assert.equal(dto.fileExists, true)
    assert.deepEqual(dto.entries, [{ kuId: 'KU_banned01' }])

    // 三个名单文件互相独立
    assert.deepEqual(getPlayerList(target, 'admin').entries, [])
    assert.equal(getPlayerList(target, 'admin').fileExists, false)
  })

  it('propagates invalid entries as a rejected save', () => {
    const installPath = createTempInstallDir()
    assert.throws(
      () => savePlayerListForInstance({ id: 'inst-1', installPath }, 'admin', [{ kuId: 'bad' }]),
      /玩家 ID 无效/,
    )
  })
})
