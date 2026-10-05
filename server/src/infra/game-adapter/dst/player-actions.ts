import { randomBytes } from 'node:crypto'
import { PLAYER_KU_ID_PATTERN } from '../../../../../shared/constants/player'

const TOKEN_PATTERN = /^[0-9a-f]{1,16}$/

/**
 * 可以安全拼进 Lua 字符串字面量的玩家 ID 字符集。
 *
 * 比 Klei ID 宽：离线或局域网进来的玩家没有 Klei 账号，拿的是游戏临时分配的 ID，
 * 形状不受面板控制，而踢出这类玩家同样要拼命令。宽出去的只是字符种类，
 * **绝不放行引号、反斜杠、空格、控制字符与换行** —— 这个约束的全部意义就是挡住
 * 「把外部字符串原样塞进 Lua 代码」，那等于给了调用方一条任意 Lua 执行的通道。
 *
 * 封禁（要写黑名单长期生效）与移出世界仍只收严格 Klei ID：临时 ID 每次进服都会变。
 */
const COMMAND_USER_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

/** 面板自检标记：游戏执行到面板写进去的命令时，会把这行原样打印出来 */
export const DST_CONSOLE_PING_MARKER = 'BSP_PING:'

/** 房间主人（专用服务器自己那条 [Host] 连接）的账号，面板用它挡住「踢/封自己」 */
export const DST_CONSOLE_HOST_MARKER = 'BSP_HOST:'

/** 游戏连接表的快照标记：踢不掉时抄一份回面板日志，省掉下一次的手工排查 */
export const DST_CONSOLE_CLIENT_MARKER = 'BSP_CLIENT:'

/**
 * 构造踢人命令。
 *
 * 用 `TheNet:Kick(userid)` 而不是 `c_kick(...)`：后者在 DST 服务端脚本里并不存在，
 * 命令虽然能送进游戏的标准输入，却只会打印一条 Lua 报错然后什么也不做——这正是
 * 「界面提示已送达、玩家却纹丝不动」的来源。`TheNet:Kick` 是官方命令表中
 * 网络/服务端命令，userid 取自 AllPlayers（与在线玩家列表同一个来源）。
 *
 * 关键在于先按官方规则**跳过专用服务器的 [Host] 占位连接**：专用服务器自己也是
 * 一条 client（名字 `[Host]`），当集群令牌用的就是该玩家的账号时，这条占位连接会和
 * 玩家撞上同一个 userid；此时直接 `TheNet:Kick(userid)` 会踢到那条假连接，
 * 玩家一动不动，游戏还不会报任何错。官方脚本用 `performance == nil`
 * 过滤掉占位条目（见 c_listplayers / UserToClient），这里照做。
 *
 * 拼命令前一律过 assertCommandUserId：非法输入直接抛错，不会退化成
 * 「把面板收到的字符串原样塞进 Lua 代码」——那等于给了调用方一条
 * 任意 Lua 执行的通道。这里接受的字符集比 Klei ID 宽（离线玩家也要能踢出），
 * 但仍然排除了引号、反斜杠与控制字符。
 */
export function buildKickCommand(kuId: string): string {
  const id = assertCommandUserId(kuId, '踢出')
  return `for _,c in ipairs(TheNet:GetClientTable() or {}) do if c.userid=="${id}" and c.performance==nil then TheNet:Kick(c.userid) end end`
}

/**
 * 构造封禁命令。
 *
 * 封禁必须走 `TheNet:Ban(userid)`：blocklist.txt 只在房间启动时读取，光写文件要
 * 等重启才生效；`TheNet:Ban` 会即时拒绝该玩家重连，落盘则由调用方另外完成，
 * 两者合起来才是「立刻生效 + 重启后仍然生效」。
 */
export function buildBanCommand(kuId: string): string {
  return `TheNet:Ban("${assertKuId(kuId, '封禁')}")`
}

/**
 * 构造「移出世界」命令，只给房间主人用。
 *
 * 房间主人那条连接与服务器自己那条 [Host] 连接共用同一个 userid，`TheNet:Kick`
 * 落到假连接上——实测不报错、人也不掉线。官方的 `c_despawn` 走的是另一条路：
 * 它内部的 `UserToPlayer` 先按 userid 在连接表里找人（跳过 [Host] 占位连接），
 * 再到 AllPlayers 里找那个唯一的玩家实体，把人送回角色选择界面；
 * 玩家数据照存档保留，重新选角色即可再进。
 */
export function buildDespawnCommand(kuId: string): string {
  return `c_despawn("${assertKuId(kuId, '移出世界')}")`
}

/**
 * 构造通道自检命令。
 *
 * 一次拿到两件事，省掉一次往返：
 * - 一条最短的 print，证明面板写进游戏的控制台输入真的被执行了。如果连这一行都
 *   没有回声，问题在通路上，再发多少条踢出命令都是白费；
 * - 专用服务器自己那条 `[Host]` 连接的 userid。集群令牌用的就是房间里某个玩家的
 *   账号时，这条占位连接会与那个玩家撞上同一个 userid：踢他会踢到假连接（玩家
 *   一动不动、游戏也不报错），封他更会把房间主人自己写进黑名单。
 *   拿到它就能在动手前拦住这两种情况。
 */
export function buildConsoleProbeCommand(token: string): string {
  const safe = assertToken(token)
  return `print("${DST_CONSOLE_PING_MARKER}${safe}") for _,c in ipairs(TheNet:GetClientTable() or {}) do if c.performance~=nil then print("${DST_CONSOLE_HOST_MARKER}${safe}:"..tostring(c.userid)) end end`
}

/** 每次自检用一个新的标记，避免把上一次的输出当成这一次的结果 */
export function createConsoleToken(): string {
  return randomBytes(4).toString('hex')
}

/** 命令下发后的日志行里有没有这次自检的回声 */
export function hasConsolePing(lines: string[], token: string): boolean {
  const pattern = new RegExp(`${DST_CONSOLE_PING_MARKER}${escapeRegExp(token)}`)
  return lines.some(line => pattern.test(line))
}

/** 从自检输出里取房间主人（[Host]）的 userid；游戏没打印或形状不对时返回 null */
export function parseConsoleHostUserId(lines: string[], token: string): string | null {
  const pattern = new RegExp(`${DST_CONSOLE_HOST_MARKER}${escapeRegExp(token)}:(\\S+)`)
  for (const rawLine of lines) {
    const match = rawLine.match(pattern)
    if (match && PLAYER_KU_ID_PATTERN.test(match[1])) {
      return match[1]
    }
  }
  return null
}

/**
 * 构造连接表快照命令。
 *
 * 只在踢不掉的时候发：那种失败通常不是「命令没发出去」，而是「这条 ID 在游戏里
 * 对应的是另一条连接」。把表格留在面板日志里，下一次排查不必再让管理员手敲诊断命令。
 */
export function buildClientTableCommand(token: string): string {
  const safe = assertToken(token)
  return `for _,c in ipairs(TheNet:GetClientTable() or {}) do print("${DST_CONSOLE_CLIENT_MARKER}${safe}:"..tostring(c.userid).."\\t"..tostring(c.name).."\\t"..tostring(c.performance~=nil)) end`
}

/** 游戏连接表里的一行；userid 可能不是 KU_ 形状（占位连接），所以只按原样带回 */
export interface DstClientRow {
  kuId: string
  name: string
  /** 专用服务器自己的占位连接 */
  isHostPlaceholder: boolean
}

/**
 * 目标是房间主人自己的账号吗。
 *
 * 是的话踢出与封禁都不成立：专用服务器自己那条 [Host] 连接与房间主人共用同一个
 * userid，游戏按 userid 找连接时会落到那条假连接上（玩家一动不动、也不报错），
 * 而封禁更会把房间主人自己写进黑名单，重启后他自己都进不来。
 */
export function isRoomOwner(hostUserId: string | null, kuId: string): boolean {
  return hostUserId !== null && hostUserId.toLowerCase() === kuId.trim().toLowerCase()
}

/** 解析连接表快照；没有这次 token 的行就返回空数组（含义是「没抄到」） */
export function parseClientRows(lines: string[], token: string): DstClientRow[] {
  const pattern = new RegExp(`${DST_CONSOLE_CLIENT_MARKER}${escapeRegExp(token)}:(.*)$`)
  const rows: DstClientRow[] = []
  for (const rawLine of lines) {
    const match = rawLine.match(pattern)
    if (!match) {
      continue
    }
    const [kuId = '', name = '', hostFlag = ''] = match[1].split('\t')
    if (!kuId.trim()) {
      continue
    }
    rows.push({
      kuId: kuId.trim(),
      name: name.trim(),
      isHostPlaceholder: hostFlag.trim() === 'true',
    })
  }
  return rows
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function assertKuId(kuId: string, action: string): string {
  const trimmed = kuId.trim()
  if (!PLAYER_KU_ID_PATTERN.test(trimmed)) {
    throw new Error(`玩家 ID 无效，无法${action}`)
  }
  return trimmed
}

/** 踢出用的校验：字符集比 Klei ID 宽，但同样不允许任何能逃出字符串字面量的字符 */
function assertCommandUserId(kuId: string, action: string): string {
  const trimmed = kuId.trim()
  if (!COMMAND_USER_ID_PATTERN.test(trimmed)) {
    throw new Error(`玩家 ID 无效，无法${action}`)
  }
  return trimmed
}

function assertToken(token: string): string {
  const trimmed = token.trim()
  if (!TOKEN_PATTERN.test(trimmed)) {
    throw new Error('自检标记无效，无法下发命令')
  }
  return trimmed
}

/** 与 buildKickCommand 同一套校验，供调用方在拼命令前先做业务判断 */
export function isValidKuId(kuId: string): boolean {
  return PLAYER_KU_ID_PATTERN.test(kuId.trim())
}

/** 与 buildKickCommand 同一套校验：能拼进踢出命令的 ID 才是可操作的 */
export function isSafeCommandUserId(kuId: string): boolean {
  return COMMAND_USER_ID_PATTERN.test(kuId.trim())
}
