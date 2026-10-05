import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  collectPlayerNameHintsFromGameLogs,
  mergePlayerNameHints,
  parsePlayerNameHints,
  resolveShardServerLogPath,
} from './player-name-hints'

/** 面板在线查询注入的标记行（真实格式，见实例控制台日志） */
function panelItemLine(kuId: string, name: string, token = '46b76c14'): string {
  return `2026-09-15T12:16:02.325Z [master] [01:27:28]: BSP_PLAYER_LIST_ITEM:${token}:${kuId}\t${name}\t`
}

describe('parsePlayerNameHints', () => {
  it('reads the id and name from a panel query marker line', () => {
    assert.deepEqual(parsePlayerNameHints([panelItemLine('KU_Mjned0Ap', '泡面艺术家')]), [
      { kuId: 'KU_Mjned0Ap', name: '泡面艺术家' },
    ])
  })

  it('keeps a name that contains spaces', () => {
    assert.deepEqual(parsePlayerNameHints([panelItemLine('KU_abc123', '泡面 艺术家')]), [
      { kuId: 'KU_abc123', name: '泡面 艺术家' },
    ])
  })

  it('accepts a marker line whose name is empty', () => {
    assert.deepEqual(parsePlayerNameHints([panelItemLine('KU_abc123', '')]), [
      { kuId: 'KU_abc123', name: '' },
    ])
  })

  it('still understands a Client authenticated line', () => {
    assert.deepEqual(parsePlayerNameHints([
      '[00:01:02]: Client authenticated: (KU_abc123) Wilson',
    ]), [{ kuId: 'KU_abc123', name: 'Wilson' }])
  })

  it('cuts off the rest of the sentence on an authenticated line', () => {
    const hints = parsePlayerNameHints([
      '[00:01:02]: Client authenticated: (KU_abc123) Wilson has joined the server',
    ])
    assert.equal(hints[0].name, 'Wilson')
  })

  /**
   * 真实服务器日志里大量出现这两行，它们**不含**玩家名。
   * 早期实现会从 ID 后面取一段当名字，于是档案里出现「from TokenPurpose」。
   */
  it('never takes the tail of a Received line as a name', () => {
    const lines = [
      '[00:00:12]: Received (KU_Mjned0Ap) from TokenPurpose',
      '[00:00:12]: [ClientObject] Initialized (self/server object, locally trusted) on server: guid=12647916929299593351 userid=KU_Mjned0Ap netid= admin=1',
    ]
    assert.deepEqual(parsePlayerNameHints(lines), [])
  })

  it('ignores log lines that only mention an id', () => {
    assert.deepEqual(parsePlayerNameHints([
      '[00:01:02]: kicking KU_abc123',
      '[00:01:02]: ban KU_abc123 scripts/main.lua',
    ]), [])
  })

  it('keeps the earlier name when a later line has none', () => {
    const hints = parsePlayerNameHints([
      panelItemLine('KU_abc123', 'Wilson', 'aaaaaaaa'),
      panelItemLine('KU_abc123', '', 'bbbbbbbb'),
    ])
    assert.equal(hints.length, 1)
    assert.equal(hints[0].name, 'Wilson')
  })

  it('lets a rename win over the older name', () => {
    const hints = parsePlayerNameHints([
      panelItemLine('KU_abc123', 'Wilson', 'aaaaaaaa'),
      panelItemLine('KU_abc123', 'Wilson Reborn', 'bbbbbbbb'),
    ])
    assert.equal(hints[0].name, 'Wilson Reborn')
  })

  it('is case insensitive when de-duplicating ids', () => {
    const hints = parsePlayerNameHints([
      panelItemLine('KU_ABC123', 'Wilson', 'aaaaaaaa'),
      panelItemLine('KU_abc123', 'Willow', 'bbbbbbbb'),
    ])
    assert.equal(hints.length, 1)
    assert.equal(hints[0].name, 'Willow')
  })

  it('returns nothing for logs without any player id', () => {
    assert.deepEqual(parsePlayerNameHints(['[00:00:00]: Sim paused', '']), [])
  })
})

describe('mergePlayerNameHints', () => {
  it('prefers a batch that knows the name', () => {
    const merged = mergePlayerNameHints([
      [{ kuId: 'KU_a1', name: '' }],
      [{ kuId: 'KU_A1', name: 'Wilson' }],
    ])
    assert.deepEqual(merged, [{ kuId: 'KU_A1', name: 'Wilson' }])
  })
})

describe('collectPlayerNameHintsFromGameLogs', () => {
  it('reads both shard logs and merges the results', () => {
    const installPath = mkdtempSync(path.join(os.tmpdir(), 'bsp-name-hints-'))
    try {
      const masterLog = resolveShardServerLogPath(installPath, 'master')
      const cavesLog = resolveShardServerLogPath(installPath, 'caves')
      fs.mkdirSync(path.dirname(masterLog), { recursive: true })
      fs.mkdirSync(path.dirname(cavesLog), { recursive: true })
      fs.writeFileSync(masterLog, '[00:01:02]: Client authenticated: (KU_abc123) Wilson\n', 'utf8')
      fs.writeFileSync(cavesLog, '[00:02:02]: Client authenticated: (KU_xyz789) 挖矿的\n', 'utf8')

      const hints = collectPlayerNameHintsFromGameLogs(installPath)
      assert.deepEqual(
        hints.map(hint => hint.kuId).sort(),
        ['KU_abc123', 'KU_xyz789'],
      )
    }
    finally {
      rmSync(installPath, { recursive: true, force: true })
    }
  })

  it('returns an empty list when no log exists yet', () => {
    const installPath = mkdtempSync(path.join(os.tmpdir(), 'bsp-name-hints-empty-'))
    try {
      assert.deepEqual(collectPlayerNameHintsFromGameLogs(installPath), [])
    }
    finally {
      rmSync(installPath, { recursive: true, force: true })
    }
  })
})
