/**
 * 「当前世界种子」的控制台回读协议。
 *
 * DST 没有读取种子的接口，但种子在游戏里就是 `TheWorld.meta.seed`——世界生成时
 * worldgen 把它写进存档的 `savedata.meta.seed`，运行时读回同一张表。这里沿用
 * world-state-parser 的做法：向游戏注入一行 print，再从控制台日志里找标记行解析。
 *
 * 同时还会带回 `meta.session_identifier`：世界每重新生成一次它就变一次，
 * 面板因此能判断之前记下的种子是不是还代表当前这个世界。
 *
 * 只有实例（及目标分片）正在运行时才问得到，因此读到的值会被面板记录下来，
 * 停服后仍可显示。
 */
export const WORLD_SEED_LOG_PREFIX = 'GSHSEED:'

/**
 * 只认 1–15 位纯数字：与面板填写种子的形状完全一致。
 * 值后面不能紧跟数字或小数点，避免从 `1.5`、16 位长数字里截出一段当成种子。
 * `GSHSEED:nil`（旧存档没记录种子）或别的内容都不会被当成种子。
 */
const WORLD_SEED_LINE_PATTERN = /GSHSEED:(\d{1,15})(?![\d.])(?:\|([^\s|]{1,128}))?/

export interface ParsedWorldSeed {
  seed: string
  /** 世界会话标识；游戏没给出时为 null（老存档可能没有） */
  sessionId: string | null
}

/** 从一行控制台输出里解析世界种子；不是标记行或值不合法时返回 null */
export function parseWorldSeedLogLine(text: string, token?: string): ParsedWorldSeed | null {
  if (token) {
    const line = text.replace(/^\[\d+:\d+:\d+\]:\s*/, '').trim()
    const prefix = `GSHSEED:${token}|`
    if (!line.startsWith(prefix)) return null
    text = `GSHSEED:${line.slice(prefix.length)}`
  }
  const match = WORLD_SEED_LINE_PATTERN.exec(text)
  if (!match?.[1]) {
    return null
  }
  const sessionId = match[2] && match[2] !== 'nil' ? match[2] : null
  return { seed: match[1], sessionId }
}

/**
 * 查询命令：用 and 逐级短路，这样 `TheWorld` / `meta` 还没准备好时只会打印 nil，
 * 不会在游戏控制台里抛错（世界刚启动、尚未加载完是常态）。
 */
export function buildWorldSeedQueryCommand(token?: string): string {
  if (token && !/^[a-f0-9-]{36}$/.test(token)) throw new Error('种子查询标识无效')
  return 'print("' + WORLD_SEED_LOG_PREFIX
    + (token ? `${token}|` : '') + '"..tostring(TheWorld and TheWorld.meta and TheWorld.meta.seed)'
    + '.."|"..tostring(TheWorld and TheWorld.meta and TheWorld.meta.session_identifier))'
}
