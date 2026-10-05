import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { DbInstanceMod } from '../../shared/db/index'
import { resolveDstSteamWorkshopModDir } from '../../infra/game-adapter/dst/constants'
import { resolveClusterPaths } from '../../infra/game-adapter/dst/cluster-service'
import { resolveDstUgcModDir } from '../../infra/game-adapter/dst/ugc-mod-install'
import {
  resetModFileSyncDbHooksForTest,
  setModFileSyncDbHooksForTest,
  syncInstanceModFilesFromDb,
} from './mod-file-sync-service'

const tempDirs: string[] = []

function createMockMod(partial: Partial<DbInstanceMod> & Pick<DbInstanceMod, 'workshopId'>): DbInstanceMod {
  const now = new Date().toISOString()
  return {
    id: partial.id ?? `mod-${partial.workshopId}`,
    instanceId: partial.instanceId ?? 'inst-1',
    workshopId: partial.workshopId,
    name: partial.name ?? `Mod ${partial.workshopId}`,
    previewImage: partial.previewImage ?? null,
    enabled: partial.enabled ?? true,
    loadOrder: partial.loadOrder ?? 0,
    version: partial.version ?? null,
    installStatus: partial.installStatus ?? 'ready',
    installError: partial.installError ?? null,
    localUpdatedAt: partial.localUpdatedAt ?? null,
    remoteUpdatedAt: partial.remoteUpdatedAt ?? null,
    updateCheckedAt: partial.updateCheckedAt ?? null,
    loadedCopyStale: partial.loadedCopyStale ?? false,
    config: partial.config ?? null,
    retryCount: partial.retryCount ?? 0,
    nextRetryAt: partial.nextRetryAt ?? null,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  }
}

/** 模拟 SteamCMD 下载产物：steamapps/workshop/content/<appid>/<id>/modinfo.lua */
function writeWorkshopSource(installPath: string, workshopId: string) {
  const modDir = resolveDstSteamWorkshopModDir(installPath, workshopId)
  fs.mkdirSync(modDir, { recursive: true })
  fs.writeFileSync(path.join(modDir, 'modinfo.lua'), 'name = "Test Mod"\n')
}

/** 模拟损坏的 legacy 包：DST 落位时会解压失败 */
function writeCorruptLegacySource(installPath: string, workshopId: string) {
  const modDir = resolveDstSteamWorkshopModDir(installPath, workshopId)
  fs.mkdirSync(modDir, { recursive: true })
  fs.writeFileSync(path.join(modDir, '123_legacy.bin'), Buffer.from('not a zip'))
}

afterEach(() => {
  resetModFileSyncDbHooksForTest()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('syncInstanceModFilesFromDb', () => {
  it('writes lua setup only for ready mods', async () => {
    const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-mod-sync-'))
    tempDirs.push(installPath)
    setModFileSyncDbHooksForTest({
      listReadyInstanceMods: async () => [
        createMockMod({ workshopId: '111', enabled: true, loadOrder: 0, installStatus: 'ready' }),
      ],
    })

    await syncInstanceModFilesFromDb('inst-1', installPath)

    const setupPath = path.join(installPath, 'mods', 'dedicated_server_mods_setup.lua')
    assert.equal(fs.existsSync(setupPath), true)
    const content = fs.readFileSync(setupPath, 'utf8')
    assert.match(content, /111/)
    assert.doesNotMatch(content, /222/)
  })

  it('skips when install path is missing', async () => {
    let called = false
    setModFileSyncDbHooksForTest({
      listReadyInstanceMods: async () => {
        called = true
        return []
      },
    })
    await syncInstanceModFilesFromDb('inst-1', '/nonexistent/path')
    assert.equal(called, false)
  })

  it('writes configuration_options into modoverrides.lua and keeps plain mods intact', async () => {
    const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-mod-sync-'))
    tempDirs.push(installPath)
    setModFileSyncDbHooksForTest({
      listReadyInstanceMods: async () => [
        createMockMod({ workshopId: '111', enabled: true, loadOrder: 0, config: JSON.stringify({ opt_a: 'x', opt_b: 2 }) }),
        createMockMod({ workshopId: '222', enabled: false, loadOrder: 1 }),
      ],
    })

    await syncInstanceModFilesFromDb('inst-1', installPath)

    const { clusterRoot } = resolveClusterPaths(installPath)
    const overridesContent = fs.readFileSync(path.join(clusterRoot, 'Master', 'modoverrides.lua'), 'utf8')
    assert.match(overridesContent, /\["workshop-111"\]=\{ enabled=true, configuration_options=\{ opt_a="x", opt_b=2 \} \}/)
    assert.match(overridesContent, /\["workshop-222"\]=\{ enabled=false \}/)
  })

  it('places downloaded mod files into ugc_mods before writing lua', async () => {
    const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-mod-sync-'))
    tempDirs.push(installPath)
    writeWorkshopSource(installPath, '111')
    setModFileSyncDbHooksForTest({
      listReadyInstanceMods: async () => [createMockMod({ workshopId: '111' })],
    })

    await syncInstanceModFilesFromDb('inst-1', installPath)

    const ugcModDir = resolveDstUgcModDir(installPath, 'Master', '111')
    assert.equal(fs.existsSync(path.join(ugcModDir, 'modinfo.lua')), true)
    assert.equal(fs.existsSync(path.join(installPath, 'mods', 'dedicated_server_mods_setup.lua')), true)
  })

  it('still writes lua files when a mod cannot be placed into ugc_mods', async () => {
    const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-mod-sync-'))
    tempDirs.push(installPath)
    writeCorruptLegacySource(installPath, '333')
    setModFileSyncDbHooksForTest({
      listReadyInstanceMods: async () => [createMockMod({ workshopId: '333' })],
    })

    await syncInstanceModFilesFromDb('inst-1', installPath)

    assert.equal(fs.existsSync(resolveDstUgcModDir(installPath, 'Master', '333')), false)
    const { clusterRoot } = resolveClusterPaths(installPath)
    const overridesContent = fs.readFileSync(path.join(clusterRoot, 'Master', 'modoverrides.lua'), 'utf8')
    assert.match(overridesContent, /\["workshop-333"\]=\{ enabled=true \}/)
  })
})
