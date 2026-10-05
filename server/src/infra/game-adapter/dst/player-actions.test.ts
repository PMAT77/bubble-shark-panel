import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DST_CONSOLE_CLIENT_MARKER,
  DST_CONSOLE_HOST_MARKER,
  DST_CONSOLE_PING_MARKER,
  buildBanCommand,
  buildClientTableCommand,
  buildConsoleProbeCommand,
  buildDespawnCommand,
  buildKickCommand,
  createConsoleToken,
  hasConsolePing,
  isRoomOwner,
  isSafeCommandUserId,
  isValidKuId,
  parseClientRows,
  parseConsoleHostUserId,
} from './player-actions'

describe('buildKickCommand', () => {
  it('kicks through TheNet:Kick', () => {
    assert.match(buildKickCommand('KU_Mjne0Map'), /TheNet:Kick\(c\.userid\)/)
  })

  it('skips the dedicated server [Host] placeholder client', () => {
    // 专用服务器自己也是一条 client；集群令牌用的就是该玩家账号时，两者的 userid 会撞车，
    // 不过滤就会踢到那条假连接——玩家一动不动，游戏还不报任何错
    assert.match(buildKickCommand('KU_Mjne0Map'), /c\.performance==nil/)
  })

  it('matches only the requested id', () => {
    assert.match(buildKickCommand('KU_Mjne0Map'), /c\.userid=="KU_Mjne0Map"/)
  })

  it('does not fall back to the client-side c_kick helper', () => {
    // c_kick 不在 DST 服务端脚本里定义，命令送进去只会报 Lua 错、踢不掉人
    assert.doesNotMatch(buildKickCommand('KU_Mjne0Map'), /c_kick/)
  })

  it('trims surrounding whitespace', () => {
    assert.match(buildKickCommand('  KU_abc  '), /c\.userid=="KU_abc"/)
  })

  it('keeps the command short enough to survive any console line limit', () => {
    assert.ok(buildKickCommand('KU_Mjne0Map').length < 200)
  })

  it('rejects input that could break out of the Lua string', () => {
    assert.throws(() => buildKickCommand('KU_abc") TheNet:Announce("pwned'))
    assert.throws(() => buildKickCommand('KU_abc" .. os.execute("rm -rf /") .. "'))
  })

  it('accepts non-Klei ids as long as they are safe to embed', () => {
    // 离线 / 局域网进来的路人没有 Klei 账号，ID 形状不受面板控制，但清场同样要踢得掉
    assert.match(buildKickCommand('player'), /c\.userid=="player"/)
    assert.match(buildKickCommand('Player_3'), /c\.userid=="Player_3"/)
    assert.throws(() => buildKickCommand(''))
  })

  it('still rejects anything that could escape the Lua string literal', () => {
    assert.throws(() => buildKickCommand('a b'))
    assert.throws(() => buildKickCommand('a\\b'))
    assert.throws(() => buildKickCommand('a\nb'))
    assert.throws(() => buildKickCommand('a\tb'))
  })

  it('rejects an id longer than the accepted shape', () => {
    assert.throws(() => buildKickCommand(`KU_${'a'.repeat(65)}`))
  })
})

describe('isSafeCommandUserId', () => {
  it('accepts Klei ids and the temporary ids handed to offline players', () => {
    assert.equal(isSafeCommandUserId('KU_Mjne0Map'), true)
    assert.equal(isSafeCommandUserId('Player_3'), true)
    assert.equal(isSafeCommandUserId('1'), true)
  })

  it('rejects anything that could escape a Lua string literal', () => {
    assert.equal(isSafeCommandUserId(''), false)
    assert.equal(isSafeCommandUserId('a b'), false)
    assert.equal(isSafeCommandUserId('a"b'), false)
    assert.equal(isSafeCommandUserId('a\\b'), false)
    assert.equal(isSafeCommandUserId('a\'b'), false)
    assert.equal(isSafeCommandUserId('a\nb'), false)
    assert.equal(isSafeCommandUserId('a'.repeat(65)), false)
  })
})

describe('buildBanCommand', () => {
  it('wraps a valid id in a TheNet:Ban call', () => {
    assert.equal(buildBanCommand('KU_Mjne0Map'), 'TheNet:Ban("KU_Mjne0Map")')
  })

  it('rejects input that could break out of the Lua string', () => {
    assert.throws(() => buildBanCommand('KU_abc") TheNet:Kick("other'))
  })

  it('rejects ids that do not look like a Klei user id', () => {
    assert.throws(() => buildBanCommand(''))
    assert.throws(() => buildBanCommand('玩家甲'))
  })
})

describe('buildDespawnCommand', () => {
  it('calls the official c_despawn helper', () => {
    // 房间主人那条连接断不开，只能把他送回角色选择界面
    assert.equal(buildDespawnCommand('KU_Mjne0Map'), 'c_despawn("KU_Mjne0Map")')
  })

  it('rejects input that could break out of the Lua string', () => {
    assert.throws(() => buildDespawnCommand('KU_abc") os.execute("rm -rf /'))
  })

  it('rejects ids that do not look like a Klei user id', () => {
    assert.throws(() => buildDespawnCommand(''))
    assert.throws(() => buildDespawnCommand('ku_abc'))
  })
})

describe('buildConsoleProbeCommand', () => {
  it('prints a marker the caller can look for', () => {
    assert.match(buildConsoleProbeCommand('ab12cd34'), /print\("BSP_PING:ab12cd34"\)/)
  })

  it('also reports the dedicated server [Host] account', () => {
    // 房间主人与玩家共用 userid 时，踢他会踢到假连接、封他会把服主自己写进黑名单
    assert.match(buildConsoleProbeCommand('ab12cd34'), /c\.performance~=nil/)
    assert.match(buildConsoleProbeCommand('ab12cd34'), /BSP_HOST:ab12cd34:/)
  })

  it('accepts a token produced by createConsoleToken', () => {
    const token = createConsoleToken()
    assert.match(token, /^[0-9a-f]{8}$/)
    assert.doesNotThrow(() => buildConsoleProbeCommand(token))
  })

  it('rejects a token that could break out of the Lua string', () => {
    assert.throws(() => buildConsoleProbeCommand('ab12cd34") os.execute("rm -rf /'))
    assert.throws(() => buildConsoleProbeCommand('ABCDEF'))
    assert.throws(() => buildConsoleProbeCommand(''))
  })
})

describe('hasConsolePing', () => {
  it('finds its own echo among the game output', () => {
    const lines = ['[00:00:01]: Sim paused', `[00:00:02]: ${DST_CONSOLE_PING_MARKER}ab12cd34`]
    assert.equal(hasConsolePing(lines, 'ab12cd34'), true)
  })

  it('ignores the echo of another token', () => {
    assert.equal(hasConsolePing([`[00:00:02]: ${DST_CONSOLE_PING_MARKER}ffffffff`], 'ab12cd34'), false)
  })

  it('returns false when the game never answered', () => {
    assert.equal(hasConsolePing(['[00:00:02]: Sim paused'], 'ab12cd34'), false)
  })
})

describe('parseConsoleHostUserId', () => {
  it('reads the host account the game reported', () => {
    const lines = [`[00:00:02]: ${DST_CONSOLE_HOST_MARKER}ab12cd34:KU_Mjne0Map`]
    assert.equal(parseConsoleHostUserId(lines, 'ab12cd34'), 'KU_Mjne0Map')
  })

  it('ignores another token and non-Klei ids', () => {
    assert.equal(parseConsoleHostUserId([`[00:00:02]: ${DST_CONSOLE_HOST_MARKER}ffffffff:KU_x`], 'ab12cd34'), null)
    assert.equal(parseConsoleHostUserId([`[00:00:02]: ${DST_CONSOLE_HOST_MARKER}ab12cd34:`], 'ab12cd34'), null)
    assert.equal(parseConsoleHostUserId(['[00:00:02]: Sim paused'], 'ab12cd34'), null)
  })
})

describe('isRoomOwner', () => {
  it('recognises the account the dedicated server itself is connected with', () => {
    // 实测：专用服务器那条 [Host] 连接与房主玩家的 userid 完全相同
    assert.equal(isRoomOwner('KU_Mjned0Ap', 'KU_Mjned0Ap'), true)
    assert.equal(isRoomOwner('ku_mjned0ap', ' KU_Mjned0Ap '), true)
  })

  it('lets everyone else through', () => {
    assert.equal(isRoomOwner('KU_Mjned0Ap', 'KU_other1'), false)
  })

  it('says nothing when the game never reported a host account', () => {
    assert.equal(isRoomOwner(null, 'KU_Mjned0Ap'), false)
  })
})

describe('buildClientTableCommand', () => {
  it('dumps every connection together with a placeholder flag', () => {
    const command = buildClientTableCommand('ab12cd34')
    assert.match(command, /BSP_CLIENT:ab12cd34:/)
    assert.match(command, /c\.performance~=nil/)
  })

  it('rejects a token that could break out of the Lua string', () => {
    assert.throws(() => buildClientTableCommand('ab12cd34") os.execute("rm -rf /'))
  })
})

describe('parseClientRows', () => {
  it('reads id, name and the placeholder flag', () => {
    const lines = [`[00:00:02]: ${DST_CONSOLE_CLIENT_MARKER}ab12cd34:KU_Mjne0Map\t[Host]\ttrue`]
    assert.deepEqual(parseClientRows(lines, 'ab12cd34'), [
      { kuId: 'KU_Mjne0Map', name: '[Host]', isHostPlaceholder: true },
    ])
  })

  it('keeps a real player apart from the placeholder that shares its id', () => {
    // 正是这种「两条连接同一个 ID」的局面让 TheNet:Kick 踢错了对象
    const lines = [
      `[00:00:02]: ${DST_CONSOLE_CLIENT_MARKER}ab12cd34:KU_Mjne0Map\t[Host]\ttrue`,
      `[00:00:02]: ${DST_CONSOLE_CLIENT_MARKER}ab12cd34:KU_Mjne0Map\t泡面艺术家\tfalse`,
    ]
    const rows = parseClientRows(lines, 'ab12cd34')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].isHostPlaceholder, true)
    assert.equal(rows[1].isHostPlaceholder, false)
  })

  it('ignores another token and empty ids', () => {
    assert.deepEqual(parseClientRows([`[00:00:02]: ${DST_CONSOLE_CLIENT_MARKER}ffffffff:KU_x\tA\tfalse`], 'ab12cd34'), [])
    assert.deepEqual(parseClientRows([`[00:00:02]: ${DST_CONSOLE_CLIENT_MARKER}ab12cd34:\t\tfalse`], 'ab12cd34'), [])
    assert.deepEqual(parseClientRows(['[00:00:02]: Sim paused'], 'ab12cd34'), [])
  })
})

describe('isValidKuId', () => {
  it('accepts Klei user ids', () => {
    assert.equal(isValidKuId('KU_abc123'), true)
    assert.equal(isValidKuId('  KU_abc123  '), true)
    // 实测真实 userid 含 `-`（KU_3rpxG-xy）：漏掉它会把真实账号判成非法 ID
    assert.equal(isValidKuId('KU_3rpxG-xy'), true)
  })

  it('rejects anything else', () => {
    assert.equal(isValidKuId('KU_'), false)
    assert.equal(isValidKuId('ku_abc123'), false)
    assert.equal(isValidKuId('玩家甲'), false)
  })
})
