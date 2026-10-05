import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { DST_CLUSTER_NAME, DST_CONF_DIR, DST_STORAGE_DIR, resolveDstSteamWorkshopModDir } from './constants'
import {
  ensureDstLegacyModLinks,
  ensureDstUgcModLayout,
  isDstUgcModReady,
  removeDstLegacyModLinks,
  resolveDstLegacyModDir,
  resolveDstUgcModDir,
  resolveDstUgcShardFolders,
  resolveDstWorkshopModSource,
} from './ugc-mod-install'

const tempDirs: string[] = []

function createInstallPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-ugc-mod-'))
  tempDirs.push(dir)
  return dir
}

/** 模拟新式创意工坊下载：steamapps/workshop/content/<appid>/<id>/ 内含 modinfo.lua */
function writeSteamappsSource(installPath: string, workshopId: string) {
  const modDir = resolveDstSteamWorkshopModDir(installPath, workshopId)
  fs.mkdirSync(modDir, { recursive: true })
  fs.writeFileSync(path.join(modDir, 'modinfo.lua'), `name = "Mod ${workshopId}"\n`)
  fs.writeFileSync(path.join(modDir, 'modmain.lua'), '-- main\n')
  return modDir
}

/** 模拟 legacy 创意工坊下载：目录里只有一个 *_legacy.bin（实为标准 zip） */
function writeLegacySource(installPath: string, workshopId: string, fileName = '1665728219799633209_legacy.bin') {
  const modDir = resolveDstSteamWorkshopModDir(installPath, workshopId)
  fs.mkdirSync(modDir, { recursive: true })
  const archive = zipSync({
    'modinfo.lua': strToU8('name = "Legacy Mod"\n'),
    'modmain.lua': strToU8('-- legacy main\n'),
  })
  const archivePath = path.join(modDir, fileName)
  fs.writeFileSync(archivePath, Buffer.from(archive))
  return archivePath
}

function writeCavesShardConfig(installPath: string) {
  const cavesDir = path.join(installPath, DST_STORAGE_DIR, DST_CONF_DIR, DST_CLUSTER_NAME, 'Caves')
  fs.mkdirSync(cavesDir, { recursive: true })
  fs.writeFileSync(path.join(cavesDir, 'server.ini'), '[SHARD]\n')
}

/** 落位与接入两类临时产物都不许有残留：ugc_mods 下与 mods/ 下各扫一遍 */
function listTempResidue(installPath: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) {
      return
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (full.includes('.tmp-') || full.includes('.link-')) {
        found.push(full)
        continue
      }
      if (entry.isDirectory()) {
        walk(full)
      }
    }
  }
  walk(path.join(installPath, 'ugc_mods'))
  walk(path.join(installPath, 'mods'))
  return found
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveDstUgcShardFolders', () => {
  it('returns master only when caves is not configured', () => {
    const installPath = createInstallPath()
    assert.deepEqual(resolveDstUgcShardFolders(installPath), ['Master'])
  })

  it('returns both shards when caves server.ini exists', () => {
    const installPath = createInstallPath()
    writeCavesShardConfig(installPath)
    assert.deepEqual(resolveDstUgcShardFolders(installPath), ['Master', 'Caves'])
  })
})

describe('resolveDstWorkshopModSource', () => {
  it('prefers the extracted directory over the legacy archive', () => {
    const installPath = createInstallPath()
    writeSteamappsSource(installPath, '111')
    const source = resolveDstWorkshopModSource(installPath, '111')
    assert.equal(source?.kind, 'dir')
  })

  it('falls back to the legacy archive when only *_legacy.bin exists', () => {
    const installPath = createInstallPath()
    const archivePath = writeLegacySource(installPath, '501385076')
    const source = resolveDstWorkshopModSource(installPath, '501385076')
    assert.equal(source?.kind, 'legacy')
    assert.equal(source?.kind === 'legacy' ? source.archivePath : null, archivePath)
  })

  it('falls back to the legacy mods/workshop-<id> layout', () => {
    const installPath = createInstallPath()
    const legacyDir = path.join(installPath, 'mods', 'workshop-222')
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, 'modinfo.lua'), 'name = "Legacy Dir"\n')
    assert.equal(resolveDstWorkshopModSource(installPath, '222')?.kind, 'dir')
  })

  it('returns null when nothing was downloaded', () => {
    const installPath = createInstallPath()
    assert.equal(resolveDstWorkshopModSource(installPath, '333'), null)
  })
})

describe('ensureDstUgcModLayout', () => {
  it('copies an extracted workshop mod into ugc_mods master content', async () => {
    const installPath = createInstallPath()
    writeSteamappsSource(installPath, '3793502052')

    const outcomes = await ensureDstUgcModLayout(installPath, ['3793502052'])

    assert.deepEqual(outcomes, [{ workshopId: '3793502052', status: 'installed' }])
    const targetDir = resolveDstUgcModDir(installPath, 'Master', '3793502052')
    assert.equal(fs.existsSync(path.join(targetDir, 'modinfo.lua')), true)
    assert.equal(fs.existsSync(path.join(targetDir, 'modmain.lua')), true)
    assert.equal(isDstUgcModReady(installPath, '3793502052'), true)
    assert.deepEqual(listTempResidue(installPath), [])
  })

  it('unpacks a legacy *_legacy.bin archive into a loadable mod directory', async () => {
    const installPath = createInstallPath()
    const archivePath = writeLegacySource(installPath, '501385076')

    const outcomes = await ensureDstUgcModLayout(installPath, ['501385076'])

    assert.deepEqual(outcomes, [{ workshopId: '501385076', status: 'installed' }])
    const targetDir = resolveDstUgcModDir(installPath, 'Master', '501385076')
    assert.equal(fs.readFileSync(path.join(targetDir, 'modinfo.lua'), 'utf8').includes('Legacy Mod'), true)
    // 目标目录内不应残留未解包的压缩包
    assert.deepEqual(fs.readdirSync(targetDir).filter(name => name.endsWith('_legacy.bin')), [])
    // 源压缩包保持不动
    assert.equal(fs.existsSync(archivePath), true)
    assert.deepEqual(listTempResidue(installPath), [])
  })

  it('is idempotent and skips mods that DST already installed', async () => {
    const installPath = createInstallPath()
    writeSteamappsSource(installPath, '111')
    await ensureDstUgcModLayout(installPath, ['111'])

    const targetDir = resolveDstUgcModDir(installPath, 'Master', '111')
    const markerBefore = fs.statSync(path.join(targetDir, 'modinfo.lua')).mtimeMs

    const outcomes = await ensureDstUgcModLayout(installPath, ['111'])

    assert.deepEqual(outcomes, [{ workshopId: '111', status: 'skipped' }])
    assert.equal(fs.statSync(path.join(targetDir, 'modinfo.lua')).mtimeMs, markerBefore)
  })

  it('rebuilds a broken target directory that has no modinfo.lua', async () => {
    const installPath = createInstallPath()
    writeSteamappsSource(installPath, '444')
    const targetDir = resolveDstUgcModDir(installPath, 'Master', '444')
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(path.join(targetDir, 'leftover.txt'), 'broken')

    const outcomes = await ensureDstUgcModLayout(installPath, ['444'])

    assert.deepEqual(outcomes, [{ workshopId: '444', status: 'installed' }])
    assert.equal(fs.existsSync(path.join(targetDir, 'modinfo.lua')), true)
    assert.equal(fs.existsSync(path.join(targetDir, 'leftover.txt')), false)
  })

  it('replaces already-installed content when refresh is set (update path)', async () => {
    const installPath = createInstallPath()
    const sourceDir = writeSteamappsSource(installPath, '777')
    await ensureDstUgcModLayout(installPath, ['777'])
    const targetDir = resolveDstUgcModDir(installPath, 'Master', '777')
    assert.equal(fs.readFileSync(path.join(targetDir, 'modinfo.lua'), 'utf8').includes('Mod 777'), true)

    // SteamCMD 更新后的新内容 + 上一版残留文件，refresh 必须整目录替换而不是跳过
    fs.writeFileSync(path.join(sourceDir, 'modinfo.lua'), 'name = "Mod 777 v2"\n')
    fs.writeFileSync(path.join(targetDir, 'obsolete.lua'), '-- old\n')

    const outcomes = await ensureDstUgcModLayout(installPath, ['777'], { refresh: true })

    assert.deepEqual(outcomes, [{ workshopId: '777', status: 'installed' }])
    assert.equal(fs.readFileSync(path.join(targetDir, 'modinfo.lua'), 'utf8').includes('Mod 777 v2'), true)
    assert.equal(fs.existsSync(path.join(targetDir, 'obsolete.lua')), false)
    assert.deepEqual(listTempResidue(installPath), [])
  })

  it('installs into both shards when caves is configured', async () => {
    const installPath = createInstallPath()
    writeCavesShardConfig(installPath)
    writeSteamappsSource(installPath, '555')

    await ensureDstUgcModLayout(installPath, ['555'])

    assert.equal(isDstUgcModReady(installPath, '555'), true)
    assert.equal(fs.existsSync(path.join(resolveDstUgcModDir(installPath, 'Caves', '555'), 'modinfo.lua')), true)
  })

  it('reports a failure with the searched paths when nothing was downloaded', async () => {
    const installPath = createInstallPath()

    const outcomes = await ensureDstUgcModLayout(installPath, ['666'])

    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].status, 'failed')
    assert.match(outcomes[0].error ?? '', /未找到已下载的 Mod 文件/)
    assert.match(outcomes[0].error ?? '', /steamapps/)
    assert.equal(isDstUgcModReady(installPath, '666'), false)
  })

  it('rejects a corrupt legacy archive, cleaning up and leaving no target dir', async () => {
    const installPath = createInstallPath()
    const modDir = resolveDstSteamWorkshopModDir(installPath, '777')
    fs.mkdirSync(modDir, { recursive: true })
    fs.writeFileSync(path.join(modDir, '123_legacy.bin'), Buffer.from('not a zip'))

    const outcomes = await ensureDstUgcModLayout(installPath, ['777'])

    assert.equal(outcomes[0].status, 'failed')
    assert.equal(fs.existsSync(resolveDstUgcModDir(installPath, 'Master', '777')), false)
    assert.deepEqual(listTempResidue(installPath), [])
  })

  it('rejects a legacy archive that tries to escape the target directory', async () => {
    const installPath = createInstallPath()
    const modDir = resolveDstSteamWorkshopModDir(installPath, '888')
    fs.mkdirSync(modDir, { recursive: true })
    const evilArchive = zipSync({
      '../escaped.lua': strToU8('-- escaped\n'),
      'modinfo.lua': strToU8('name = "Evil"\n'),
    })
    fs.writeFileSync(path.join(modDir, '999_legacy.bin'), Buffer.from(evilArchive))

    const outcomes = await ensureDstUgcModLayout(installPath, ['888'])

    assert.equal(outcomes[0].status, 'failed')
    assert.equal(fs.existsSync(path.join(installPath, 'escaped.lua')), false)
    assert.equal(fs.existsSync(path.join(path.dirname(installPath), 'escaped.lua')), false)
    assert.deepEqual(listTempResidue(installPath), [])
  })

  it('reports a failure when the install path is missing', async () => {
    const outcomes = await ensureDstUgcModLayout('/nonexistent/bsp-install-path', ['999'])
    assert.equal(outcomes[0].status, 'failed')
    assert.match(outcomes[0].error ?? '', /安装目录不存在/)
  })

  it('ignores blank and duplicated workshop ids', async () => {
    const installPath = createInstallPath()
    writeSteamappsSource(installPath, '1010')

    const outcomes = await ensureDstUgcModLayout(installPath, ['1010', ' 1010 ', ''])

    assert.deepEqual(outcomes, [{ workshopId: '1010', status: 'installed' }])
    assert.deepEqual(await ensureDstUgcModLayout(installPath, []), [])
  })
})

/**
 * 回归：DST 实际从 `mods/workshop-<id>` 加载创意工坊 Mod，只落位到 ugc_mods 时
 * 面板显示全部就绪、游戏里一个 Mod 都没有（实测日志里没有任何 Mod 加载行）。
 */
describe('mods 接入（DST 实际读取的布局）', () => {
  it('落位后同一份内容也出现在 mods/workshop-<id> 下', async () => {
    const installPath = createInstallPath()
    writeSteamappsSource(installPath, '3793502052')

    await ensureDstUgcModLayout(installPath, ['3793502052'])

    const legacyDir = resolveDstLegacyModDir(installPath, '3793502052')
    assert.equal(fs.readFileSync(path.join(legacyDir, 'modinfo.lua'), 'utf8').includes('Mod 3793502052'), true)
    assert.equal(fs.existsSync(path.join(legacyDir, 'modmain.lua')), true)
    // 生产环境（Linux）用相对软链接：同一份内容不占两份磁盘
    if (process.platform !== 'win32') {
      assert.equal(fs.lstatSync(legacyDir).isSymbolicLink(), true)
    }
    assert.deepEqual(listTempResidue(installPath), [])
  })

  it('已就绪（skipped 分支）的 Mod 也会补上接入', async () => {
    const installPath = createInstallPath()
    writeSteamappsSource(installPath, '111')
    await ensureDstUgcModLayout(installPath, ['111'])
    fs.rmSync(resolveDstLegacyModDir(installPath, '111'), { recursive: true, force: true })

    const outcomes = await ensureDstUgcModLayout(installPath, ['111'])

    assert.deepEqual(outcomes, [{ workshopId: '111', status: 'skipped' }])
    assert.equal(fs.existsSync(path.join(resolveDstLegacyModDir(installPath, '111'), 'modinfo.lua')), true)
  })

  it('更新内容后游戏侧读到的是新版本', async () => {
    const installPath = createInstallPath()
    const sourceDir = writeSteamappsSource(installPath, '777')
    await ensureDstUgcModLayout(installPath, ['777'])

    fs.writeFileSync(path.join(sourceDir, 'modinfo.lua'), 'name = "Mod 777 v2"\n')
    await ensureDstUgcModLayout(installPath, ['777'], { refresh: true })

    const content = fs.readFileSync(path.join(resolveDstLegacyModDir(installPath, '777'), 'modinfo.lua'), 'utf8')
    assert.equal(content.includes('Mod 777 v2'), true)
  })

  // Windows 无特权建不了目录软链接，这条路径只能在 Linux 上验
  it('指向别处的接入会被重建为本次落位的内容', { skip: process.platform === 'win32' }, async () => {
    const installPath = createInstallPath()
    writeSteamappsSource(installPath, '1234')
    await ensureDstUgcModLayout(installPath, ['1234'])
    const legacyDir = resolveDstLegacyModDir(installPath, '1234')
    // 人为把接入指到一个内容完整、但不是本次落位结果的位置
    const strayDir = path.join(installPath, 'ugc_mods', 'stray')
    fs.mkdirSync(strayDir, { recursive: true })
    fs.writeFileSync(path.join(strayDir, 'modinfo.lua'), 'name = "Stray"\n')
    removeDstLegacyModLinks(installPath, ['1234'])
    fs.symlinkSync(path.relative(path.dirname(legacyDir), strayDir), legacyDir, 'dir')

    const outcomes = await ensureDstUgcModLayout(installPath, ['1234'])

    assert.deepEqual(outcomes, [{ workshopId: '1234', status: 'skipped' }])
    assert.equal(fs.readFileSync(path.join(legacyDir, 'modinfo.lua'), 'utf8').includes('Mod 1234'), true)
  })

  it('不把面板自己建的接入当成下载来源', async () => {
    const installPath = createInstallPath()
    writeSteamappsSource(installPath, '321')
    await ensureDstUgcModLayout(installPath, ['321'])
    // 下载目录被清理后只剩接入：跟随它等于把 ugc_mods 的内容再复制回 ugc_mods
    fs.rmSync(resolveDstSteamWorkshopModDir(installPath, '321'), { recursive: true, force: true })

    assert.equal(resolveDstWorkshopModSource(installPath, '321'), null)
  })

  it('外部手工放置的 mods/workshop-<id> 仍可作为下载来源', () => {
    const installPath = createInstallPath()
    const externalDir = path.join(installPath, 'mods', 'workshop-888')
    fs.mkdirSync(externalDir, { recursive: true })
    fs.writeFileSync(path.join(externalDir, 'modinfo.lua'), 'name = "外部放置"\n')

    assert.equal(resolveDstWorkshopModSource(installPath, '888')?.kind, 'dir')
  })

  it('内容还没落位时接入失败并给出原因', async () => {
    const installPath = createInstallPath()

    const outcomes = await ensureDstLegacyModLinks(installPath, ['999'])

    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0]?.status, 'failed')
    assert.match(outcomes[0]?.error ?? '', /尚未落位/)
  })

  it('清理只删自己建的接入，不动外部放置的目录', async () => {
    const installPath = createInstallPath()
    writeSteamappsSource(installPath, '555')
    await ensureDstUgcModLayout(installPath, ['555'])
    const externalDir = path.join(installPath, 'mods', 'workshop-666')
    fs.mkdirSync(externalDir, { recursive: true })
    fs.writeFileSync(path.join(externalDir, 'modinfo.lua'), 'name = "外部放置"\n')

    removeDstLegacyModLinks(installPath, ['555', '666'])

    assert.equal(fs.existsSync(resolveDstLegacyModDir(installPath, '555')), false)
    assert.equal(fs.existsSync(externalDir), true)
  })
})
