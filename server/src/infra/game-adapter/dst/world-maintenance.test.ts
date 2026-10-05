import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  buildResetWorldCommand,
  buildRollbackCommand,
  listShardSnapshots,
  readMaxSnapshots,
  validateRollbackSteps,
  warnWhenStepsExceedSnapshots,
} from './world-maintenance'
import { SHARD_ROLLBACK_STEPS_LIMIT } from '../../../../../shared/contracts/shard'
import { resolveClusterPaths } from './cluster-service'
import { resolveShardSaveDir } from './shard-layout'

const tempDirs: string[] = []

function createTempInstallDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-world-maintenance-'))
  tempDirs.push(dir)
  return dir
}

function writeClusterIni(installPath: string, maxSnapshots: number): void {
  const { clusterRoot, clusterIniPath } = resolveClusterPaths(installPath)
  fs.mkdirSync(clusterRoot, { recursive: true })
  fs.writeFileSync(clusterIniPath, [
    '[NETWORK]',
    'cluster_name = Test Room',
    '',
    '[GAMEPLAY]',
    'max_players = 6',
    '',
    '[MISC]',
    `max_snapshots = ${maxSnapshots}`,
    '',
  ].join('\n'), 'utf8')
}

function createSnapshot(installPath: string, sessionId: string, modifiedAt: string): void {
  const sessionDir = path.join(resolveShardSaveDir(installPath, 'master'), 'session', sessionId)
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.utimesSync(sessionDir, new Date(modifiedAt), new Date(modifiedAt))
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('world-maintenance', () => {
  it('builds the documented console commands', () => {
    assert.equal(buildRollbackCommand(2), 'c_rollback(2)')
    assert.equal(buildResetWorldCommand(), 'c_reset()')
  })

  it('returns an empty snapshot list when the shard has no save directory', () => {
    const installPath = createTempInstallDir()
    assert.deepEqual(listShardSnapshots(installPath, 'master'), [])
  })

  it('lists snapshot directories by modification time, newest first', () => {
    const installPath = createTempInstallDir()
    createSnapshot(installPath, 'older', '2026-01-01T00:00:00.000Z')
    createSnapshot(installPath, 'newer', '2026-03-01T00:00:00.000Z')
    createSnapshot(installPath, 'middle', '2026-02-01T00:00:00.000Z')
    // 非目录条目不应出现在结果里
    fs.writeFileSync(path.join(resolveShardSaveDir(installPath, 'master'), 'session', 'index'), 'x')

    const snapshots = listShardSnapshots(installPath, 'master')
    assert.deepEqual(snapshots.map(item => item.id), ['newer', 'middle', 'older'])
    assert.equal(snapshots[0]!.savedAt, '2026-03-01T00:00:00.000Z')
  })

  it('keeps shards independent', () => {
    const installPath = createTempInstallDir()
    createSnapshot(installPath, 'master-session', '2026-01-01T00:00:00.000Z')
    assert.equal(listShardSnapshots(installPath, 'master').length, 1)
    assert.equal(listShardSnapshots(installPath, 'caves').length, 0)
  })

  it('reads the snapshot retention from the room config, defaulting to 6', () => {
    const installPath = createTempInstallDir()
    assert.equal(readMaxSnapshots(installPath), 6)
    writeClusterIni(installPath, 10)
    assert.equal(readMaxSnapshots(installPath), 10)
  })

  it('validates rollback steps against the configured retention', () => {
    assert.deepEqual(validateRollbackSteps(1, 6), [])
    assert.deepEqual(validateRollbackSteps(6, 6), [])
    assert.match(validateRollbackSteps(0, 6)[0]!, /大于 0 的整数/)
    assert.match(validateRollbackSteps(1.5, 6)[0]!, /大于 0 的整数/)
    assert.match(validateRollbackSteps(7, 6)[0]!, /快照保留数量/)
    assert.match(validateRollbackSteps(SHARD_ROLLBACK_STEPS_LIMIT + 1, 200)[0]!, /不能超过 99/)
  })

  it('warns instead of blocking when steps exceed the readable snapshots', () => {
    assert.equal(warnWhenStepsExceedSnapshots(3, 5), null)
    assert.equal(warnWhenStepsExceedSnapshots(3, 0), null)
    assert.match(warnWhenStepsExceedSnapshots(3, 2)!, /只读到 2 个存档点/)
  })
})
