import { randomBytes } from 'node:crypto'
import { PLAYER_KU_ID_PATTERN } from '../../../../../shared/constants/player'
import type { DstConsoleShard } from '../../../shared/instance/dst-container-command-port'
import { getDstContainerCommandPort } from '../../../shared/instance/dst-container-command-port'
import { instanceConsoleLogStore } from '../../../shared/instance-runtime/console-log-store'

export const DST_ONLINE_PLAYER_COUNT_MARKER = 'BSP_PLAYER_COUNT:'
export const DST_ONLINE_PLAYER_LIST_BEGIN_MARKER = 'BSP_PLAYER_LIST_BEGIN:'
export const DST_ONLINE_PLAYER_LIST_ITEM_MARKER = 'BSP_PLAYER_LIST_ITEM:'
export const DST_ONLINE_PLAYER_LIST_END_MARKER = 'BSP_PLAYER_LIST_END:'

/**
 * 读取容器日志的尾部行数。
 *
 * 在线玩家名单要 3 + N 行（BEGIN、每条玩家、END），窗口太小会在刷屏的
 * 服务器上把标记行挤出去；名单查询与人数查询共用这个窗口。
 */
const LOG_TAIL_LINES = 200

export interface DstOnlinePlayer {
  /** 游戏给出的原始 ID；非 Klei 账号（离线 / 局域网玩家）可能是别的形状，也可能为空 */
  kuId: string
  name: string
  /** Klei 账号：只有它为 true 时，ID 才稳定到能写进名单或用于封禁 */
  kleiAccount: boolean
  /** 本次查询内唯一，供列表 key 与操作定位；ID 为空时按出现顺序编号 */
  key: string
}

export interface DstOnlinePlayerList {
  /** BEGIN 行里 #AllPlayers 的读数；与 players.length 不一致时以它为准显示人数 */
  count: number
  players: DstOnlinePlayer[]
}

export interface DstOnlineQueryOptions {
  /**
   * 查询哪个分片，默认地上世界。
   *
   * 必须区分：地上与洞穴是两个独立进程，各自的 AllPlayers 只含连到自己身上的玩家，
   * 玩家走进洞穴后在主世界查询里根本不会出现。
   */
  shard?: DstConsoleShard
  timeoutMs?: number
  pollIntervalMs?: number
}

/** 向 DST 主世界控制台发送的 Lua 命令，在 stdout 输出带 queryToken 的可解析标记行。
 * 使用 #AllPlayers（同 c_getnumplayers），勿用 #TheNet:GetClientTable()：
 * 专用服 client 表含 performance 占位连接，会导致人数 +1。 */
export function buildDstOnlinePlayerCountCommand(queryToken: string): string {
  return `print("${DST_ONLINE_PLAYER_COUNT_MARKER}${queryToken}:" .. #AllPlayers)`
}

/**
 * 一次下发同时取回人数与玩家明细，避免为同一件事发两条命令。
 *
 * 三行标记是一个整体：BEGIN 带上 #AllPlayers 作读数，ITEM 每个玩家一行
 * （userid 与 name 用制表符分隔，名字里因此可以带空格和冒号），END 收尾。
 * 解析侧要求收到 END 才认结果，见 parseDstOnlinePlayerList。
 */
export function buildDstOnlinePlayersCommand(queryToken: string): string {
  const begin = `print("${DST_ONLINE_PLAYER_LIST_BEGIN_MARKER}${queryToken}:" .. #AllPlayers)`
  const items = `for _, player in pairs(AllPlayers) do print("${DST_ONLINE_PLAYER_LIST_ITEM_MARKER}${queryToken}:" .. tostring(player.userid) .. "\\t" .. tostring(player.name or "")) end`
  const end = `print("${DST_ONLINE_PLAYER_LIST_END_MARKER}${queryToken}")`
  return `${begin} ${items} ${end}`
}

function createQueryToken(): string {
  return randomBytes(4).toString('hex')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function parseDstOnlinePlayerCountLine(text: string, queryToken?: string): number | null {
  const tokenPart = queryToken
    ? `${queryToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`
    : ''
  const match = text.match(new RegExp(`${DST_ONLINE_PLAYER_COUNT_MARKER}${tokenPart}(\\d+)`))
  if (!match) {
    return null
  }
  const value = Number.parseInt(match[1], 10)
  if (!Number.isFinite(value) || value < 0) {
    return null
  }
  return value
}

/**
 * 解析在线玩家名单。
 *
 * 必须同时见到 BEGIN 与 END 才返回结果：中途返回会把「日志被刷屏挤掉一半」
 * 的残缺名单当成真实在线情况——那比查不到更糟（用户会以为某人已经掉线）。
 */
export function parseDstOnlinePlayerList(
  lines: string[],
  queryToken: string,
): DstOnlinePlayerList | null {
  const tokenPart = escapeRegExp(queryToken)
  /**
   * 标记行必须落在行尾。
   *
   * 面板下发的那行 Lua 源码会被游戏原样回显到日志里，里面同样含这三个标记
   * （`... end print("BSP_PLAYER_LIST_END:token")`）。不加行尾约束，
   * 回显行会被当成真的 END，解析在半路就收工；BEGIN 也一并约束，
   * 免得 `#AllPlayers` 之类的字样凑出一个假读数。
   */
  const beginPattern = new RegExp(`${DST_ONLINE_PLAYER_LIST_BEGIN_MARKER}${tokenPart}:(\\d+)\\s*$`)
  const itemPattern = new RegExp(`${DST_ONLINE_PLAYER_LIST_ITEM_MARKER}${tokenPart}:(.*)$`)
  const endPattern = new RegExp(`${DST_ONLINE_PLAYER_LIST_END_MARKER}${tokenPart}\\s*$`)

  let count: number | null = null
  let closed = false
  const players: DstOnlinePlayer[] = []
  const seen = new Set<string>()

  for (const rawLine of lines) {
    const beginMatch = rawLine.match(beginPattern)
    if (beginMatch) {
      count = Number.parseInt(beginMatch[1], 10)
      continue
    }

    const itemMatch = rawLine.match(itemPattern)
    if (itemMatch) {
      const payload = itemMatch[1]
      const tabIndex = payload.indexOf('\t')
      const kuId = (tabIndex === -1 ? payload : payload.slice(0, tabIndex)).trim()
      const name = tabIndex === -1 ? '' : payload.slice(tabIndex + 1).trim()
      /**
       * 命令回显行也带着 ITEM 标记：面板下发的整行 Lua 源码会被游戏回显到日志里，
       * 它的 ID 段是 `" .. tostring(player.userid) .. "`——含引号与空格。
       * 真实条目的 ID 段是游戏给的 userid，不可能出现这些字符，据此把回显挡在外面。
       */
      if (/["\s]/.test(kuId)) {
        continue
      }
      /**
       * 非 Klei 账号也列出来。
       *
       * 离线或局域网进来的玩家没有 Klei 账号，userid 形状不受面板控制，可能为空。
       * 早先这里只收 KU_ 形状，结果是「人数按 #AllPlayers 算上他、明细里却没有他」——
       * 用户看到「实例详情说 1 人在线、房间玩家页说没人」。
       * 能不能长期管理另由 kleiAccount 表达；拼命令前的字符集校验在 player-actions.ts。
       *
       * ID 为空时不能拿空串当 key（多人会互相覆盖），按出现顺序编号兜底。
       */
      const key = kuId ? kuId.toLowerCase() : `unidentified-${players.length + 1}`
      if (kuId && seen.has(key)) {
        continue
      }
      if (kuId) {
        seen.add(key)
      }
      players.push({ kuId, name, kleiAccount: PLAYER_KU_ID_PATTERN.test(kuId), key })
      continue
    }

    if (endPattern.test(rawLine)) {
      closed = true
      break
    }
  }

  if (!closed) {
    return null
  }
  return { count: count ?? players.length, players }
}

function findOnlinePlayerCountInLines(lines: string[], queryToken: string): number | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const count = parseDstOnlinePlayerCountLine(lines[index], queryToken)
    if (count !== null) {
      return count
    }
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 把两条日志来源合并成一次解析用的行序列。
 *
 * 容器日志与内存日志记录的是同一次查询的输出，可能只在一侧可见；
 * 合并后再解析能覆盖「BEGIN 在一侧、END 在另一侧」的错位，
 * Set 去重则避免同一行被算成两条 ITEM。
 */
function collectCandidateLines(
  dockerLines: string[],
  dockerSnapshot: string[],
  memoryLines: string[],
): string[] {
  const fresh = dockerLines.filter(line => !dockerSnapshot.includes(line))
  return [...new Set([...fresh, ...memoryLines])]
}

/**
 * 取某一分片在游标之后的内存日志文本。
 *
 * 内存 store 不分分片存放，必须按行上的 shard 过滤：把两个分片的标记行混在一起
 * 解析，会出现「地上查到的名单里混进洞穴玩家」这种比查不到更糟的结果。
 */
function listMemoryLinesAfter(instanceId: string, afterId: number, shard: DstConsoleShard): string[] {
  return instanceConsoleLogStore
    .listLogs(instanceId, afterId)
    .filter(line => line.shard === shard)
    .map(line => line.text)
}

export async function queryDstOnlinePlayerCount(
  instanceId: string,
  options?: DstOnlineQueryOptions,
): Promise<number | null> {
  const port = getDstContainerCommandPort()
  const shard = options?.shard ?? 'master'
  const running = await port.isInstanceContainerRunning(instanceId, shard)
  if (!running) {
    return null
  }

  const queryToken = createQueryToken()
  const command = buildDstOnlinePlayerCountCommand(queryToken)
  const timeoutMs = options?.timeoutMs ?? 4000
  const pollIntervalMs = options?.pollIntervalMs ?? 150
  const logsBefore = instanceConsoleLogStore.listLogs(instanceId)
  const lastId = logsBefore.length > 0 ? logsBefore[logsBefore.length - 1].id : 0
  const dockerSnapshot = await port.readRecentInstanceContainerLogLines(instanceId, LOG_TAIL_LINES, shard)

  // 静默下发：这是面板自己的周期查询，不该在用户的控制台里留下命令行回显
  const result = await port.sendInstanceContainerCommand(instanceId, command, shard, { silent: true })
  if (!result.ok) {
    return null
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const dockerLines = await port.readRecentInstanceContainerLogLines(instanceId, LOG_TAIL_LINES, shard)
    const candidates = collectCandidateLines(
      dockerLines,
      dockerSnapshot,
      listMemoryLinesAfter(instanceId, lastId, shard),
    )
    const count = findOnlinePlayerCountInLines(candidates, queryToken)
    if (count !== null) {
      return count
    }

    await sleep(pollIntervalMs)
  }

  return null
}

/** 查询在线玩家明细；超时或标记行不完整时返回 null（含义是「不知道」，不是「没人在线」） */
export async function queryDstOnlinePlayers(
  instanceId: string,
  options?: DstOnlineQueryOptions,
): Promise<DstOnlinePlayerList | null> {
  const port = getDstContainerCommandPort()
  const shard = options?.shard ?? 'master'
  const running = await port.isInstanceContainerRunning(instanceId, shard)
  if (!running) {
    return null
  }

  const queryToken = createQueryToken()
  const command = buildDstOnlinePlayersCommand(queryToken)
  const timeoutMs = options?.timeoutMs ?? 4000
  const pollIntervalMs = options?.pollIntervalMs ?? 150
  const logsBefore = instanceConsoleLogStore.listLogs(instanceId)
  const lastId = logsBefore.length > 0 ? logsBefore[logsBefore.length - 1].id : 0
  const dockerSnapshot = await port.readRecentInstanceContainerLogLines(instanceId, LOG_TAIL_LINES, shard)

  const result = await port.sendInstanceContainerCommand(instanceId, command, shard, { silent: true })
  if (!result.ok) {
    return null
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const dockerLines = await port.readRecentInstanceContainerLogLines(instanceId, LOG_TAIL_LINES, shard)
    const candidates = collectCandidateLines(
      dockerLines,
      dockerSnapshot,
      listMemoryLinesAfter(instanceId, lastId, shard),
    )
    const parsed = parseDstOnlinePlayerList(candidates, queryToken)
    if (parsed) {
      return parsed
    }

    await sleep(pollIntervalMs)
  }

  return null
}

export interface DstShardOnlineSnapshot {
  shard: DstConsoleShard
  /** null 表示这个分片这次没查到（未运行、超时或日志被挤掉），与空数组含义不同 */
  players: DstOnlinePlayer[] | null
  /**
   * 该分片上报的人数（#AllPlayers 读数）。
   *
   * 必须跟着 players 一起往上带：人数含那些「游戏没给出可用 ID、列不出来」的玩家，
   * 只按 players.length 统计会让各页面人数对不上（详情页 1 人、玩家页 0 人）。
   * players 为 null 时它是 null。
   */
  count: number | null
}

/**
 * 合计多个分片的在线人数。
 *
 * 地上与洞穴各自只知道自己这边的玩家，只查地上会把走进洞穴的人漏掉（人数少 1）。
 * 没答上来的分片不计入；全军覆没时返回 null（「不知道」），界面据此显示「—」而不是 0。
 */
export async function sumOnlinePlayerCounts(
  instanceId: string,
  shards: DstConsoleShard[],
  options?: { timeoutMs?: number },
): Promise<number | null> {
  const counts = await Promise.all(shards.map(async shard => queryDstOnlinePlayerCount(instanceId, {
    shard,
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  }).catch(() => null)))
  const answered = counts.filter((count): count is number => count !== null)
  return answered.length > 0 ? answered.reduce((sum, count) => sum + count, 0) : null
}

/**
 * 并行查询多个分片的在线玩家。
 *
 * 踢人与封禁都要先知道人在哪个世界：地上与洞穴的 AllPlayers 互不可见，
 * 把命令发给错误的分片等于没发。
 */
export async function queryShardsOnlinePlayers(
  instanceId: string,
  shards: DstConsoleShard[],
  options?: { timeoutMs?: number },
): Promise<DstShardOnlineSnapshot[]> {
  return Promise.all(shards.map(async (shard): Promise<DstShardOnlineSnapshot> => {
    const list = await queryDstOnlinePlayers(instanceId, {
      shard,
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }).catch(() => null)
    return { shard, players: list?.players ?? null, count: list?.count ?? null }
  }))
}

export type DstPlayerLocationStatus = 'online' | 'offline' | 'unknown'

export interface DstPlayerLocation {
  status: DstPlayerLocationStatus
  /** status 为 online 时，玩家所在的分片 */
  shard: DstConsoleShard | null
}

/**
 * 判断某个玩家此刻在哪。
 *
 * 三个结果必须区分开：online（人在，且知道在哪个世界）、offline（每个分片都答了
 * 且都没这个人）、unknown（有分片没答上来，不能断言人不在）。把 unknown 当成 offline
 * 会让界面告诉管理员「他已经离开了」，而他其实还在服里。
 */
export function resolvePlayerLocation(
  snapshots: DstShardOnlineSnapshot[],
  kuId: string,
): DstPlayerLocation {
  const key = kuId.trim().toLowerCase()
  if (!key) {
    return { status: 'unknown', shard: null }
  }
  for (const snapshot of snapshots) {
    if (snapshot.players?.some(player => player.kuId.toLowerCase() === key)) {
      return { status: 'online', shard: snapshot.shard }
    }
  }
  if (snapshots.length > 0 && snapshots.every(snapshot => snapshot.players !== null)) {
    return { status: 'offline', shard: null }
  }
  return { status: 'unknown', shard: null }
}
