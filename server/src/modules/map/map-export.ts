import { landmarkScriptWhitelist } from './landmark-catalog'
import { MAP_CHUNK_MARKER, MAP_CHUNK_SIZE, splitIntoChunks } from './terrain-rle'

/**
 * 与游戏之间的导出协议：脚本生成、触发命令、完成标记。
 *
 * 全是纯字符串操作，因此能在任意平台上单测——真机上要验的只有"游戏认不认这套调用"。
 *
 * ## 为什么是"流式回传"而不是"写文件"
 *
 * 2026-09-21 在真机上逐项实测，这台 DST 专用服的输出与写文件能力如下：
 *
 * | 通道 | 实测结果 |
 * | --- | --- |
 * | `io.open(path,"w")` | 七个路径（目录 / 相对名 / 绝对路径 / 带点 / 游戏自己的 `save` 目录）**全部** `invalid filepath` |
 * | `os.execute` / `os.tmpname` | `nil` |
 * | `TheSim:SetPersistentString` | 调用"成功"，但 `GetPersistentString` 回读为 `nil`（空操作） |
 * | `io.write` | **不可用**：`type()` 是 function、调用也不报错，但**输出不会进控制台日志** |
 * | `print` | **可用**（面板自己每 15 秒查在线人数走的就是它） |
 *
 * `io.write` 那条是最容易踩的：它看起来完全正常，"是函数"且不报错，但日志里一行都收不到。
 * 判据来自同一次会话的日志：`print("BSP_PLAYER_COUNT:...")` 有输出，
 * 而 `io.write("GSHMAPDONE:...")` 什么都没有。**所以脚本一律用 `print`。**
 *
 * 因此地形走控制台日志传回：RLE 压缩 + 定长分块 + 每块自带序号，面板按序号拼接
 *（见 `terrain-rle.ts`）。这条路不依赖文件系统，也不依赖任何我不确定的接口。
 *
 * ## 一次导出里有两段，地形是主体、地标是增值
 *
 * 地标（关键建筑与巢穴的坐标）在同一个脚本里采集，但**单独包一层 `pcall`**：实体表读不到
 * 就只发 `head:no-ents`，地形照常出图。把两件事绑死在同一个成败上，等于让一个未验证的
 * 能力挟持一个已验证的能力。
 */

/** 完成标记前缀；与游戏侧脚本里写死的字符串必须一致 */
export const MAP_EXPORT_DONE_MARKER = 'GSHMAPDONE:'

/** 地标标记前缀；与游戏侧脚本里写死的字符串必须一致 */
export const MAP_MARK_MARKER = 'GSHMAPMARK:'

/**
 * 地块名标记前缀；与游戏侧脚本里写死的字符串必须一致。
 *
 * 用途只有一件事：**面板不认识的号，让游戏自己说它叫什么**。真机上出现了面板没收录的
 * 地块（263）时，没有这一行就只能显示"未收录地块 #263"；有了它，图例能显示
 * `Ice Floe（未收录）`，用户和我们都立刻知道该补什么。
 */
export const MAP_NAME_MARKER = 'GSHMAPNAME:'

/**
 * 地图数据层的调用名。
 *
 * 抽成参数而不是写死：这一处最可能随游戏版本或理解偏差而不同。
 * 真机已验证（2026-09-21）：`GetSize` / `GetTile` 这两个名字是对的。
 */
export interface MapExportApi {
  /** 取某格地块类型的方法名 */
  getTile: string
  /** 取地图尺寸的方法名 */
  getSize: string
}

export const DEFAULT_MAP_EXPORT_API: MapExportApi = {
  getTile: 'GetTile',
  getSize: 'GetSize',
}

export interface BuildExportScriptInput {
  shard: 'master' | 'caves'
  api?: MapExportApi
  /** 单块字符数，默认取 `MAP_CHUNK_SIZE` */
  chunkSize?: number
  /**
   * 分块总数上限。
   *
   * 超出就直接失败，不让脚本继续刷屏：块数失控通常意味着地形异常碎片化，
   * 硬传下去只会把控制台日志冲掉、让玩家和排错都受影响。
   */
  maxChunks?: number
  /** 地标白名单的 Lua 表内容（`pigking=1,...`）；默认取地标目录，测试可覆盖 */
  markWhitelist?: string
}

const DEFAULT_MAX_CHUNKS = 400

/**
 * 生成导出脚本。
 *
 * 约束（都来自真机行为，不是风格偏好）：
 *
 * 1. **必须是可被 `loadstring` 执行的完整块**，因为触发命令要是单条语句（控制台按行解释）。
 * 2. **输出一律用 `print`**，不用 `io.write`：后者在这台专用服上"是函数但不产出日志"（见文件头实测表）。
 *    失败也走 `print` 标记，不在控制台抛红字——控制台是玩家可见的界面。
 * 3. **分块逐行输出**，每行一个标记。`print` 自带换行，行长度取 1200 字符，
 *    远低于控制台 4096 的上限，也给日志系统留出加时间戳前缀的余量。
 * 4. **地块字段取 4 位十六进制**（不是 2 位）：DST 的地块 ID 会超过 255（257 猴岛沙滩、
 *    264 浮冰都在真实世界里出现），1 字节编码会把它们静默截断成别的 ID。
 */
export function buildMapExportScript(input: BuildExportScriptInput): string {
  const api = input.api ?? DEFAULT_MAP_EXPORT_API
  const chunkSize = input.chunkSize ?? MAP_CHUNK_SIZE
  const maxChunks = input.maxChunks ?? DEFAULT_MAX_CHUNKS
  if (chunkSize <= 0) {
    throw new Error('分块大小必须为正数')
  }
  const whitelist = input.markWhitelist ?? landmarkScriptWhitelist()

  return [
    `local Map=TheWorld and TheWorld.Map`,
    `if not Map then print("${MAP_EXPORT_DONE_MARKER}no-map") return end`,
    `local ok,w,h=pcall(function() return Map:${api.getSize}() end)`,
    `if not ok or type(w)~="number" or type(h)~="number" or w<=0 or h<=0 then print("${MAP_EXPORT_DONE_MARKER}bad-size") return end`,
    // 编码：同质段压成 <4 位十六进制次数><4 位十六进制地块>
    `local buf={}`,
    `local used={}`,
    `local cur=Map:${api.getTile}(0,0) or 0`,
    `used[cur]=1`,
    `local run=1`,
    `local well=pcall(function()`,
    `for z=0,h-1 do`,
    `for x=0,w-1 do`,
    `if z==0 and x==0 then`,
    `else`,
    `local t=Map:${api.getTile}(x,z) or 0`,
    `if t==cur then run=run+1 else buf[#buf+1]=string.format("%04x%04x",run,cur%65536) cur=t run=1 used[t]=1 end`,
    `end`,
    `end`,
    `end`,
    `end)`,
    `if not well then print("${MAP_EXPORT_DONE_MARKER}tile-error") return end`,
    `buf[#buf+1]=string.format("%04x%04x",run,cur%65536)`,
    `local payload=table.concat(buf)`,
    `local total=math.ceil(#payload/${chunkSize})`,
    `if total<=0 then total=1 end`,
    `if total>${maxChunks} then print("${MAP_EXPORT_DONE_MARKER}too-many-parts:"..tostring(total)) return end`,
    // 头行：尺寸、分片、种子、总块数。面板据此知道该等几块，以及这张图是哪来的
    `print("${MAP_EXPORT_DONE_MARKER}head:${input.shard}:"..w.."x"..h..":"..tostring((TheWorld.meta and TheWorld.meta.seed) or -1)..":"..total)`,
    `for i=0,total-1 do`,
    `print("${MAP_CHUNK_MARKER}"..i.."/"..total..":"..string.sub(payload,i*${chunkSize}+1,(i+1)*${chunkSize}))`,
    `end`,
    // 地块名：这次用到的每个地块 ID 配上游戏自己的官方名，一行足够（几十个 ID）
    `local names={}`,
    `for id in pairs(used) do names[#names+1]=id.."="..tostring((GROUND_NAMES and GROUND_NAMES[id]) or "") end`,
    `print("${MAP_NAME_MARKER}"..table.concat(names,","))`,
    // —— 地标：独立 pcall，实体表读不到也只回报 no-ents，地形已经传完了 ——
    `local W={${whitelist}}`,
    `local hits={}`,
    `local okm=pcall(function()`,
    `for _,e in pairs(Ents) do`,
    `local p=e and e.prefab`,
    `if p and W[p] and e.Transform then`,
    `local x,y,z=e.Transform:GetWorldPosition()`,
    `hits[#hits+1]=p.."@"..math.floor(x+0.5)..","..math.floor(z+0.5)`,
    `end`,
    `end`,
    `end)`,
    `if not okm then print("${MAP_MARK_MARKER}head:no-ents:0") return end`,
    `local mpay=table.concat(hits,";")`,
    `local mtotal=0`,
    `if #mpay>0 then mtotal=math.ceil(#mpay/${chunkSize}) end`,
    // 地标多到离谱时不传：宁可少一层标注，也不要把控制台日志冲掉
    `if mtotal>${maxChunks} then mtotal=0 end`,
    `print("${MAP_MARK_MARKER}head:ok:"..mtotal)`,
    `for i=0,mtotal-1 do`,
    `print("${MAP_MARK_MARKER}"..i.."/"..mtotal..":"..string.sub(mpay,i*${chunkSize}+1,(i+1)*${chunkSize}))`,
    `end`,
  ].join(' ')
}

/**
 * 触发命令：**单条语句**。
 *
 * `loadstring(脚本)()` 只算一条语句，这是绕开"控制台按行解释、命令上限 4096 字符"的形态。
 */
export function buildMapExportTriggerCommand(script: string, queryToken: string): string {
  const escaped = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
  return `loadstring("${escaped}")() print("${MAP_EXPORT_DONE_MARKER}${queryToken}:end")`
}

export type MapExportCompletion =
  | { kind: 'ok', width: number, height: number, seed: string | null, totalParts: number }
  | { kind: 'failed', reason: string }

/** 从日志行里找"头行"：它给出尺寸、分片、种子与总块数 */
export function parseMapExportHeadLine(line: string): MapExportCompletion | null {
  const matched = /GSHMAPDONE:head:(master|caves):(\d+)x(\d+):(-?\d+):(\d+)/.exec(line)
  if (!matched) {
    return null
  }
  const width = Number.parseInt(matched[2]!, 10)
  const height = Number.parseInt(matched[3]!, 10)
  const rawSeed = matched[4]!
  const totalParts = Number.parseInt(matched[5]!, 10)
  if (width <= 0 || height <= 0 || totalParts < 0) {
    return { kind: 'failed', reason: '导出头信息不合法' }
  }
  return {
    kind: 'ok',
    width,
    height,
    seed: /^\d{1,15}$/.test(rawSeed) ? rawSeed : null,
    totalParts,
  }
}

/** 单条失败标记：`GSHMAPDONE:<code>` */
export function parseMapExportFailureLine(line: string): string | null {
  const matched = /GSHMAPDONE:([a-z-]+)(?::([^\s]*))?\s*$/.exec(line.trim())
  if (!matched) {
    return null
  }
  const code = matched[1]!
  // head / end 是正常标记，不是失败
  if (code === 'head' || code === 'end') {
    return null
  }
  return matched[2] ? `${code}:${matched[2]}` : code
}

/** 把脚本里的失败码翻译成用户能看懂的一句话 */
export function describeExportFailure(code: string): string {
  if (code === 'no-map') {
    return '游戏里还没有可读取的世界地图（世界可能仍在生成）'
  }
  if (code === 'bad-size') {
    return '游戏返回的地图尺寸不合法，无法导出地形'
  }
  if (code === 'tile-error') {
    return '读取地块数据时出错，无法导出地形'
  }
  if (code.startsWith('too-many-parts:')) {
    return `地形数据分块过多（${code.slice('too-many-parts:'.length)} 块），已中止导出`
  }
  return code ? `地形导出失败：${code}` : '地形导出失败'
}

export interface LandmarkPoint {
  /** 游戏里的实体名（prefab）；面板据此查中文名与分类 */
  prefab: string
  /** 世界坐标 x（取整） */
  x: number
  /** 世界坐标 z（取整） */
  z: number
}

/**
 * 解析"地块 ID → 游戏官方名"那一行。
 *
 * 用途有限但关键：只在面板**没收录**某个地块时才用得上它的名字。拿不到就退回
 * "未收录地块 #N"，所以这里整个是尽力而为——格式坏掉、行被刷掉都不影响出图。
 *
 * 与其余标记一样要防**脚本回显**：回显行里含引号（`print("GSHMAPNAME:"..table.concat(...))`），
 * 而真实数据行是 `263=Ice Floe` 这样的纯文本，靠这一点区分。
 */
export function parseTileNameLine(lines: readonly string[]): Map<number, string> {
  const names = new Map<number, string>()
  for (const raw of lines) {
    const line = raw.trim()
    const marker = line.indexOf(MAP_NAME_MARKER)
    if (marker < 0) {
      continue
    }
    const body = line.slice(marker + MAP_NAME_MARKER.length)
    if (body === '' || body.includes('"')) {
      continue
    }
    for (const item of body.split(',')) {
      const separator = item.indexOf('=')
      if (separator <= 0) {
        continue
      }
      const id = Number.parseInt(item.slice(0, separator), 10)
      const name = item.slice(separator + 1).trim()
      if (!Number.isInteger(id) || id < 0 || id > 0xffff || name === '') {
        continue
      }
      names.set(id, name)
    }
  }
  return names
}

/**
 * 标记段的三种状态。
 *
 * `absent` 与 `no-ents` 必须分开：前者是"日志里根本没有标记头"（老版本脚本、日志被刷掉），
 * 后者是"脚本跑了、实体表读不到"。前者安静处理，后者要在界面上说清楚。
 */
export type MapMarkStatus = 'ok' | 'no-ents' | 'absent'

export interface ParsedMarkLines {
  status: MapMarkStatus
  points: LandmarkPoint[]
  /** 分块是否收齐；`status` 不是 `ok` 时恒为 true（没有分块要收） */
  complete: boolean
  missing: number[]
}

/** 头行：`GSHMAPMARK:head:<ok|no-ents>:<总块数>` */
const MARK_HEAD_PATTERN = /GSHMAPMARK:head:(ok|no-ents):(\d+)\s*$/

/** 单点格式：`prefab@x,z` */
const MARK_POINT_PATTERN = /^([a-z0-9_]+)@(-?\d+),(-?\d+)$/

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 从控制台日志行里收集地标分块。
 *
 * 与 `parseChunkLines` 同一套规则（按序号拼接、行尾锚定、token 可选），只是内容换成
 * `prefab@x,z` 的点列表：
 *
 * - 行格式：`GSHMAPMARK:[<token>:]<序号>/<总数>:<内容>`；
 * - 内容**不允许出现引号或空白**，这样脚本源码的回显行（`print("GSHMAPMARK:"..i.."/"...`）
 *   不会被当成数据；
 * - **按序号拼**：缺块就如实报"不完整"，绝不拼出一张标记错位的地图。
 */
export function parseMarkLines(lines: string[], queryToken: string): ParsedMarkLines {
  const token = escapeForRegExp(queryToken)
  const pattern = new RegExp(`${MAP_MARK_MARKER}(?:${token}:)?(\\d+)/(\\d+):([^"\\s]*)\\s*$`)
  const collected = new Map<number, string>()
  let status: MapMarkStatus = 'absent'
  let declaredTotal = 0

  for (const raw of lines) {
    const line = raw.trim()
    const head = MARK_HEAD_PATTERN.exec(line)
    if (head) {
      status = head[1] as MapMarkStatus
      declaredTotal = Number.parseInt(head[2]!, 10)
      continue
    }
    const matched = pattern.exec(line)
    if (!matched) {
      continue
    }
    const index = Number.parseInt(matched[1]!, 10)
    const total = Number.parseInt(matched[2]!, 10)
    collected.set(index, matched[3] ?? '')
    if (total > declaredTotal) {
      declaredTotal = total
    }
  }

  if (status !== 'ok') {
    return { status, points: [], complete: true, missing: [] }
  }

  const missing: number[] = []
  const parts: string[] = []
  for (let index = 0; index < declaredTotal; index += 1) {
    const part = collected.get(index)
    if (part === undefined) {
      missing.push(index)
      continue
    }
    parts.push(part)
  }

  /**
   * 单个点格式不对就跳过它，而不是整次失败：坐标解析出错最多少一个标记，
   * 而"因为一个点坏掉就丢掉整层标记"是明显更差的结果。
   */
  const points: LandmarkPoint[] = []
  for (const item of parts.join('').split(';')) {
    if (item === '') {
      continue
    }
    const matched = MARK_POINT_PATTERN.exec(item)
    if (!matched) {
      continue
    }
    points.push({
      prefab: matched[1]!,
      x: Number.parseInt(matched[2]!, 10),
      z: Number.parseInt(matched[3]!, 10),
    })
  }

  return {
    status: 'ok',
    points,
    complete: declaredTotal === 0 || (missing.length === 0 && collected.size >= declaredTotal),
    missing,
  }
}

export { MAP_CHUNK_MARKER, MAP_CHUNK_SIZE, splitIntoChunks }
