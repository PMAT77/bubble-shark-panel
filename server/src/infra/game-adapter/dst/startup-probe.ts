export interface DstStartupProbe {
  worldReady: boolean
  shardId: string | null
  remoteConnected: boolean | null
}

/** 探针只读取游戏状态；pcall 防止版本缺少 API 时生成 Lua 致命错误。 */
export function buildDstStartupProbe(token: string, remoteShardId?: string): string {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error('Invalid startup probe token')
  if (remoteShardId && !/^[\w-]{1,128}$/.test(remoteShardId)) throw new Error('Invalid remote shard ID')
  const connected = remoteShardId
    ? `local connected='x'; if type(Shard_GetConnectedShards)=='function' then local peers=Shard_GetConnectedShards(); connected=(type(peers)=='table' and peers["${remoteShardId}"]~=nil) and '1' or '0' end;`
    : "local connected='x';"
  return `do local ok=pcall(function() local ready=(TheWorld~=nil and TheWorld.state~=nil and global_error_widget==nil); local id=(TheShard and TheShard:GetShardId()) or '-'; ${connected} print('BSPSTART:${token}|'..(ready and '1' or '0')..'|'..tostring(id)..'|'..connected) end); if not ok then print('BSPSTART:${token}|unknown') end end`
}

export function parseDstStartupProbe(line: string, token: string): DstStartupProbe | null {
  const prefix = line.replace(/^\[\d+:\d+:\d+\]:\s*/, '').trim()
  const match = /^BSPSTART:([a-f0-9-]{36})\|([01])\|([\w-]{1,128})\|([01x])$/.exec(prefix)
  if (!match || match[1] !== token) return null
  return { worldReady: match[2] === '1', shardId: match[3] === '-' ? null : match[3]!,
    remoteConnected: match[4] === 'x' ? null : match[4] === '1' }
}
