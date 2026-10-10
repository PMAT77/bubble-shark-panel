import fengari from 'fengari'

/*!
 * Fengari - MIT License
 * Copyright © 2017-2019 Benoit Giannangeli
 * Copyright © 2017-2025 Daurnimator
 * Copyright © 1994–2017 Lua.org, PUC-Rio.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// This process receives source text only. No host objects or file loaders enter Lua.
const { lua, lauxlib, lualib, to_luastring } = fengari
const MAX_BYTES = 1024 * 1024
const LIMIT_MARKER = '__MODINFO_LIMIT__'
const fail = (status) => ({ status, definitions: [] })

function evaluate(source, workshopId) {
  const L = lauxlib.luaL_newstate()
  let instructions = 0
  let exceeded = false
  let allocatedBytes = 0
  const NativeUint8Array = globalThis.Uint8Array
  // Fengari strings use Uint8Array, including VM concatenation. Guard allocations
  // in this disposable child, retaining the native prototype for cached strings.
  globalThis.Uint8Array = new Proxy(NativeUint8Array, {
    construct(target, args, newTarget) {
      const value = args[0]
      const size = typeof value === 'number' ? value
        : value instanceof ArrayBuffer ? (args[2] ?? value.byteLength - (args[1] ?? 0))
          : (value?.length ?? 0)
      allocatedBytes += Math.max(size, 0)
      if (size > MAX_BYTES || allocatedBytes > 64 * MAX_BYTES) {
        exceeded = true
        throw new Error(LIMIT_MARKER)
      }
      return Reflect.construct(target, args, newTarget)
    },
  })
  try {
    for (const [name, open] of [['_G', lualib.luaopen_base], ['table', lualib.luaopen_table], ['string', lualib.luaopen_string], ['math', lualib.luaopen_math]]) {
      lauxlib.luaL_requiref(L, to_luastring(name), open, 1)
      lua.lua_pop(L, 1)
    }
    for (const name of ['dofile', 'loadfile', 'load', 'collectgarbage']) {
      lua.lua_pushnil(L)
      lua.lua_setglobal(L, to_luastring(name))
    }
    lua.lua_pushcfunction(L, () => 0)
    lua.lua_setglobal(L, to_luastring('print'))
    for (const name of ['folder_name', 'modname']) {
      lua.lua_pushstring(L, to_luastring(`workshop-${workshopId}`))
      lua.lua_setglobal(L, to_luastring(name))
    }
    const bootstrap = `
      locale = "zh"
      unpack = table.unpack
      function ChooseTranslationTable(t) return t[locale] or t[1] end
      string.dump, string.pack, string.packsize, string.unpack = nil, nil, nil, nil
    `
    if (lauxlib.luaL_loadbufferx(L, to_luastring(bootstrap), null, to_luastring('setup'), to_luastring('t')) !== lua.LUA_OK
      || lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) return fail('parse_failed')
    lua.lua_sethook(L, () => {
      instructions += 1000
      if (instructions > 1_000_000) {
        exceeded = true
        lauxlib.luaL_error(L, to_luastring(LIMIT_MARKER))
      }
    }, lua.LUA_MASKCOUNT, 1000)
    if (lauxlib.luaL_loadbufferx(L, to_luastring(source), null, to_luastring('modinfo'), to_luastring('t')) !== lua.LUA_OK
      || lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
      const error = lua.lua_tojsstring(L, -1) ?? ''
      return fail(exceeded || error.includes(LIMIT_MARKER) ? 'limit_exceeded' : 'parse_failed')
    }
    if (exceeded) return fail('limit_exceeded')
    // Support both ordinary global assignments and a returned metadata table.
    lua.lua_getglobal(L, to_luastring('configuration_options'))
    if (lua.lua_isnil(L, -1) && lua.lua_istable(L, -2)) {
      lua.lua_pop(L, 1)
      lua.lua_pushstring(L, to_luastring('configuration_options'))
      lua.lua_rawget(L, -2)
    }
    if (lua.lua_isnil(L, -1)) return fail('empty')
    if (!lua.lua_istable(L, -1)) return fail('parse_failed')
    const rawField = (index, name) => {
      lua.lua_pushstring(L, to_luastring(name))
      lua.lua_rawget(L, index)
    }
    const scalar = (index) => {
      switch (lua.lua_type(L, index)) {
        case lua.LUA_TNIL: return null
        case lua.LUA_TSTRING: return lua.lua_tojsstring(L, index)
        case lua.LUA_TBOOLEAN: return lua.lua_toboolean(L, index)
        case lua.LUA_TNUMBER: {
          const value = lua.lua_tonumber(L, index)
          if (Number.isFinite(value)) return value
          break
        }
      }
      throw new Error('unsupported configuration value')
    }
    const field = (index, name) => {
      rawField(index, name)
      const value = scalar(-1)
      lua.lua_pop(L, 1)
      return value
    }
    const text = (index, name) => {
      const value = field(index, name)
      if (value !== null && typeof value !== 'string') throw new Error('invalid text')
      return value
    }
    const definitions = []
    const names = new Set()
    let totalOptions = 0
    const count = lua.lua_rawlen(L, -1)
    if (count > 1000) return fail('limit_exceeded')
    const table = lua.lua_absindex(L, -1)
    for (let i = 1; i <= count; i++) {
      lua.lua_rawgeti(L, table, i)
      if (!lua.lua_istable(L, -1)) throw new Error('invalid definition')
      const row = lua.lua_absindex(L, -1)
      const name = (text(row, 'name') ?? '').trim()
      const label = text(row, 'label')
      const isHeader = field(row, 'is_header') === true || (!name && !!label)
      if (!isHeader && (!name || names.has(name))) throw new Error('invalid name')
      if (!isHeader) names.add(name)
      const definition = { name, label, hover: text(row, 'hover'), default: field(row, 'default'), options: [] }
      if (isHeader) definition.isHeader = true
      if (!isHeader) {
        rawField(row, 'options')
        if (!lua.lua_isnil(L, -1) && !lua.lua_istable(L, -1)) throw new Error('invalid options')
        if (lua.lua_istable(L, -1)) {
          const optionsTable = lua.lua_absindex(L, -1)
          const length = lua.lua_rawlen(L, -1)
          totalOptions += length
          if (length > 1000 || totalOptions > 10_000) return fail('limit_exceeded')
          for (let j = 1; j <= length; j++) {
            lua.lua_rawgeti(L, optionsTable, j)
            if (!lua.lua_istable(L, -1)) throw new Error('invalid option')
            const option = lua.lua_absindex(L, -1)
            const data = field(option, 'data')
            if (data === null) throw new Error('unsupported option data')
            definition.options.push({ data, description: text(option, 'description') ?? String(data) })
            lua.lua_pop(L, 1)
          }
        }
        lua.lua_pop(L, 1)
      }
      definitions.push(definition)
      lua.lua_pop(L, 1)
    }
    return { status: definitions.length ? 'parsed' : 'empty', definitions }
  }
  catch {
    return fail(exceeded ? 'limit_exceeded' : 'parse_failed')
  }
  finally {
    globalThis.Uint8Array = NativeUint8Array
    lua.lua_close(L)
  }
}

const chunks = []
let size = 0
process.stdin.on('data', (chunk) => {
  size += chunk.length
  if (size <= MAX_BYTES) chunks.push(chunk)
})
process.stdin.on('end', () => {
  const result = size > MAX_BYTES ? fail('limit_exceeded') : evaluate(Buffer.concat(chunks).toString('utf8'), process.argv[2] ?? '')
  const json = JSON.stringify(result)
  process.stdout.write(Buffer.byteLength(json) > MAX_BYTES ? JSON.stringify(fail('limit_exceeded')) : json)
})
