import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { ensureDstClusterConfig } from './cluster-config'
import { isCavesShardConfigured, isShardWorldGenerated, removeShardSaveDir, resolveShardSaveDir } from './shard-layout'

const tempDirs: string[] = []

function makeTempInstall(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-shard-layout-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('shard-layout', () => {
  it('reports caves not configured until server.ini exists', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { gamePort: 10999 })
    assert.equal(isCavesShardConfigured(installPath), false)
  })

  it('isShardWorldGenerated is false without save dir', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { gamePort: 10999 })
    assert.equal(isShardWorldGenerated(installPath, 'master'), false)
  })

  it('isShardWorldGenerated is true when save dir has files', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { gamePort: 10999 })
    const saveDir = resolveShardSaveDir(installPath, 'master')
    fs.mkdirSync(saveDir, { recursive: true })
    fs.writeFileSync(path.join(saveDir, 'session'), '1')
    assert.equal(isShardWorldGenerated(installPath, 'master'), true)
  })

  it('removeShardSaveDir discards one world without touching the other shard', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { gamePort: 10999 })
    for (const shardId of ['master', 'caves'] as const) {
      const sessionDir = path.join(resolveShardSaveDir(installPath, shardId), 'session', 's1')
      fs.mkdirSync(sessionDir, { recursive: true })
      fs.writeFileSync(path.join(sessionDir, 'level'), 'x')
    }
    assert.equal(isShardWorldGenerated(installPath, 'master'), true)
    assert.equal(isShardWorldGenerated(installPath, 'caves'), true)

    removeShardSaveDir(installPath, 'master')
    // 存档清空后世界回到「未生成」，下次启动时游戏会重新生成地图
    assert.equal(isShardWorldGenerated(installPath, 'master'), false)
    assert.equal(isShardWorldGenerated(installPath, 'caves'), true)
  })

  it('removeShardSaveDir tolerates a shard that never generated a world', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { gamePort: 10999 })
    assert.doesNotThrow(() => removeShardSaveDir(installPath, 'caves'))
  })
})
