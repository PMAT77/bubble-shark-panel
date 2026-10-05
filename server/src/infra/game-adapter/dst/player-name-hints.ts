import fs from 'node:fs'
import path from 'node:path'
import { PLAYER_KU_ID_SOURCE } from '../../../../../shared/constants/player'
import type { ShardId } from '../../../../../shared/contracts/shard'
import { DST_ONLINE_PLAYER_LIST_ITEM_MARKER } from './online-players'
import { resolveShardRoot } from './shard-layout'

/**
 * 从游戏日志里捡回「玩家 ID ↔ 游戏名」的线索。
 *
 * 用途只有一个：面板侧的玩家档案。在线查询只能记住当时在线的人，玩家一旦下线，
 * 白名单里的那条 ID 就又变成一串看不懂的字符了。
 *
 * 名字的可信来源只有两处（实测自真实服务器日志）：
 * 1. 面板自己注入的查询标记行 `BSP_PLAYER_LIST_ITEM:<token>:<KU_x>\t名字`——制表符分隔、
 *    由面板生成，最可靠；
 * 2. 部分版本会打印的 `Client authenticated: (KU_x) 名字`。
 *
 * 游戏日志里另外还有大量提到 ID 的行，例如
 * `Received (KU_xxx) from TokenPurpose` 与
 * `[ClientObject] Initialized ... userid=KU_xxx ...`——它们**不含名字**，
 * 一旦按「ID 后面那截就是名字」去猜，档案里就会出现「from TokenPurpose」这种假名字。
 * 因此这里只认上面两种形态，其余一律忽略。
 *
 * 这层是尽力而为：认不出来就返回空结果，不影响任何主流程。
 */

export interface PlayerNameHint {
  kuId: string
  name: string
}

/** 名字长度上限：超过这个长度基本可以断定抓到的是日志后半句，不是名字 */
const MAX_NAME_LENGTH = 32

/** 单次最多读多少字节的日志尾部（日志可能很大，读全文会无谓地吃内存） */
const MAX_LOG_READ_BYTES = 512 * 1024

/** 名字后面跟着的日志噪音：认证行不总是以名字结尾（`... Name has joined the server`） */
const TRAILING_NOISE_PATTERN = /\s+(?:has |have |joined|left |disconnected|from |steam|ip |\[|\()/i

/**
 * 面板在线查询注入的标记行：`BSP_PLAYER_LIST_ITEM:<token>:<KU_x>\t名字`。
 *
 * 名字部分允许缺失：解析前会 trim 每一行，而名字为空的标记行结尾就是制表符，
 * 会被 trim 掉（`...KU_x`）——那种情况按"有 ID 无名字"处理。
 */
const PANEL_ITEM_PATTERN = new RegExp(
  `${DST_ONLINE_PLAYER_LIST_ITEM_MARKER}[0-9a-f]+:(${PLAYER_KU_ID_SOURCE})(?:\\t(.*))?$`,
)

/** 部分服务器版本会打印 `Client authenticated: (KU_xxx) 名字` */
const AUTHENTICATED_PATTERN = new RegExp(`client authenticated:?\\s*\\(?(${PLAYER_KU_ID_SOURCE})\\)?(.*)$`, 'i')

/** 清洗候选名字：空、过长、纯数字/时间戳、带路径的一律不算名字 */
function sanitizeName(candidate: string): string {
  const trimmed = candidate.trim()
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) {
    return ''
  }
  if (/^[\d:./\\-]+$/.test(trimmed) || trimmed.includes('/')) {
    return ''
  }
  return trimmed
}

/** 标记行的名字：格式固定（制表符分隔），只清洗、不截断，名字里带「from」也保留 */
function markerName(raw: string): string {
  return sanitizeName(raw)
}

/** 认证行的名字：后面可能跟着日志后半句，命中噪音词就截断 */
function authenticatedName(raw: string): string {
  const cleaned = raw.replace(/^[\s)\]}>,;:.-]+/, '').trim()
  const noiseIndex = cleaned.search(TRAILING_NOISE_PATTERN)
  return sanitizeName(noiseIndex > 0 ? cleaned.slice(0, noiseIndex) : cleaned)
}

/**
 * 解析日志行中的玩家 ID 与名字。
 *
 * 同一 ID 出现多次时按「后出现的非空名字覆盖先前的」处理：日志是时间序，
 * 玩家改名后新名字在后面。空名字不覆盖已知名字。
 */
export function parsePlayerNameHints(lines: string[]): PlayerNameHint[] {
  const merged = new Map<string, PlayerNameHint>()
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }

    const panelMatch = line.match(PANEL_ITEM_PATTERN)
    if (panelMatch) {
      recordHint(merged, panelMatch[1], markerName(panelMatch[2] ?? ''))
      continue
    }

    const authMatch = line.match(AUTHENTICATED_PATTERN)
    if (authMatch) {
      recordHint(merged, authMatch[1], authenticatedName(authMatch[2]))
    }
  }
  return [...merged.values()]
}

function recordHint(merged: Map<string, PlayerNameHint>, kuId: string, name: string): void {
  const key = kuId.toLowerCase()
  const existing = merged.get(key)
  if (!name) {
    if (!existing) {
      merged.set(key, { kuId, name: '' })
    }
    return
  }
  merged.set(key, { kuId: existing?.kuId ?? kuId, name })
}

/** 合并多批线索（面板日志 + 各分片日志），后面的非空名字优先 */
export function mergePlayerNameHints(batches: PlayerNameHint[][]): PlayerNameHint[] {
  const merged = new Map<string, PlayerNameHint>()
  for (const batch of batches) {
    for (const hint of batch) {
      const key = hint.kuId.toLowerCase()
      const existing = merged.get(key)
      if (!hint.name && existing) {
        continue
      }
      merged.set(key, hint)
    }
  }
  return [...merged.values()]
}

/** 读文件尾部若干字节并按行切开；文件不存在或读不动时返回空数组 */
function readLogTailLines(filePath: string): string[] {
  try {
    if (!fs.existsSync(filePath)) {
      return []
    }
    const size = fs.statSync(filePath).size
    const start = Math.max(0, size - MAX_LOG_READ_BYTES)
    const length = size - start
    if (length <= 0) {
      return []
    }
    const handle = fs.openSync(filePath, 'r')
    try {
      const buffer = Buffer.alloc(length)
      fs.readSync(handle, buffer, 0, length, start)
      return buffer.toString('utf8').split(/\r?\n/)
    }
    finally {
      fs.closeSync(handle)
    }
  }
  catch {
    return []
  }
}

/** 游戏自己的 server_log.txt 路径（分片目录下） */
export function resolveShardServerLogPath(installPath: string, shard: ShardId): string {
  return path.join(resolveShardRoot(installPath, shard), 'server_log.txt')
}

/**
 * 从游戏自身写的日志里补线索。
 *
 * 两个分片都读：玩家可能只在洞穴出现过，洞穴日志里才有他的名字。
 */
export function collectPlayerNameHintsFromGameLogs(installPath: string): PlayerNameHint[] {
  const shards: ShardId[] = ['master', 'caves']
  const batches = shards.map((shard) => {
    const lines = readLogTailLines(resolveShardServerLogPath(installPath, shard))
    return parsePlayerNameHints(lines)
  })
  return mergePlayerNameHints(batches)
}
