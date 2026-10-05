import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildDstOnlinePlayerCountCommand,
  buildDstOnlinePlayersCommand,
  DST_ONLINE_PLAYER_COUNT_MARKER,
  DST_ONLINE_PLAYER_LIST_BEGIN_MARKER,
  DST_ONLINE_PLAYER_LIST_END_MARKER,
  DST_ONLINE_PLAYER_LIST_ITEM_MARKER,
  parseDstOnlinePlayerCountLine,
  parseDstOnlinePlayerList,
  resolvePlayerLocation,
} from './online-players'

describe('buildDstOnlinePlayerCountCommand', () => {
  it('uses AllPlayers and embeds query token', () => {
    const command = buildDstOnlinePlayerCountCommand('a1b2c3d4')
    assert.match(command, /#AllPlayers/)
    assert.match(command, /BSP_PLAYER_COUNT:a1b2c3d4:/)
    assert.doesNotMatch(command, /GetClientTable/)
  })
})

describe('parseDstOnlinePlayerCountLine', () => {
  it('parses marker line from stdout', () => {
    assert.equal(
      parseDstOnlinePlayerCountLine(`${DST_ONLINE_PLAYER_COUNT_MARKER}3`),
      3,
    )
  })

  it('parses marker with query token', () => {
    assert.equal(
      parseDstOnlinePlayerCountLine(`${DST_ONLINE_PLAYER_COUNT_MARKER}a1b2c3d4:3`, 'a1b2c3d4'),
      3,
    )
  })

  it('ignores marker lines from other query tokens', () => {
    assert.equal(
      parseDstOnlinePlayerCountLine(`${DST_ONLINE_PLAYER_COUNT_MARKER}deadbeef:2`, 'a1b2c3d4'),
      null,
    )
  })

  it('parses marker embedded in longer log line', () => {
    assert.equal(
      parseDstOnlinePlayerCountLine(`[00:01:02]: ${DST_ONLINE_PLAYER_COUNT_MARKER}0`),
      0,
    )
    assert.equal(
      parseDstOnlinePlayerCountLine(`[00:01:02]: ${DST_ONLINE_PLAYER_COUNT_MARKER}beef:0`, 'beef'),
      0,
    )
  })

  it('returns null for unrelated lines', () => {
    assert.equal(parseDstOnlinePlayerCountLine('Server is ready'), null)
    assert.equal(parseDstOnlinePlayerCountLine(`${DST_ONLINE_PLAYER_COUNT_MARKER}-1`), null)
  })
})

describe('buildDstOnlinePlayersCommand', () => {
  it('emits the begin, item and end markers with the query token', () => {
    const command = buildDstOnlinePlayersCommand('a1b2c3d4')
    assert.match(command, /BSP_PLAYER_LIST_BEGIN:a1b2c3d4:/)
    assert.match(command, /BSP_PLAYER_LIST_ITEM:a1b2c3d4:/)
    assert.match(command, /BSP_PLAYER_LIST_END:a1b2c3d4/)
    assert.match(command, /pairs\(AllPlayers\)/)
  })

  it('reports the count in the begin marker and separates id from name with a tab', () => {
    const command = buildDstOnlinePlayersCommand('a1b2c3d4')
    assert.match(command, /#AllPlayers/)
    // 生成的 Lua 源码里是转义的 \t，由 Lua 解析成制表符
    assert.match(command, /\\t/)
    assert.match(command, /player\.userid/)
    assert.match(command, /player\.name/)
  })

  it('never falls back to GetClientTable', () => {
    assert.doesNotMatch(buildDstOnlinePlayersCommand('a1b2c3d4'), /GetClientTable/)
  })
})

const TOKEN = 'a1b2c3d4'

function beginLine(count: number): string {
  return `${DST_ONLINE_PLAYER_LIST_BEGIN_MARKER}${TOKEN}:${count}`
}

function itemLine(kuId: string, name: string): string {
  return `${DST_ONLINE_PLAYER_LIST_ITEM_MARKER}${TOKEN}:${kuId}\t${name}`
}

const END_LINE = `${DST_ONLINE_PLAYER_LIST_END_MARKER}${TOKEN}`

describe('parseDstOnlinePlayerList', () => {
  it('parses every player between the begin and end markers', () => {
    assert.deepEqual(parseDstOnlinePlayerList([
      beginLine(2),
      itemLine('KU_aaa', '玩家甲'),
      itemLine('KU_bbb', '玩家乙'),
      END_LINE,
    ], TOKEN), {
      count: 2,
      players: [
        { kuId: 'KU_aaa', name: '玩家甲', kleiAccount: true, key: 'ku_aaa' },
        { kuId: 'KU_bbb', name: '玩家乙', kleiAccount: true, key: 'ku_bbb' },
      ],
    })
  })

  it('keeps names that contain spaces and colons', () => {
    const parsed = parseDstOnlinePlayerList([
      beginLine(1),
      itemLine('KU_aaa', '画 家: 范画'),
      END_LINE,
    ], TOKEN)
    assert.equal(parsed?.players[0].name, '画 家: 范画')
  })

  it('accepts an empty name', () => {
    const parsed = parseDstOnlinePlayerList([
      beginLine(1),
      itemLine('KU_aaa', ''),
      END_LINE,
    ], TOKEN)
    assert.equal(parsed?.players[0].name, '')
  })

  it('tolerates the DST log prefix on every line', () => {
    const parsed = parseDstOnlinePlayerList([
      `[00:56:49]: ${beginLine(1)}`,
      `[00:56:49]: ${itemLine('KU_aaa', '玩家甲')}`,
      `[00:56:49]: ${END_LINE}`,
    ], TOKEN)
    assert.deepEqual(parsed?.players, [{ kuId: 'KU_aaa', name: '玩家甲', kleiAccount: true, key: 'ku_aaa' }])
  })

  it('returns null when the end marker never arrives', () => {
    // 残缺名单比查不到更糟：会被当成「某人已经掉线」
    assert.equal(parseDstOnlinePlayerList([
      beginLine(2),
      itemLine('KU_aaa', '玩家甲'),
    ], TOKEN), null)
  })

  it('returns null for an empty log window', () => {
    assert.equal(parseDstOnlinePlayerList([], TOKEN), null)
  })

  it('ignores markers belonging to another query token', () => {
    assert.equal(parseDstOnlinePlayerList([
      `${DST_ONLINE_PLAYER_LIST_BEGIN_MARKER}deadbeef:1`,
      `${DST_ONLINE_PLAYER_LIST_ITEM_MARKER}deadbeef:KU_aaa\t玩家甲`,
      `${DST_ONLINE_PLAYER_LIST_END_MARKER}deadbeef`,
    ], TOKEN), null)
  })

  it('keeps a player whose userid is not a Klei id, flagged as a temporary identity', () => {
    // 离线 / 局域网进来的路人没有 Klei 账号，userid 形状不受面板控制。
    // 早先这里直接丢弃，导致「人数按 #AllPlayers 算上他、明细里却没有他」。
    const parsed = parseDstOnlinePlayerList([
      beginLine(2),
      itemLine('not-a-ku-id', '路人'),
      itemLine('KU_bbb', '玩家乙'),
      END_LINE,
    ], TOKEN)
    assert.equal(parsed?.count, 2)
    assert.deepEqual(parsed?.players, [
      { kuId: 'not-a-ku-id', name: '路人', kleiAccount: false, key: 'not-a-ku-id' },
      { kuId: 'KU_bbb', name: '玩家乙', kleiAccount: true, key: 'ku_bbb' },
    ])
  })

  it('keeps players the game gave no id for, with a unique key each', () => {
    // 空 userid 不能拿空串当 key：多人会互相覆盖，列表只剩一条
    const parsed = parseDstOnlinePlayerList([
      beginLine(2),
      itemLine('', '路人甲'),
      itemLine('', '路人乙'),
      END_LINE,
    ], TOKEN)
    assert.equal(parsed?.count, 2)
    assert.deepEqual(parsed?.players.map(player => player.kuId), ['', ''])
    assert.deepEqual(parsed?.players.map(player => player.key), ['unidentified-1', 'unidentified-2'])
    assert.deepEqual(parsed?.players.map(player => player.kleiAccount), [false, false])
  })

  it('ignores the echo of the panel query command', () => {
    // 游戏会把面板下发的整行 Lua 回显到日志里，它同样带着三个标记；
    // 回显行的 ID 段是源码片段（含引号与空格），不能被当成玩家
    const echo = `[00:01:02]: ${buildDstOnlinePlayersCommand(TOKEN)}`
    const parsed = parseDstOnlinePlayerList([
      echo,
      beginLine(1),
      itemLine('KU_aaa', '玩家甲'),
      END_LINE,
    ], TOKEN)
    assert.equal(parsed?.count, 1)
    assert.deepEqual(parsed?.players.map(player => player.kuId), ['KU_aaa'])
  })

  it('does not let the echoed end marker cut the list short', () => {
    // 回显行里的 END 若被当真，解析会在半路收工，后面的玩家全都丢掉
    const echo = `[00:01:02]: ${buildDstOnlinePlayersCommand(TOKEN)}`
    const parsed = parseDstOnlinePlayerList([
      beginLine(2),
      itemLine('KU_aaa', '玩家甲'),
      echo,
      itemLine('KU_bbb', '玩家乙'),
      END_LINE,
    ], TOKEN)
    assert.deepEqual(parsed?.players.map(player => player.kuId), ['KU_aaa', 'KU_bbb'])
  })

  it('treats a Klei id containing a dash as a Klei account', () => {
    // 实测真实 userid 形如 KU_3rpxG-xy：base64url 风格，含 `-`
    const parsed = parseDstOnlinePlayerList([
      beginLine(1),
      itemLine('KU_3rpxG-xy', '一颗奶糖啊'),
      END_LINE,
    ], TOKEN)
    assert.deepEqual(parsed?.players, [
      { kuId: 'KU_3rpxG-xy', name: '一颗奶糖啊', kleiAccount: true, key: 'ku_3rpxg-xy' },
    ])
  })

  it('de-duplicates a player reported twice', () => {
    const parsed = parseDstOnlinePlayerList([
      beginLine(1),
      itemLine('KU_aaa', '玩家甲'),
      itemLine('KU_AAA', '玩家甲'),
      END_LINE,
    ], TOKEN)
    assert.equal(parsed?.players.length, 1)
    assert.equal(parsed?.players[0].kuId, 'KU_aaa')
  })

  it('falls back to the parsed length when the begin marker is missing', () => {
    const parsed = parseDstOnlinePlayerList([
      itemLine('KU_aaa', '玩家甲'),
      END_LINE,
    ], TOKEN)
    assert.equal(parsed?.count, 1)
  })

  it('treats an item without a tab as an empty name', () => {
    const parsed = parseDstOnlinePlayerList([
      beginLine(1),
      `${DST_ONLINE_PLAYER_LIST_ITEM_MARKER}${TOKEN}:KU_aaa`,
      END_LINE,
    ], TOKEN)
    assert.deepEqual(parsed?.players, [{ kuId: 'KU_aaa', name: '', kleiAccount: true, key: 'ku_aaa' }])
  })
})

describe('resolvePlayerLocation', () => {
  const inMaster = {
    shard: 'master' as const,
    players: [{ kuId: 'KU_aaa', name: '甲', kleiAccount: true, key: 'ku_aaa' }],
    count: 1,
  }
  const inCaves = {
    shard: 'caves' as const,
    players: [{ kuId: 'KU_bbb', name: '乙', kleiAccount: true, key: 'ku_bbb' }],
    count: 1,
  }

  it('locates a player in the shard that reports him', () => {
    assert.deepEqual(resolvePlayerLocation([inMaster, inCaves], 'KU_bbb'), {
      status: 'online',
      shard: 'caves',
    })
  })

  it('matches ids ignoring case', () => {
    assert.deepEqual(resolvePlayerLocation([inMaster, inCaves], 'ku_aaa'), {
      status: 'online',
      shard: 'master',
    })
  })

  it('reports offline only when every shard answered', () => {
    assert.deepEqual(resolvePlayerLocation([
      { shard: 'master', players: [], count: 0 },
      { shard: 'caves', players: [], count: 0 },
    ], 'KU_aaa'), { status: 'offline', shard: null })
  })

  it('never claims offline when a shard failed to answer', () => {
    // 洞穴没答上来时，人完全可能就在洞穴里
    assert.deepEqual(resolvePlayerLocation([
      { shard: 'master', players: [], count: 0 },
      { shard: 'caves', players: null, count: null },
    ], 'KU_aaa'), { status: 'unknown', shard: null })
  })

  it('reports unknown when nothing was queried at all', () => {
    assert.deepEqual(resolvePlayerLocation([], 'KU_aaa'), { status: 'unknown', shard: null })
  })
})
