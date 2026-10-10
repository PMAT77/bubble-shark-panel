/** 超过该大小的 Lua 文件不解析（防第三方异常文件拖垮请求） */
export const MAX_LUA_PARSE_LENGTH = 1024 * 1024

export type LuaValue = string | number | boolean | null | LuaTable

export interface LuaTable {
  entries: Map<string | number, LuaValue>
}

export function isLuaTable(value: LuaValue | undefined): value is LuaTable {
  return typeof value === 'object' && value !== null && 'entries' in value
}

export function isLuaScalar(value: LuaValue | undefined): value is string | number | boolean {
  return typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
}

class LuaParseError extends Error {}

export function skipWhitespaceAndComments(source: string, index: number): number {
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

export function parseLuaQuotedString(source: string, index: number): { value: string, next: number } {
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

export function parseLuaValue(source: string, index: number): { value: LuaValue, next: number } {
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
export function parseLuaTableLiteral(source: string): LuaTable | null {
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
