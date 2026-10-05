import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { ensureDstClusterConfig } from './cluster-config'
import {
  migrateLegacyLeveldataOverride,
  migrateLegacyLeveldataOverrides,
  parseLeveldataOverrides,
} from './leveldata-override'
import { isCavesShardConfigured, resolveShardLeveldataPath, resolveShardWorldgenPath } from './shard-layout'
import { parseWorldgenOverride } from './worldgen-override'

const tempDirs: string[] = []

function makeTempInstall(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-leveldata-'))
  tempDirs.push(dir)
  return dir
}

function writeLegacyLeveldata(installPath: string, content: string): string {
  const target = resolveShardLeveldataPath(installPath, 'master')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
  return target
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('leveldata-override 迁移', () => {
  it('moves legacy overrides into worldgenoverride.lua and deletes the old file', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { instanceName: 'Test', gamePort: 10999 })
    const legacyPath = writeLegacyLeveldata(installPath, [
      'return {',
      '  desc="Standard experience.",',
      '  id="SURVIVAL_TOGETHER",',
      '  location="forest",',
      '  name="Standard Forest",',
      '  overrides={',
      '   krampus="often",',
      '   day="longer"',
      '  },',
      '  settings_id="SURVIVAL_TOGETHER",',
      '}',
      '',
    ].join('\n'))

    assert.equal(migrateLegacyLeveldataOverride(installPath, 'master'), true)

    assert.equal(fs.existsSync(legacyPath), false, '旧文件应被删除')
    const worldgenPath = resolveShardWorldgenPath(installPath, 'master')
    const parsed = parseWorldgenOverride(fs.readFileSync(worldgenPath, 'utf8'))
    assert.equal(parsed.preset, 'SURVIVAL_TOGETHER')
    assert.equal(parsed.overrides.krampus, 'often')
    assert.equal(parsed.overrides.day, 'longer')
    assert.equal(fs.readdirSync(path.dirname(worldgenPath)).some(name => name.startsWith('leveldataoverride.lua.bak.')), true)
  })

  it('keeps panel-saved worldgen values over legacy ones and stays idempotent', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { instanceName: 'Test', gamePort: 10999 })
    const worldgenPath = resolveShardWorldgenPath(installPath, 'master')
    fs.writeFileSync(worldgenPath, [
      'return {',
      '  override_enabled = true,',
      '  preset = "SURVIVAL_TOGETHER",',
      '  overrides = {',
      '    krampus="rare",',
      '  },',
      '}',
      '',
    ].join('\n'), 'utf8')
    writeLegacyLeveldata(installPath, 'return {\n  overrides={\n    krampus="often",\n    day="longer",\n  },\n}\n')

    assert.equal(migrateLegacyLeveldataOverride(installPath, 'master'), true)
    const parsed = parseWorldgenOverride(fs.readFileSync(worldgenPath, 'utf8'))
    assert.equal(parsed.overrides.krampus, 'rare')
    assert.equal(parsed.overrides.day, 'longer')

    // 幂等：旧文件已删除，再次调用不再改动
    assert.equal(migrateLegacyLeveldataOverride(installPath, 'master'), false)
  })

  it('carries overrides from a legacy file without preset metadata', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { instanceName: 'Test', gamePort: 10999 })
    writeLegacyLeveldata(installPath, 'return {\n  overrides={\n    day="longer",\n  },\n  location="forest",\n  version=4,\n}\n')

    assert.equal(migrateLegacyLeveldataOverrides(installPath), 1)
    const parsed = parseWorldgenOverride(fs.readFileSync(resolveShardWorldgenPath(installPath, 'master'), 'utf8'))
    assert.equal(parsed.preset, 'SURVIVAL_TOGETHER')
    assert.deepEqual(parsed.overrides, { day: 'longer' })
  })

  it('uses the legacy settings_id as preset when worldgenoverride.lua is missing', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { instanceName: 'Test', gamePort: 10999 })
    const worldgenPath = resolveShardWorldgenPath(installPath, 'master')
    fs.rmSync(worldgenPath, { force: true })
    writeLegacyLeveldata(installPath, 'return {\n  id="SURVIVAL_TOGETHER",\n  settings_id="SURVIVAL_TOGETHER",\n  overrides={\n    day="longer",\n  },\n}\n')

    assert.equal(migrateLegacyLeveldataOverride(installPath, 'master'), true)
    const parsed = parseWorldgenOverride(fs.readFileSync(worldgenPath, 'utf8'))
    assert.equal(parsed.preset, 'SURVIVAL_TOGETHER')
    assert.equal(parsed.overrides.day, 'longer')
  })

  it('leaves a legacy-only caves shard alone until caves is configured', () => {
    const installPath = makeTempInstall()
    ensureDstClusterConfig(installPath, { instanceName: 'Test', gamePort: 10999 })
    assert.equal(isCavesShardConfigured(installPath), false)
    const cavesLegacy = resolveShardLeveldataPath(installPath, 'caves')
    fs.mkdirSync(path.dirname(cavesLegacy), { recursive: true })
    fs.writeFileSync(cavesLegacy, 'return {\n  overrides={\n    day="longer",\n  },\n}\n', 'utf8')

    assert.equal(migrateLegacyLeveldataOverrides(installPath), 0)
    assert.equal(fs.existsSync(cavesLegacy), true)
  })

  it('parseLeveldataOverrides still reads plain override blocks', () => {
    assert.deepEqual(parseLeveldataOverrides('return {\n  overrides={\n    krampus="often",\n  },\n}\n'), { krampus: 'often' })
    assert.deepEqual(parseLeveldataOverrides('return { }'), {})
  })
})
