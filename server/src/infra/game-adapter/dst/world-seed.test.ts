import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  markObservedWorldSeedStale,
  readObservedWorldSeed,
  readWorldSeeds,
  writeObservedWorldSeed,
  writeWorldSeed,
} from './panel-config-meta'
import {
  BSP_WORLD_SEED_MOD_ID,
  buildWorldSeedModInfoContent,
  buildWorldSeedModWorldgenMainContent,
  ensureWorldSeedModLayout,
  isWorldSeedModId,
  resolveWorldSeedModDir,
  toWorldSeedModName,
  validateWorldSeed,
} from './world-seed'
import { resolveDstLegacyModDir } from './ugc-mod-install'

const tempDirs: string[] = []

function createInstallPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-world-seed-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('world-seed', () => {
  it('writes each shard seed into its own modworldgenmain.lua', () => {
    const installPath = createInstallPath()
    const folders = ensureWorldSeedModLayout(installPath, ['Master', 'Caves'], {
      master: '1608382646',
      caves: '42',
    })
    assert.deepEqual(folders, ['Master', 'Caves'])

    const masterMainPath = path.join(resolveWorldSeedModDir(installPath, 'Master'), 'modworldgenmain.lua')
    const cavesMainPath = path.join(resolveWorldSeedModDir(installPath, 'Caves'), 'modworldgenmain.lua')
    // 种子以数字字面量写入：存档里的 meta.seed 才会是数字
    assert.match(fs.readFileSync(masterMainPath, 'utf8'), /GLOBAL\.SEED = 1608382646/)
    assert.match(fs.readFileSync(cavesMainPath, 'utf8'), /GLOBAL\.SEED = 42/)
    // 两个分片各一份内容，因此地上与洞穴可以用不同种子
    assert.notEqual(fs.readFileSync(masterMainPath, 'utf8'), fs.readFileSync(cavesMainPath, 'utf8'))
  })

  it('writes server-only modinfo with the current api version', () => {
    const content = buildWorldSeedModInfoContent()
    assert.match(content, /api_version = 10/)
    assert.match(content, /all_clients_require_mod = false/)
    assert.match(content, /client_only_mod = false/)
    assert.match(content, /configuration_options = \{\}/)
    // DST 没有 server_only_mod 这个字段，写上只是噪音
    assert.equal(content.includes('server_only_mod'), false)
  })

  it('removes the mod directory from shards without a seed', () => {
    const installPath = createInstallPath()
    ensureWorldSeedModLayout(installPath, ['Master', 'Caves'], { master: '123456', caves: '654321' })
    const cavesDir = resolveWorldSeedModDir(installPath, 'Caves')
    assert.equal(fs.existsSync(cavesDir), true)

    const folders = ensureWorldSeedModLayout(installPath, ['Master', 'Caves'], { master: '123456' })
    assert.deepEqual(folders, ['Master'])
    assert.equal(fs.existsSync(cavesDir), false)
    assert.equal(fs.existsSync(resolveWorldSeedModDir(installPath, 'Master')), true)
  })

  /**
   * 回归：DST 从 `mods/workshop-<id>` 加载 Mod（见 resolveDstLegacyModDir），
   * 内置的世界种子 Mod 只写 ugc_mods 时同样不会被加载。
   */
  it('把内置 Mod 接入 DST 实际读取的 mods/workshop-<id>', () => {
    const installPath = createInstallPath()
    ensureWorldSeedModLayout(installPath, ['Master'], { master: '123456' })

    const legacyDir = resolveDstLegacyModDir(installPath, BSP_WORLD_SEED_MOD_ID)
    assert.match(fs.readFileSync(path.join(legacyDir, 'modinfo.lua'), 'utf8'), /GSH World Seed/)
    assert.match(fs.readFileSync(path.join(legacyDir, 'modworldgenmain.lua'), 'utf8'), /GLOBAL\.SEED = 123456/)
  })

  it('清掉种子后同时撤掉接入', () => {
    const installPath = createInstallPath()
    ensureWorldSeedModLayout(installPath, ['Master'], { master: '123456' })
    const legacyDir = resolveDstLegacyModDir(installPath, BSP_WORLD_SEED_MOD_ID)
    assert.equal(fs.existsSync(legacyDir), true)

    ensureWorldSeedModLayout(installPath, ['Master'], {})

    assert.equal(fs.existsSync(legacyDir), false)
  })

  it('两个分片种子不同时不接入（mods/ 是两个分片共用的一份）', () => {
    const installPath = createInstallPath()
    const cavesDir = path.join(installPath, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1', 'Caves')
    fs.mkdirSync(cavesDir, { recursive: true })
    fs.writeFileSync(path.join(cavesDir, 'server.ini'), '[SHARD]\n')

    ensureWorldSeedModLayout(installPath, ['Master', 'Caves'], { master: '123456', caves: '654321' })

    // 接入过去会让洞穴也用上地上世界的种子，比内置 Mod 不生效更糟
    assert.equal(fs.existsSync(resolveDstLegacyModDir(installPath, BSP_WORLD_SEED_MOD_ID)), false)
  })

  it('只给地上设了种子、洞穴却开着时同样不接入', () => {
    const installPath = createInstallPath()
    const cavesDir = path.join(installPath, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1', 'Caves')
    fs.mkdirSync(cavesDir, { recursive: true })
    fs.writeFileSync(path.join(cavesDir, 'server.ini'), '[SHARD]\n')

    ensureWorldSeedModLayout(installPath, ['Master', 'Caves'], { master: '123456' })

    assert.equal(fs.existsSync(resolveDstLegacyModDir(installPath, BSP_WORLD_SEED_MOD_ID)), false)
  })

  it('两个分片用同一个种子时接入', () => {
    const installPath = createInstallPath()
    const cavesDir = path.join(installPath, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1', 'Caves')
    fs.mkdirSync(cavesDir, { recursive: true })
    fs.writeFileSync(path.join(cavesDir, 'server.ini'), '[SHARD]\n')

    ensureWorldSeedModLayout(installPath, ['Master', 'Caves'], { master: '123456', caves: '123456' })

    assert.equal(fs.existsSync(resolveDstLegacyModDir(installPath, BSP_WORLD_SEED_MOD_ID)), true)
  })

  it('treats invalid seeds as unset and does not rewrite unchanged files', () => {
    const installPath = createInstallPath()
    assert.deepEqual(
      ensureWorldSeedModLayout(installPath, ['Master'], { master: 'not-a-seed' }),
      [],
    )
    assert.equal(fs.existsSync(resolveWorldSeedModDir(installPath, 'Master')), false)

    ensureWorldSeedModLayout(installPath, ['Master'], { master: '999' })
    const mainPath = path.join(resolveWorldSeedModDir(installPath, 'Master'), 'modworldgenmain.lua')
    const firstMtime = fs.statSync(mainPath).mtimeMs
    ensureWorldSeedModLayout(installPath, ['Master'], { master: '999' })
    assert.equal(fs.statSync(mainPath).mtimeMs, firstMtime)
  })

  it('validates the seed shape', () => {
    assert.equal(validateWorldSeed('123456'), null)
    assert.equal(validateWorldSeed('0'), null)
    assert.equal(validateWorldSeed('1'.repeat(15)), null)
    assert.match(validateWorldSeed('') ?? '', /不能为空/)
    assert.match(validateWorldSeed('12a') ?? '', /1–15 位数字/)
    assert.match(validateWorldSeed('1'.repeat(16)) ?? '', /1–15 位数字/)
  })

  it('recognises the reserved mod id', () => {
    assert.equal(isWorldSeedModId(BSP_WORLD_SEED_MOD_ID), true)
    assert.equal(isWorldSeedModId(` ${BSP_WORLD_SEED_MOD_ID} `), true)
    assert.equal(isWorldSeedModId('123456'), false)
    assert.equal(toWorldSeedModName(), `workshop-${BSP_WORLD_SEED_MOD_ID}`)
    assert.match(buildWorldSeedModWorldgenMainContent('7'), /GLOBAL\.SEED = 7/)
  })

  it('stores seeds per shard in the panel metadata', () => {
    const installPath = createInstallPath()
    writeWorldSeed(installPath, 'master', '123456')
    writeWorldSeed(installPath, 'caves', '654321')
    assert.deepEqual(readWorldSeeds(installPath), { master: '123456', caves: '654321' })

    writeWorldSeed(installPath, 'master', null)
    assert.deepEqual(readWorldSeeds(installPath), { caves: '654321' })
  })

  it('records the observed world seed per shard, independently of the configured one', () => {
    const installPath = createInstallPath()
    writeObservedWorldSeed(installPath, 'master', {
      seed: '1608382646',
      at: '2026-09-19T10:00:00.000Z',
      sessionId: 'SESSION_A',
    })
    assert.deepEqual(readObservedWorldSeed(installPath, 'master'), {
      seed: '1608382646',
      at: '2026-09-19T10:00:00.000Z',
      sessionId: 'SESSION_A',
    })
    assert.equal(readObservedWorldSeed(installPath, 'caves'), null)

    // 下次生成用的种子与当前世界的真实种子是两件事，互不覆盖
    writeWorldSeed(installPath, 'master', '777')
    assert.equal(readWorldSeeds(installPath).master, '777')
    assert.equal(readObservedWorldSeed(installPath, 'master')?.seed, '1608382646')
  })

  it('invalidates the record when the world is regenerated and accepts the next world', () => {
    const installPath = createInstallPath()
    writeObservedWorldSeed(installPath, 'master', {
      seed: '1608382646',
      at: '2026-09-19T10:00:00.000Z',
      sessionId: 'SESSION_A',
    })

    markObservedWorldSeedStale(installPath, 'master')
    // 值留着（用于比对世界会话），但已被标记为不可信
    assert.deepEqual(readObservedWorldSeed(installPath, 'master'), {
      seed: '1608382646',
      at: '2026-09-19T10:00:00.000Z',
      sessionId: 'SESSION_A',
      stale: true,
    })

    writeObservedWorldSeed(installPath, 'master', {
      seed: '548421693',
      at: '2026-09-19T11:00:00.000Z',
      sessionId: 'SESSION_B',
    })
    const refreshed = readObservedWorldSeed(installPath, 'master')
    assert.equal(refreshed?.seed, '548421693')
    assert.equal(refreshed?.stale, undefined)
  })

  it('does nothing when there is no record to invalidate', () => {
    const installPath = createInstallPath()
    markObservedWorldSeedStale(installPath, 'caves')
    assert.equal(readObservedWorldSeed(installPath, 'caves'), null)
  })

  it('ignores malformed observed seeds so a hand-edited file cannot fake a seed', () => {
    const installPath = createInstallPath()
    const metaPath = path.join(
      installPath,
      'klei-storage',
      'DoNotStarveTogether',
      'Cluster_1',
      '.bsp-panel-config.json',
    )
    fs.mkdirSync(path.dirname(metaPath), { recursive: true })
    fs.writeFileSync(metaPath, JSON.stringify({
      observedWorldSeeds: {
        master: { seed: 'abc', at: '2026-09-19T10:00:00.000Z' },
        caves: { seed: '548421693', at: '2026-09-19T10:00:00.000Z' },
      },
    }))

    assert.equal(readObservedWorldSeed(installPath, 'master'), null)
    assert.deepEqual(readObservedWorldSeed(installPath, 'caves'), {
      seed: '548421693',
      at: '2026-09-19T10:00:00.000Z',
      sessionId: null,
    })
  })
})
