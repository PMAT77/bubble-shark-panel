import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { resolveClusterPaths } from './cluster-service'
import { DST_WORKSHOP_APP_ID } from './constants'
import {
  buildLuaConfigurationOptionsInline,
  parseModOverridesConfigurations,
  parseStoredModConfig,
  serializeLuaConfigValue,
} from './mod-config'
import { readModInfoConfigurations } from './modinfo-reader'

const tempDirs: string[] = []

function createInstallPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-mod-config-'))
  tempDirs.push(dir)
  return dir
}

function writeModInfo(installPath: string, workshopId: string, content: string) {
  const modDir = path.join(installPath, 'steamapps', 'workshop', 'content', String(DST_WORKSHOP_APP_ID), workshopId)
  fs.mkdirSync(modDir, { recursive: true })
  fs.writeFileSync(path.join(modDir, 'modinfo.lua'), content)
}

function writeModOverrides(installPath: string, content: string) {
  const { clusterRoot } = resolveClusterPaths(installPath)
  fs.mkdirSync(path.join(clusterRoot, 'Master'), { recursive: true })
  fs.writeFileSync(path.join(clusterRoot, 'Master', 'modoverrides.lua'), content)
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const SAMPLE_MODINFO = [
  'name = "Sample Mod"',
  '',
  'configuration_options =',
  '{',
  '    {',
  '        name = "option_a",',
  '        label = "选项A",',
  '        hover = "提示 -- 不是注释",',
  '        options =',
  '        {',
  '            {description = "低", data = 1},',
  '            {description = "高", data = "high"}, -- 尾注释',
  '        },',
  '        default = 1,',
  '    },',
  '    {',
  "        name = 'option_b',",
  '        label = "开关",',
  '        options =',
  '        {',
  '            {description = "开", data = true},',
  '            {description = "关", data = false},',
  '        },',
  '        default = false,',
  '    },',
  '}',
].join('\n')

describe('readModInfoConfigurations', () => {
  it('parses definitions with comments, single quotes and escapes', async () => {
    const installPath = createInstallPath()
    writeModInfo(installPath, '123456', SAMPLE_MODINFO)

    const { definitions, definitionStatus } = await readModInfoConfigurations(installPath, '123456')
    assert.equal(definitionStatus, 'parsed')
    assert.equal(definitions.length, 2)
    assert.deepEqual(definitions[0], {
      name: 'option_a',
      label: '选项A',
      hover: '提示 -- 不是注释',
      options: [
        { description: '低', data: 1 },
        { description: '高', data: 'high' },
      ],
      default: 1,
    })
    assert.equal(definitions[1]?.name, 'option_b')
    assert.equal(definitions[1]?.default, false)
    assert.equal(definitions[1]?.hover, null)
  })

  it('distinguishes missing, malformed and empty metadata', async () => {
    const installPath = createInstallPath()
    assert.equal((await readModInfoConfigurations(installPath, '111')).definitionStatus, 'missing_file')

    writeModInfo(installPath, '222', 'configuration_options = { { name = "broken" ')
    assert.equal((await readModInfoConfigurations(installPath, '222')).definitionStatus, 'parse_failed')

    writeModInfo(installPath, '333', 'name = "no config section"')
    assert.equal((await readModInfoConfigurations(installPath, '333')).definitionStatus, 'empty')
  })

  it('reads the final dynamic table, translations, headers and typed defaults', async () => {
    const installPath = createInstallPath()
    writeModInfo(installPath, '444', `
      assert(locale == "zh" and folder_name == "workshop-444")
      local choices = {{description = ChooseTranslationTable({"Yes", zh = "是"}), data = true}, {description = "No", data = false}}
      local function option(name) return {name = name, label = ChooseTranslationTable({"English", zh = "中文"}), options = choices, default = false} end
      configuration_options = {{name = "Title", label = "分组", is_header = true}}
      for i = 1, 2 do table.insert(configuration_options, option("enable_" .. i)) end
      table.insert(configuration_options, {name = "number", default = 2.5})
      table.insert(configuration_options, {name = "text", label = ChooseTranslationTable({"Fallback"}), default = "01"})
    `)
    const result = await readModInfoConfigurations(installPath, '444')
    assert.equal(result.definitionStatus, 'parsed')
    assert.equal(result.definitions.length, 5)
    assert.equal(result.definitions[0].isHeader, true)
    assert.equal(result.definitions[1].label, '中文')
    assert.deepEqual(result.definitions[1].options[0], { description: '是', data: true })
    assert.equal(result.definitions[2].default, false)
    assert.equal(result.definitions[3].default, 2.5)
    assert.equal(result.definitions[4].label, 'Fallback')
    assert.equal(result.definitions[4].default, '01')
  })

  it('accepts returned metadata and does not confuse comments with assignments', async () => {
    const installPath = createInstallPath()
    writeModInfo(installPath, '555', '-- configuration_options = bogus\nreturn {configuration_options={{name="x", default=true}}}')
    const result = await readModInfoConfigurations(installPath, '555')
    assert.equal(result.definitionStatus, 'parsed')
    assert.equal(result.definitions[0].default, true)
  })

  it('has no filesystem, OS, module, JS or dynamic-loading capabilities and hides raw errors', async () => {
    const installPath = createInstallPath()
    writeModInfo(installPath, '666', 'assert(io == nil and os == nil and package == nil and require == nil and debug == nil and js == nil and load == nil and loadfile == nil and dofile == nil)\nconfiguration_options = {}')
    assert.equal((await readModInfoConfigurations(installPath, '666')).definitionStatus, 'empty')
    for (const attack of ['os.execute("echo unsafe")', 'require("fs")', 'loadfile("secret")', 'error("token=secret /private/file")']) {
      writeModInfo(installPath, '666', attack)
      const result = await readModInfoConfigurations(installPath, '666')
      assert.equal(result.definitionStatus, 'parse_failed')
      assert.doesNotMatch(JSON.stringify(result), /token=secret|\/private\/file|unsafe/)
    }
  })

  it('rejects unsupported values rather than returning incomplete definitions', async () => {
    const installPath = createInstallPath()
    writeModInfo(installPath, '777', 'configuration_options={{name="ok", default=true}, {name="bad", options={{description="table",data={1}}}}}')
    const result = await readModInfoConfigurations(installPath, '777')
    assert.equal(result.definitionStatus, 'parse_failed')
    assert.deepEqual(result.definitions, [])
  })

  it('bounds source, instructions, native string expansion and exported output', async () => {
    const installPath = createInstallPath()
    for (const source of [
      ' '.repeat(1024 * 1024 + 1), 'while true do end',
      'local x = string.rep("x", 2147483647)',
      'local s="x"; for i=1,30 do s=s..s end',
      'local t={}; for i=1,100 do t[i]=string.rep("x",1000000) end',
      'configuration_options={{name="x",hover=string.rep("a",700000),default=string.rep("b",700000)}}',
    ]) {
      writeModInfo(installPath, '888', source)
      assert.equal((await readModInfoConfigurations(installPath, '888')).definitionStatus, 'limit_exceeded')
    }
  })

  it('kills native operations on timeout and remains usable on the next read', async () => {
    const installPath = createInstallPath()
    writeModInfo(installPath, '999', 'string.match(string.rep("a", 100000), "a*a*a*a*a*a*a*a*b")')
    assert.equal((await readModInfoConfigurations(installPath, '999')).definitionStatus, 'timeout')
    writeModInfo(installPath, '999', 'configuration_options = {}')
    assert.equal((await readModInfoConfigurations(installPath, '999')).definitionStatus, 'empty')
  })
})

describe('parseModOverridesConfigurations', () => {
  it('imports configuration options from existing modoverrides.lua', () => {
    const installPath = createInstallPath()
    writeModOverrides(installPath, [
      'return {',
      '  ["workshop-111"]={ enabled=true, configuration_options={ opt_str="a\\"b", opt_num=3, opt_bool=true } },',
      '  ["workshop-222"]={ enabled=false },',
      '}',
    ].join('\n'))

    const imported = parseModOverridesConfigurations(installPath)
    assert.deepEqual(imported.get('111'), { opt_str: 'a"b', opt_num: 3, opt_bool: true })
    assert.equal(imported.has('222'), false)
  })

  it('returns empty map when file is missing or malformed', () => {
    const installPath = createInstallPath()
    assert.equal(parseModOverridesConfigurations(installPath).size, 0)

    writeModOverrides(installPath, 'return { broken')
    assert.equal(parseModOverridesConfigurations(installPath).size, 0)
  })
})

describe('serializeLuaConfigValue', () => {
  it('escapes strings and renders scalars', () => {
    assert.equal(serializeLuaConfigValue('a"b'), '"a\\"b"')
    assert.equal(serializeLuaConfigValue('back\\slash'), '"back\\\\slash"')
    assert.equal(serializeLuaConfigValue('line\nbreak'), '"line\\nbreak"')
    assert.equal(serializeLuaConfigValue(3), '3')
    assert.equal(serializeLuaConfigValue(-1.5), '-1.5')
    assert.equal(serializeLuaConfigValue(true), 'true')
    assert.equal(serializeLuaConfigValue(false), 'false')
    assert.throws(() => serializeLuaConfigValue(Number.NaN))
  })
})

describe('buildLuaConfigurationOptionsInline', () => {
  it('renders empty string for no options and inline table otherwise', () => {
    assert.equal(buildLuaConfigurationOptionsInline({}), '')
    assert.equal(
      buildLuaConfigurationOptionsInline({ plain: 1, 'weird key': 'v' }),
      ', configuration_options={ plain=1, ["weird key"]="v" }',
    )
  })
})

describe('parseStoredModConfig', () => {
  it('parses stored json and filters invalid values', () => {
    assert.equal(parseStoredModConfig(null), null)
    assert.equal(parseStoredModConfig(''), null)
    assert.equal(parseStoredModConfig('{}'), null)
    assert.equal(parseStoredModConfig('not json'), null)
    assert.deepEqual(parseStoredModConfig('{"a":1,"b":"x","c":true,"d":null,"e":[1]}'), {
      a: 1,
      b: 'x',
      c: true,
    })
  })
})
