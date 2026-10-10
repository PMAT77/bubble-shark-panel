import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createRequire } from 'node:module'
import { buildDstStartupProbe, parseDstStartupProbe } from './startup-probe'

const token = '11111111-2222-3333-4444-555555555555'
const oldToken = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = createRequire(import.meta.url)('fengari')

function executeProbe(fixture: string, remoteShardId?: string): string {
  const state = lauxlib.luaL_newstate()
  lualib.luaL_openlibs(state)
  try {
    const code = `local printed; function print(value) printed=value end; ${fixture}; ${buildDstStartupProbe(token, remoteShardId)}; return printed`
    const status = lauxlib.luaL_dostring(state, to_luastring(code))
    assert.equal(status, lua.LUA_OK, to_jsstring(lua.lua_tostring(state, -1)))
    return to_jsstring(lua.lua_tostring(state, -1))
  }
  finally { lua.lua_close(state) }
}

it('accepts only a response for the current startup query', () => {
  assert.deepEqual(parseDstStartupProbe(`BSPSTART:${token}|1|2|1`, token), { worldReady: true, shardId: '2', remoteConnected: true })
  assert.deepEqual(parseDstStartupProbe(`[00:01:22]: BSPSTART:${token}|0|-|x\t`, token), { worldReady: false, shardId: null, remoteConnected: null })
  assert.deepEqual(parseDstStartupProbe(`BSPSTART:${token}|1|Caves-2|0`, token), { worldReady: true, shardId: 'Caves-2', remoteConnected: false })
  assert.equal(parseDstStartupProbe(`BSPSTART:${oldToken}|1|2|1`, token), null)
})

it('ignores command echoes, errors and malformed game responses', () => {
  for (const line of [
    buildDstStartupProbe(token, '2'),
    `[00:01:22]: RemoteCommandInput: ${buildDstStartupProbe(token)}`,
    `BSPSTART:${token}|unknown`,
    `BSPSTART:${token}|1|2|x trailing text`,
    `BSPSTART:${token}|1|2|2`,
    `BSPSTART:${token}|1|two words|1`,
    `print('BSPSTART:${token}|1|2|1')`,
    'LUA ERROR stack traceback:',
  ]) assert.equal(parseDstStartupProbe(line, token), null)
})

it('builds guarded read-only queries and rejects values that could inject Lua', () => {
  const query = buildDstStartupProbe(token)
  assert.match(query, /pcall\(function\(\)/)
  assert.match(query, /TheWorld~=nil and TheWorld\.state~=nil/)
  assert.match(query, /local connected='x'/)
  assert.match(buildDstStartupProbe(token, 'Caves-2'), /peers\["Caves-2"\]/)
  assert.throws(() => buildDstStartupProbe('bad-token'), /Invalid startup probe token/)
  assert.throws(() => buildDstStartupProbe(`${token}'`), /Invalid startup probe token/)
  assert.throws(() => buildDstStartupProbe(token, '2"]; error("injected")'), /Invalid remote shard ID/)
  assert.throws(() => buildDstStartupProbe(token, 'x'.repeat(129)), /Invalid remote shard ID/)
})

it('executes Lua for loading worlds and missing or failing shard APIs', () => {
  assert.deepEqual(parseDstStartupProbe(executeProbe('TheWorld=nil; TheShard=nil'), token), { worldReady: false, shardId: null, remoteConnected: null })
  assert.deepEqual(parseDstStartupProbe(executeProbe("TheWorld={state={}}; TheShard={GetShardId=function() return '2' end}", '2'), token), { worldReady: true, shardId: '2', remoteConnected: null })
  assert.equal(executeProbe("TheWorld={state={}}; TheShard={GetShardId=function() error('API failure') end}", '2'), `BSPSTART:${token}|unknown`)
  assert.equal(executeProbe("TheWorld={state={}}; Shard_GetConnectedShards=function() error('API failure') end", '2'), `BSPSTART:${token}|unknown`)
  assert.equal(parseDstStartupProbe(executeProbe("TheWorld={state={}}; Shard_GetConnectedShards=function() return nil end", '2'), token)?.remoteConnected, false)
})

it('executes Lua against the actual connected shard ID without requiring peer.ready', () => {
  const fixture = "TheWorld={state={}}; TheShard={GetShardId=function() return '1' end}; Shard_GetConnectedShards=function() return { ['2']={} } end"
  assert.deepEqual(parseDstStartupProbe(executeProbe(fixture, '2'), token), { worldReady: true, shardId: '1', remoteConnected: true })
  assert.deepEqual(parseDstStartupProbe(executeProbe(fixture, '3'), token), { worldReady: true, shardId: '1', remoteConnected: false })
})

it('does not report a world with a global Lua error widget as ready', () => {
  const fixture = "TheWorld={state={}}; TheShard={GetShardId=function() return '1' end}; Shard_GetConnectedShards=function() return { ['2']={} } end"
  assert.deepEqual(parseDstStartupProbe(executeProbe(`${fixture}; global_error_widget={}`, '2'), token), { worldReady: false, shardId: '1', remoteConnected: true })
  assert.deepEqual(parseDstStartupProbe(executeProbe(`${fixture}; global_error_widget=nil`, '2'), token), { worldReady: true, shardId: '1', remoteConnected: true })
})
