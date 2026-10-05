import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { resolveClusterPaths } from './cluster-service'
import { DST_WORKSHOP_APP_ID } from './constants'
import {
  buildLuaConfigurationOptionsInline,
  parseModInfoConfigurations,
  parseModOverridesConfigurations,
  parseStoredModConfig,
  serializeLuaConfigValue,
} from './mod-config'

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

describe('parseModInfoConfigurations', () => {
  it('parses definitions with comments, single quotes and escapes', () => {
    const installPath = createInstallPath()
    writeModInfo(installPath, '123456', SAMPLE_MODINFO)

    const definitions = parseModInfoConfigurations(installPath, '123456')
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

  it('returns empty when modinfo is missing or malformed', () => {
    const installPath = createInstallPath()
    assert.deepEqual(parseModInfoConfigurations(installPath, '111'), [])

    writeModInfo(installPath, '222', 'configuration_options = { { name = "broken" ')
    assert.deepEqual(parseModInfoConfigurations(installPath, '222'), [])

    writeModInfo(installPath, '333', 'name = "no config section"')
    assert.deepEqual(parseModInfoConfigurations(installPath, '333'), [])
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
