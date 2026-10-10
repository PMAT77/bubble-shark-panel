import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createRequire } from 'node:module'
import { buildMaintenanceProbe, parseMaintenanceProbe, buildSaveObserver, buildSnapshotRollbackCommand } from './maintenance-probe'
import { buildWorldSeedModWorldgenMainContent } from './world-seed'
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = createRequire(import.meta.url)('fengari')
const token = '11111111-2222-4333-8444-555555555555'
const session = '49156F29BABC4C94'
function execute(source: string) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state)
  try {
    const status = lauxlib.luaL_dostring(state, to_luastring(source))
    assert.equal(status, lua.LUA_OK, to_jsstring(lua.lua_tostring(state, -1)))
    return to_jsstring(lua.lua_tostring(state, -1))
  }
  finally { lua.lua_close(state) }
}
it('查询返回已加载编号，排除下一次保存编号、其他请求和命令回显', () => {
  const line = execute(`local printed; print=function(s) printed=s end; TheWorld={state={},meta={session_identifier='${session}',seed=42}}; TheNet={GetCurrentSnapshot=function() return 9 end}; TheShard={GetShardId=function() return '1' end}; ${buildMaintenanceProbe(token)}; return printed`)
  assert.equal(parseMaintenanceProbe(line, token)?.snapshotId, 8)
  assert.equal(parseMaintenanceProbe(line, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'), null)
  assert.equal(parseMaintenanceProbe(buildMaintenanceProbe(token), token), null)
})
it('保存观察器等落盘回调才输出，保留原回调并在完成或超时后恢复方法', () => {
  const result = execute(`local printed={}; local pending; local timeout; local forwarded=false; local snapshot=9; print=function(s) table.insert(printed,s) end; TheWorld={meta={session_identifier='${session}'},DoTaskInTime=function(self,delay,cb) timeout=cb end}; TheNet={GetCurrentSnapshot=function() return snapshot end}; ShardGameIndex={SaveCurrent=function(self,cb) pending=cb end}; local original=ShardGameIndex.SaveCurrent; ${buildSaveObserver(token, 30)}; ShardGameIndex:SaveCurrent(function() forwarded=true end); assert(#printed==1); snapshot=10; pending(); assert(forwarded); assert(ShardGameIndex.SaveCurrent==original); ${buildSaveObserver(token, 30)}; timeout(); assert(ShardGameIndex.SaveCurrent==original); return table.concat(printed,';')`)
  assert.match(result, new RegExp(`BSPSAVED:${token}\\|${session}\\|9`))
})
it('指定编号回档不依赖保存后 30 秒补偿，目标被引擎淘汰则拒绝重载', () => {
  const fixture = `ShardGameIndex={SaveCurrent=function() end}; local truncated; local reset=false; local printed; print=function(s) printed=s end; WorldRollbackFromSim=function() reset=true end; c_reset=function() WorldRollbackFromSim(0) end; TheWorld={ismastershard=true,meta={session_identifier='${session}'},DoTaskInTime=function() end}; TheNet={SetIsWorldSaving=function() end,GetCurrentSnapshot=function() return 9 end,ListSnapshots=function() if truncated then return {{snapshot_id=truncated,world_file='file'}} end; return {{snapshot_id=8,world_file='file8'},{snapshot_id=6,world_file='file6'}} end,TruncateSnapshots=function(self,sid,id) truncated=id<0 and 9+id or id end};`
  assert.equal(execute(`${fixture} ${buildSnapshotRollbackCommand(session, 6, token)}; assert(reset); return tostring(truncated)`), '6')
  assert.equal(execute(`${fixture} ${buildSnapshotRollbackCommand(session, 7, token)}; assert(not reset); assert(truncated==nil); return printed`), `BSPMAINT:${token}:rejected`)
})
it('共享种子脚本在实际 Mod 环境形状中支持不同、相同和空种子', () => {
  for (const seed of ['123', '456', '123', '']) {
    const source = buildWorldSeedModWorldgenMainContent()
    const encoded = JSON.stringify(source)
    const value = execute(`local global={tonumber=tonumber,SEED=777}; local env={GLOBAL=global,type=type,GetModConfigData=function(name,force) assert(name=='seed' and force==true); return '${seed}' end}; local chunk=assert(load(${encoded},'seed mod','t',env)); chunk(); return tostring(global.SEED)`)
    assert.equal(value, seed || '777')
  }
})

it('世界正在序列化时拒绝回档，不截断也不丢弃保存回调', () => {
  const fixture = `local reset=false; local clipped=false; local printed; print=function(s) printed=s end; c_reset=function() reset=true end; TheWorld={ismastershard=true,meta={session_identifier='${session}'}}; TheNet={GetCurrentSnapshot=function() return 8 end,ListSnapshots=function() return {{snapshot_id=8,world_file='file8'},{snapshot_id=6,world_file='file6'}} end,TruncateSnapshots=function() clipped=true end};`
  assert.equal(execute(`${fixture} ${buildSnapshotRollbackCommand(session, 6, token)}; assert(not reset and not clipped); return printed`), `BSPMAINT:${token}:rejected`)
})
