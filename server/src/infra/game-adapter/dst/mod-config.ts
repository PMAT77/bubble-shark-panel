import fs from 'node:fs'
import path from 'node:path'
import type { ModConfigValues } from '../../../../../shared/contracts/mod'
import { DST_CLUSTER_NAME, DST_WORKSHOP_APP_ID } from './constants'
import { resolveClusterPaths } from './cluster-service'

const MOD_OVERRIDES_FILE_NAME = 'modoverrides.lua'
const MOD_INFO_FILE_NAME = 'modinfo.lua'
/** 超过该大小的 Lua 文件不解析（防第三方异常文件拖垮请求） */
const MAX_LUA_PARSE_LENGTH = 1024 * 1024

type LuaValue = string | number | boolean | null | LuaTable

interface LuaTable {
  entries: Map<string | number, LuaValue>
}

function isLuaTable(value: LuaValue | undefined): value is LuaTable {
  return typeof value === 'object' && value !== null && 'entries' in value
}

function isLuaScalar(value: LuaValue | undefined): value is string | number | boolean {
  return typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
}

class LuaParseError extends Error {}

function skipWhitespaceAndComments(source: string, index: number): number {
  let i = index
  while (i < source.length) {
    const ch = source[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1
      continue
    }
    if (ch === '-' && source[i + 1] === '-') {
      if (source.startsWith('--[[', i)) {
        const end = source.indexOf(']]', i + 4)
        if (end < 0) {
          throw new LuaParseError('unterminated block comment')
        }
        i = end + 2
        continue
      }
      const lineEnd = source.indexOf('\n', i)
      i = lineEnd < 0 ? source.length : lineEnd + 1
      continue
    }
    break
  }
  return i
}

function parseLuaQuotedString(source: string, index: number): { value: string, next: number } {
  const quote = source[index]
  if (quote !== '"' && quote !== "'") {
    throw new LuaParseError('expected quoted string')
  }
  let i = index + 1
  let out = ''
  while (i < source.length) {
    const ch = source[i]
    if (ch === quote) {
      return { value: out, next: i + 1 }
    }
    if (ch === '\\') {
      const escaped = source[i + 1]
      if (escaped === undefined) {
        throw new LuaParseError('unterminated string escape')
      }
      const escapeMap: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', "'": "'", '\\': '\\' }
      out += escapeMap[escaped] ?? escaped
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  throw new LuaParseError('unterminated string')
}

function parseLuaLongString(source: string, index: number): { value: string, next: number } {
  const end = source.indexOf(']]', index + 2)
  if (end < 0) {
    throw new LuaParseError('unterminated long string')
  }
  return { value: source.slice(index + 2, end), next: end + 2 }
}

function parseLuaValue(source: string, index: number): { value: LuaValue, next: number } {
  const i = skipWhitespaceAndComments(source, index)
  if (i >= source.length) {
    throw new LuaParseError('unexpected end of source')
  }
  const ch = source[i]
  if (ch === '{') {
    return parseLuaTable(source, i)
  }
  if (ch === '"' || ch === "'") {
    return parseLuaQuotedString(source, i)
  }
  if (ch === '[' && source[i + 1] === '[') {
    return parseLuaLongString(source, i)
  }
  const numberMatch = /^-?\d+\.?\d*(?:[eE][+-]?\d+)?/.exec(source.slice(i, i + 34))
  if (numberMatch) {
    return { value: Number(numberMatch[0]), next: i + numberMatch[0].length }
  }
  const identMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i, i + 256))
  if (identMatch) {
    const word = identMatch[0]
    if (word === 'true') {
      return { value: true, next: i + 4 }
    }
    if (word === 'false') {
      return { value: false, next: i + 5 }
    }
    if (word === 'nil') {
      return { value: null, next: i + 3 }
    }
    throw new LuaParseError('unsupported identifier: ' + word)
  }
  throw new LuaParseError('unexpected character: ' + ch)
}

function parseLuaTable(source: string, index: number): { value: LuaTable, next: number } {
  let i = skipWhitespaceAndComments(source, index + 1)
  const table: LuaTable = { entries: new Map() }
  let arrayIndex = 0
  while (true) {
    i = skipWhitespaceAndComments(source, i)
    if (i >= source.length) {
      throw new LuaParseError('unterminated table')
    }
    if (source[i] === '}') {
      return { value: table, next: i + 1 }
    }
    let key: string | number
    let value: LuaValue
    const identKeyMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i, i + 256))
    if (source[i] === '[') {
      const inner = parseLuaValue(source, i + 1)
      const after = skipWhitespaceAndComments(source, inner.next)
      if (source[after] !== ']') {
        throw new LuaParseError('expected closing bracket')
      }
      if (typeof inner.value !== 'string' && typeof inner.value !== 'number') {
        throw new LuaParseError('unsupported key type')
      }
      key = inner.value
      const afterBracket = skipWhitespaceAndComments(source, after + 1)
      if (source[afterBracket] !== '=' || source[afterBracket + 1] === '=') {
        throw new LuaParseError('expected = after bracket key')
      }
      const parsed = parseLuaValue(source, afterBracket + 1)
      value = parsed.value
      i = parsed.next
    }
    else if (identKeyMatch) {
      const afterIdent = skipWhitespaceAndComments(source, i + identKeyMatch[0].length)
      if (source[afterIdent] === '=' && source[afterIdent + 1] !== '=') {
        key = identKeyMatch[0]
        const parsed = parseLuaValue(source, afterIdent + 1)
        value = parsed.value
        i = parsed.next
      }
      else {
        arrayIndex += 1
        key = arrayIndex
        const parsed = parseLuaValue(source, i)
        value = parsed.value
        i = parsed.next
      }
    }
    else {
      arrayIndex += 1
      key = arrayIndex
      const parsed = parseLuaValue(source, i)
      value = parsed.value
      i = parsed.next
    }
    table.entries.set(key, value)
    i = skipWhitespaceAndComments(source, i)
    if (source[i] === ',' || source[i] === ';') {
      i += 1
      continue
    }
    if (source[i] === '}') {
      return { value: table, next: i + 1 }
    }
    throw new LuaParseError('expected , ; or } at position ' + i)
  }
}

/** 解析一段 Lua 表字面量（必须以 { 开头，可含注释）；失败返回 null */
function parseLuaTableLiteral(source: string): LuaTable | null {
  if (source.length > MAX_LUA_PARSE_LENGTH) {
    return null
  }
  try {
    const start = skipWhitespaceAndComments(source, 0)
    if (source[start] !== '{') {
      return null
    }
    return parseLuaTable(source, start).value
  }
  catch {
    return null
  }
}

function resolveDstModInfoCandidates(installPath: string, workshopId: string): string[] {
  return [
    path.join(installPath, 'steamapps', 'workshop', 'content', String(DST_WORKSHOP_APP_ID), workshopId, MOD_INFO_FILE_NAME),
    path.join(installPath, 'mods', 'workshop-' + workshopId, MOD_INFO_FILE_NAME),
    ...['Master', 'Caves'].map(shard =>
      path.join(installPath, 'ugc_mods', DST_CLUSTER_NAME, shard, 'content', String(DST_WORKSHOP_APP_ID), workshopId, MOD_INFO_FILE_NAME),
    ),
  ]
}

/** 按下载目录优先级探测 modinfo.lua；不存在返回 null */
export function resolveDstModInfoPath(installPath: string, workshopId: string): string | null {
  for (const candidate of resolveDstModInfoCandidates(installPath, workshopId)) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/**
 * 读取 modinfo.lua 的展示名。
 * 导入存档时源档 modoverrides.lua 只有 workshop ID，入库名是 `workshop-<id>` 占位，
 * 内容下载落地后由此补齐真实名称；文件不存在或解析失败返回 null，绝不抛错。
 */
export function resolveModDisplayName(installPath: string, workshopId: string, sourcePath?: string): string | null {
  const modInfoPath = sourcePath ?? resolveDstModInfoPath(installPath, workshopId)
  if (!modInfoPath) {
    return null
  }
  try {
    if (fs.statSync(modInfoPath).size > MAX_LUA_PARSE_LENGTH) {
      return null
    }
    const content = fs.readFileSync(modInfoPath, 'utf8')
    const table = parseLuaTableLiteral(content.replace(/^\s*return\s*/, ''))
    const tableName = table?.entries.get('name')
    if (typeof tableName === 'string' && tableName.trim()) {
      return tableName.trim()
    }
    // 少数 modinfo.lua 不是单个表字面量，退化为顶层赋值匹配
    const fallback = /^\s*name\s*=\s*["']([^"'\r\n]+)["']/m.exec(content)?.[1]?.trim()
    return fallback || null
  }
  catch {
    return null
  }
}

/**
 * 读取 modinfo.lua 里声明的依赖创意工坊 ID（供下载队列选批用）。
 *
 * 只用本地可得的数据：内容已下载时 modinfo.lua 里就写明了 dependencies；内容缺失的 Mod
 * 没有文件可读，依赖信息就是空——选批路径上不打 Steam 接口，避免国内网络下拖住队列。
 *
 * 兼容两种写法：`dependencies = { "workshop-123" }` 与 `dependencies = { ["workshop-123"] = true }`。
 */
export function parseModInfoDependencies(installPath: string, workshopId: string, sourcePath?: string): string[] {
  const modInfoPath = sourcePath ?? resolveDstModInfoPath(installPath, workshopId)
  if (!modInfoPath) {
    return []
  }
  try {
    if (fs.statSync(modInfoPath).size > MAX_LUA_PARSE_LENGTH) {
      return []
    }
    const content = fs.readFileSync(modInfoPath, 'utf8')
    const match = /dependencies\s*=\s*/.exec(content)
    if (!match) {
      return []
    }
    const table = parseLuaTableLiteral(content.slice(match.index + match[0].length))
    if (!table) {
      return []
    }
    const ids = new Set<string>()
    for (const [key, value] of table.entries) {
      const fromKey = typeof key === 'string' ? normalizeWorkshopDependencyId(key) : null
      if (fromKey) {
        ids.add(fromKey)
      }
      const fromValue = typeof value === 'string' ? normalizeWorkshopDependencyId(value) : null
      if (fromValue) {
        ids.add(fromValue)
      }
    }
    return [...ids]
  }
  catch {
    return []
  }
}

/** `workshop-123` / `workshop_123` / `123` 统一成纯数字工坊 ID；非工坊 ID 一律丢弃 */
function normalizeWorkshopDependencyId(raw: string | null): string | null {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) {
    return null
  }
  const stripped = trimmed.replace(/^workshop[-_]/i, '')
  return /^\d{1,20}$/.test(stripped) ? stripped : null
}

/**
 * 读取 Master/modoverrides.lua 中各 mod 的 configuration_options（导入预填用）。
 * 文件不存在或解析失败返回空 Map。
 */
export function parseModOverridesConfigurations(installPath: string): Map<string, ModConfigValues> {
  const result = new Map<string, ModConfigValues>()
  try {
    const { clusterRoot } = resolveClusterPaths(installPath)
    const overridesPath = path.join(clusterRoot, 'Master', MOD_OVERRIDES_FILE_NAME)
    if (!fs.existsSync(overridesPath)) {
      return result
    }
    const content = fs.readFileSync(overridesPath, 'utf8')
    const table = parseLuaTableLiteral(content.replace(/^\s*return\s*/, ''))
    if (!table) {
      return result
    }
    for (const [key, value] of table.entries) {
      if (typeof key !== 'string' || !isLuaTable(value)) {
        continue
      }
      const workshopId = key.replace(/^workshop-/, '').trim()
      if (!workshopId) {
        continue
      }
      const configRaw = value.entries.get('configuration_options')
      if (!isLuaTable(configRaw)) {
        continue
      }
      const options: ModConfigValues = {}
      for (const [configKey, configValue] of configRaw.entries) {
        if (typeof configKey === 'string' && isLuaScalar(configValue)) {
          options[configKey] = configValue
        }
      }
      if (Object.keys(options).length > 0) {
        result.set(workshopId, options)
      }
    }
    return result
  }
  catch {
    return result
  }
}

export interface ParsedModOverridesEntry {
  workshopId: string
  /** modoverrides.lua 中 enabled 字段；缺省按 DST 语义视为 false */
  enabled: boolean
  configurationOptions: Record<string, string | number | boolean>
}

/**
 * 解析任意路径的 modoverrides.lua 为有序 Mod 条目（存档导入反向入库用）。
 * 文件不存在或解析失败返回空数组，绝不抛错；键序即文件出现序。
 */
export function parseModOverridesEntries(filePath: string): ParsedModOverridesEntry[] {
  const entries: ParsedModOverridesEntry[] = []
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size > MAX_LUA_PARSE_LENGTH) {
      return entries
    }
    const content = fs.readFileSync(filePath, 'utf8')
    const table = parseLuaTableLiteral(content.replace(/^\s*return\s*/, ''))
    if (!table) {
      return entries
    }
    for (const [key, value] of table.entries) {
      if (typeof key !== 'string' || !isLuaTable(value)) {
        continue
      }
      const workshopId = key.replace(/^workshop-/, '').trim()
      if (!workshopId) {
        continue
      }
      const enabledValue = value.entries.get('enabled')
      const enabled = enabledValue === true
      const configurationOptions: Record<string, string | number | boolean> = {}
      const configRaw = value.entries.get('configuration_options')
      if (isLuaTable(configRaw)) {
        for (const [configKey, configValue] of configRaw.entries) {
          if (typeof configKey === 'string' && isLuaScalar(configValue)) {
            configurationOptions[configKey] = configValue
          }
        }
      }
      entries.push({ workshopId, enabled, configurationOptions })
    }
    return entries
  }
  catch {
    return entries
  }
}

/** 序列化 Lua 表键：合法标识符直接使用，否则用 ["key"] 形式 */
function serializeLuaConfigKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : '["' + key.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]'
}

/**
 * 序列化 Lua 配置值（信任边界：字符串必须转义）。
 * 非 string/number/boolean 值抛错（schema 层应已拦截）。
 */
export function serializeLuaConfigValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('无法序列化的配置值：' + String(value))
    }
    return String(value)
  }
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return '"' + escaped + '"'
}

/** 生成 modoverrides.lua 中 configuration_options 的内联片段；空配置返回空串 */
export function buildLuaConfigurationOptionsInline(options: ModConfigValues): string {
  const entries = Object.entries(options)
  if (entries.length === 0) {
    return ''
  }
  const inner = entries
    .map(([key, value]) => serializeLuaConfigKey(key) + '=' + serializeLuaConfigValue(value))
    .join(', ')
  return ', configuration_options={ ' + inner + ' }'
}

/** 解析 DB 中 JSON 序列化的配置；空/非法/过滤后为空均返回 null（未配置语义） */
export function parseStoredModConfig(config: string | null): ModConfigValues | null {
  if (!config?.trim()) {
    return null
  }
  try {
    const parsed = JSON.parse(config) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const options: ModConfigValues = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (key.trim() && isLuaScalar(value)) {
        options[key] = value
      }
    }
    return Object.keys(options).length > 0 ? options : null
  }
  catch {
    return null
  }
}

/** 诊断/测试用：内部解析器访问 */
export const __modConfigTestUtils = {
  parseLuaTableLiteral,
  parseLuaQuotedString,
  parseLuaValue,
  skipWhitespaceAndComments,
}

/** 本地包静态元数据；不运行 Lua，复杂表达式按未知处理。 */
export function readLocalModInfo(sourcePath: string): { name: string | null, version: string | null, dependencyIds: string[] } {
  let version: string | null = null
  try {
    if (fs.statSync(sourcePath).size <= MAX_LUA_PARSE_LENGTH) {
      const content = fs.readFileSync(sourcePath, 'utf8')
      const table = parseLuaTableLiteral(content.replace(/^\s*return\s*/, ''))
      const value = table?.entries.get('version')
      version = typeof value === 'string' || typeof value === 'number' ? String(value) : null
      if (!version) version = /^\s*version\s*=\s*["']([^"'\r\n]+)["']/m.exec(content)?.[1] ?? null
    }
  }
  catch { /* optional metadata */ }
  return { name: resolveModDisplayName('', '', sourcePath), version, dependencyIds: parseModInfoDependencies('', '', sourcePath) }
}
