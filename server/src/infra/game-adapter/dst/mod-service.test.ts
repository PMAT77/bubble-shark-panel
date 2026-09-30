import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { readModDependencies, writeInstanceModFiles, writeModDependencyMap } from './mod-service'
import { resolveDstSteamWorkshopModDir } from './constants'
import { writeWorldSeed } from './panel-config-meta'
import { GSH_WORLD_SEED_MOD_ID, resolveWorldSeedModDir, toWorldSeedModName } from './world-seed'

const tempDirs: string[] = []

function createInstallPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-mod-service-'))
  tempDirs.push(dir)
  return dir
}

function resolveClusterRoot(installPath: string) {
  return path.join(installPath, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('mod-service', () => {
  it('writes modoverrides.lua for both master and caves when caves folder is missing', () => {
    const installPath = createInstallPath()
    writeInstanceModFiles(installPath, [
      { workshopId: '111', enabled: true, loadOrder: 1 },
      { workshopId: '222', enabled: false, loadOrder: 0 },
    ])

    const clusterRoot = path.join(installPath, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1')
    const setupPath = path.join(installPath, 'mods', 'dedicated_server_mods_setup.lua')
    const clusterSetupPath = path.join(clusterRoot, 'dedicated_server_mods_setup.lua')
    const masterOverridesPath = path.join(clusterRoot, 'Master', 'modoverrides.lua')
    const cavesOverridesPath = path.join(clusterRoot, 'Caves', 'modoverrides.lua')

    assert.equal(fs.existsSync(setupPath), true)
    assert.equal(fs.existsSync(clusterSetupPath), true)
    assert.equal(fs.existsSync(masterOverridesPath), true)
    assert.equal(fs.existsSync(cavesOverridesPath), true)

    const setupContent = fs.readFileSync(setupPath, 'utf8')
    const masterOverridesContent = fs.readFileSync(masterOverridesPath, 'utf8')
    const cavesOverridesContent = fs.readFileSync(cavesOverridesPath, 'utf8')

    assert.match(setupContent, /ServerModSetup\("111"\)/)
    // 被禁用的 Mod 不进 setup lua：这份清单决定 DST 启动时自己去工坊拉什么，
    // 列进去等于让游戏绕开面板的下载队列（国内网络下就是卡启动）
    assert.equal(setupContent.includes('ServerModSetup("222")'), false)
    assert.match(masterOverridesContent, /\["workshop-111"\]=\{ enabled=true \}/)
    assert.match(masterOverridesContent, /\["workshop-222"\]=\{ enabled=false \}/)
    assert.equal(cavesOverridesContent, masterOverridesContent)
  })

  it('enables the built-in world seed mod only on shards that have a seed', () => {
    const installPath = createInstallPath()
    writeWorldSeed(installPath, 'master', '1608382646')

    writeInstanceModFiles(installPath, [])

    const clusterRoot = resolveClusterRoot(installPath)
    const masterOverrides = fs.readFileSync(path.join(clusterRoot, 'Master', 'modoverrides.lua'), 'utf8')
    const cavesOverrides = fs.readFileSync(path.join(clusterRoot, 'Caves', 'modoverrides.lua'), 'utf8')
    assert.equal(masterOverrides.includes(`["${toWorldSeedModName()}"]={ enabled=true }`), true)
    // 洞穴没有种子：既不落位文件，也不在它的 Mod 清单里启用
    assert.equal(cavesOverrides.includes(toWorldSeedModName()), false)
    assert.equal(fs.existsSync(path.join(resolveWorldSeedModDir(installPath, 'Master'), 'modworldgenmain.lua')), true)
    assert.equal(fs.existsSync(resolveWorldSeedModDir(installPath, 'Caves')), false)
    // 内置 Mod 的文件由面板自己落位，不能进 SteamCMD 的拉取清单（工坊上没有这个 ID）
    const setupContent = fs.readFileSync(path.join(installPath, 'mods', 'dedicated_server_mods_setup.lua'), 'utf8')
    assert.equal(setupContent.includes(GSH_WORLD_SEED_MOD_ID), false)
  })

  it('keeps modoverrides free of the built-in mod when no seed is set', () => {
    const installPath = createInstallPath()
    writeInstanceModFiles(installPath, [{ workshopId: '111', enabled: true, loadOrder: 1 }])

    const masterOverrides = fs.readFileSync(path.join(resolveClusterRoot(installPath), 'Master', 'modoverrides.lua'), 'utf8')
    assert.equal(masterOverrides.includes(GSH_WORLD_SEED_MOD_ID), false)
    assert.equal(fs.existsSync(resolveWorldSeedModDir(installPath, 'Master')), false)
  })

  it('reads mod dependencies from the panel record and from modinfo.lua', () => {
    const installPath = createInstallPath()
    // 面板记录的依赖（订阅时写入）
    writeModDependencyMap(installPath, { '1000': ['2000'] })
    // 已下载内容自带的依赖：workshop- 前缀要归一化成裸 ID
    const modDir = resolveDstSteamWorkshopModDir(installPath, '1000')
    fs.mkdirSync(modDir, { recursive: true })
    fs.writeFileSync(path.join(modDir, 'modinfo.lua'), [
      'name = "Dep Mod"',
      'dependencies = { "workshop-3000", "4000" }',
    ].join('\n'))

    assert.deepEqual(readModDependencies(installPath, '1000'), ['2000', '3000', '4000'])
    // 内容缺失就没有 modinfo.lua 可读，此时不做猜测
    assert.deepEqual(readModDependencies(installPath, '9999'), [])
  })
})
