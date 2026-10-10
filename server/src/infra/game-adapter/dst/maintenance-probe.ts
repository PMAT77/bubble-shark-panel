import type { ShardId } from '../../../../../shared/contracts/shard'

export interface MaintenanceWorldProbe {
  loadId: string | null
  ready: boolean
  sessionId: string | null
  snapshotId: number | null
  seed: string | null
  shardId: string | null
  remoteConnected: boolean
}

export function buildMaintenanceProbe(token: string, remoteShardId?: string): string {
  if (!/^[a-f0-9-]{36}$/.test(token) || (remoteShardId && !/^[\w-]{1,128}$/.test(remoteShardId))) throw new Error('查询标识无效')
  const peer = remoteShardId ? `local peers=Shard_GetConnectedShards(); connected=type(peers)=='table' and peers['${remoteShardId}']~=nil;` : ''
  return `do local ok=pcall(function() local connected=true; ${peer} local w=TheWorld; if w and w.state and not w._bsp_maintenance_load_id then w._bsp_maintenance_load_id='${token}' end; print('BSPWORLD:${token}|'..tostring(w~=nil and w.state~=nil and global_error_widget==nil)..'|'..tostring(w and w.meta and w.meta.session_identifier)..'|'..tostring(TheNet:GetCurrentSnapshot()-1)..'|'..tostring(w and w.meta and w.meta.seed)..'|'..tostring(TheShard:GetShardId())..'|'..tostring(connected)..'|'..tostring(w and w._bsp_maintenance_load_id)) end); if not ok then print('BSPWORLD:${token}|unknown') end end`
}

export function parseMaintenanceProbe(line: string, token: string): MaintenanceWorldProbe | null {
  const match = /^BSPWORLD:([a-f0-9-]{36})\|(true|false)\|(nil|[A-Fa-f0-9]{16})\|(nil|\d+)\|(nil|\d{1,15})\|([\w-]{1,128})\|(true|false)\|(nil|[a-f0-9-]{36})$/.exec(line.replace(/^\[\d+:\d+:\d+\]:\s*/, '').trim())
  if (!match || match[1] !== token) return null
  return { loadId: match[8] === 'nil' ? null : match[8]!, ready: match[2] === 'true', sessionId: match[3] === 'nil' ? null : match[3]!, snapshotId: match[4] === 'nil' ? null : Number(match[4]), seed: match[5] === 'nil' ? null : match[5]!, shardId: match[6] === 'nil' ? null : match[6]!, remoteConnected: match[7] === 'true' }
}

/** 游戏完成 WriteTimeFile 后调用回调；仅观察下一次 SaveCurrent，不额外增加保存次数。 */
export function buildSaveObserver(token: string, timeoutSec: number): string {
  if (!/^[a-f0-9-]{36}$/.test(token) || !Number.isInteger(timeoutSec) || timeoutSec < 1) throw new Error('保存观察参数无效')
  return `do local index=ShardGameIndex; local original=index.SaveCurrent; local wrapper; wrapper=function(self,cb,shutdown) if self.SaveCurrent==wrapper then self.SaveCurrent=original end; return original(self,function(...) print('BSPSAVED:${token}|'..tostring(TheWorld.meta.session_identifier)..'|'..tostring(TheNet:GetCurrentSnapshot()-1)); if cb then cb(...) end end,shutdown) end; index.SaveCurrent=wrapper; TheWorld:DoTaskInTime(${timeoutSec},function() if index.SaveCurrent==wrapper then index.SaveCurrent=original end end); print('BSPSAVEARM:${token}') end`
}

export type WorldProbeByShard = Partial<Record<ShardId, MaintenanceWorldProbe>>

/** 主世界在原生回档回调中按当前写入编号换算指定目标，绕开 c_rollback 的 30 秒补偿。
 * 截断后先核对编号，再调用原回调的零步重载；洞穴使用引擎的直接编号截断。
 */
export function buildSnapshotRollbackCommand(sessionId: string, snapshotId: number, token: string, onlineMode = true, shard: ShardId = 'master'): string {
  if (!/^[A-Fa-f0-9]{16}$/.test(sessionId) || !Number.isSafeInteger(snapshotId) || snapshotId < 1 || snapshotId > 9999999999 || !/^[a-zA-Z0-9-]+$/.test(token)) throw new Error('回档目标无效')
  const role = shard === 'master' ? 'TheWorld.ismastershard' : 'not TheWorld.ismastershard'
  const truncate = `TheNet:SetIsWorldSaving(false); TheNet:TruncateSnapshots("${sessionId}",${snapshotId});`
  const reload = shard === 'master'
    ? `local prior=WorldRollbackFromSim; local handler; handler=function(count) WorldRollbackFromSim=prior; TheNet:SetIsWorldSaving(false); TheNet:TruncateSnapshots("${sessionId}",-(latest-${snapshotId}+1)); local newest=0; for _,v in ipairs(TheNet:ListSnapshots("${sessionId}",${onlineMode},99) or {}) do if v.world_file~=nil then newest=math.max(newest,v.snapshot_id) end end; if newest==${snapshotId} then print("BSPMAINT:${token}:accepted"); prior(0) else index.SaveCurrent=original; print("BSPMAINT:${token}:unknown") end end; WorldRollbackFromSim=handler; TheWorld:DoTaskInTime(10,function() if WorldRollbackFromSim==handler then WorldRollbackFromSim=prior; index.SaveCurrent=original; print("BSPMAINT:${token}:unknown") end end); c_reset()`
    : `${truncate} print("BSPMAINT:${token}:accepted"); StartNextInstance({reset_action=RESET_ACTION.LOAD_SLOT,save_slot=ShardGameIndex:GetSlot()})`
  return `do local found=false; local latest=0; if TheWorld and ${role} and TheWorld.meta.session_identifier=="${sessionId}" then for _,v in ipairs(TheNet:ListSnapshots("${sessionId}",${onlineMode},99) or {}) do if v.world_file~=nil then latest=math.max(latest,v.snapshot_id); if v.snapshot_id==${snapshotId} then found=true end end end end; if found and latest==TheNet:GetCurrentSnapshot()-1 then local index=ShardGameIndex; local original=index.SaveCurrent; local blocked=function() end; index.SaveCurrent=blocked; TheWorld:DoTaskInTime(15,function() if index.SaveCurrent==blocked then index.SaveCurrent=original end end); local ok=pcall(function() ${reload} end); if not ok then index.SaveCurrent=original; print("BSPMAINT:${token}:unknown") end else print("BSPMAINT:${token}:rejected") end end`
}
