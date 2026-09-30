import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { DbInstanceMod } from '../../shared/db/index'
import { resolveDstSteamWorkshopModDir } from '../../infra/game-adapter/dst/constants'
import { resolveDstUgcModDir } from '../../infra/game-adapter/dst/ugc-mod-install'
import {
  MISSING_MOD_CONTENT_ERROR,
  reconcileInstanceModReadiness,
  resetModReadinessDbHooksForTest,
  setModReadinessDbHooksForTest,
} from './mod-readiness-service'

const INSTANCE_ID = 'inst-1'
const tempDirs: string[] = []

function createMockMod(partial: Partial<DbInstanceMod> & Pick<DbInstanceMod, 'workshopId'>): DbInstanceMod {
  const now = new Date().toISOString()
  return {
    id: partial.id ?? `mod-${partial.workshopId}`,
    instanceId: partial.instanceId ?? INSTANCE_ID,
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

function makeInstallPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-mod-readiness-'))
  tempDirs.push(dir)
  return dir
}

/** 模拟 SteamCMD 下载产物：steamapps/workshop/content/<appid>/<id>/modinfo.lua */
function writeWorkshopSource(installPath: string, workshopId: string, name = 'Test Mod') {
  const modDir = resolveDstSteamWorkshopModDir(installPath, workshopId)
  fs.mkdirSync(modDir, { recursive: true })
  fs.writeFileSync(path.join(modDir, 'modinfo.lua'), `return { name = "${name}" }\n`)
}

/** 模拟已落位到 DST 加载目录：ugc_mods/<cluster>/<shard>/content/<appid>/<id>/modinfo.lua */
function writeUgcMod(installPath: string, shard: 'Master' | 'Caves', workshopId: string, name = 'Test Mod') {
  const modDir = resolveDstUgcModDir(installPath, shard, workshopId)
  fs.mkdirSync(modDir, { recursive: true })
  fs.writeFileSync(path.join(modDir, 'modinfo.lua'), `return { name = "${name}" }\n`)
}

/** 模拟损坏的 legacy 包：落位解压时必然失败 */
function writeCorruptLegacySource(installPath: string, workshopId: string) {
  const modDir = resolveDstSteamWorkshopModDir(installPath, workshopId)
  fs.mkdirSync(modDir, { recursive: true })
  fs.writeFileSync(path.join(modDir, '123_legacy.bin'), Buffer.from('not a zip'))
}

function createHarness(mods: DbInstanceMod[]) {
  const patches: Array<{ workshopId: string, patch: Record<string, unknown> }> = []
  setModReadinessDbHooksForTest({
    listInstanceMods: async () => mods,
    updateInstanceModByWorkshopId: async (_instanceId, workshopId, patch) => {
      patches.push({ workshopId, patch })
      const target = mods.find(mod => mod.workshopId === workshopId)
      if (!target) {
        return undefined
      }
      Object.assign(target, patch)
      return target
    },
  })
  return { patches }
}

afterEach(() => {
  resetModReadinessDbHooksForTest()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('reconcileInstanceModReadiness', () => {
  it('demotes a ready mod whose workshop content is missing', async () => {
    const installPath = makeInstallPath()
    const mod = createMockMod({ workshopId: '111' })
    const { patches } = createHarness([mod])

    const result = await reconcileInstanceModReadiness({ instanceId: INSTANCE_ID, installPath })

    assert.deepEqual(result.demotedToPending, ['111'])
    assert.equal(mod.installStatus, 'pending')
    assert.equal(mod.installError, MISSING_MOD_CONTENT_ERROR)
    assert.deepEqual(patches, [{
      workshopId: '111',
      patch: { installStatus: 'pending', installError: MISSING_MOD_CONTENT_ERROR },
    }])
  })

  it('keeps a ready mod untouched when its content is already in ugc_mods', async () => {
    const installPath = makeInstallPath()
    writeUgcMod(installPath, 'Master', '222', '真实名称')
    const mod = createMockMod({ workshopId: '222', name: '真实名称' })
    const { patches } = createHarness([mod])

    const result = await reconcileInstanceModReadiness({ instanceId: INSTANCE_ID, installPath })

    assert.deepEqual(result, { demotedToPending: [], markedFailed: [], renamed: [] })
    assert.equal(mod.installStatus, 'ready')
    assert.equal(patches.length, 0)
  })

  it('relocates downloaded content into ugc_mods and stays ready', async () => {
    const installPath = makeInstallPath()
    writeWorkshopSource(installPath, '333', '已下载的 Mod')
    const mod = createMockMod({ workshopId: '333', name: '已下载的 Mod' })
    const { patches } = createHarness([mod])

    const result = await reconcileInstanceModReadiness({
      instanceId: INSTANCE_ID,
      installPath,
      relocate: true,
    })

    assert.deepEqual(result.markedFailed, [])
    assert.equal(mod.installStatus, 'ready')
    assert.equal(patches.length, 0)
    assert.ok(fs.existsSync(path.join(resolveDstUgcModDir(installPath, 'Master', '333'), 'modinfo.lua')))
  })

  it('marks a mod as failed when a corrupt legacy package cannot be relocated', async () => {
    const installPath = makeInstallPath()
    writeCorruptLegacySource(installPath, '444')
    const mod = createMockMod({ workshopId: '444' })
    const { patches } = createHarness([mod])

    const result = await reconcileInstanceModReadiness({
      instanceId: INSTANCE_ID,
      installPath,
      relocate: true,
    })

    assert.equal(result.markedFailed.length, 1)
    assert.equal(result.markedFailed[0]!.workshopId, '444')
    assert.ok(result.markedFailed[0]!.error)
    assert.deepEqual(result.demotedToPending, [])
    assert.equal(mod.installStatus, 'failed')
    assert.ok(mod.installError)
    assert.equal(patches.length, 1)
  })

  it('fills a placeholder name from modinfo.lua', async () => {
    const installPath = makeInstallPath()
    writeUgcMod(installPath, 'Master', '555', 'Gem Core')
    const mod = createMockMod({ workshopId: '555', name: 'workshop-555' })
    createHarness([mod])

    const result = await reconcileInstanceModReadiness({ instanceId: INSTANCE_ID, installPath })

    assert.deepEqual(result.renamed, [{ workshopId: '555', name: 'Gem Core' }])
    assert.equal(mod.name, 'Gem Core')
  })

  it('is idempotent across repeated runs', async () => {
    const installPath = makeInstallPath()
    const mod = createMockMod({ workshopId: '666' })
    const { patches } = createHarness([mod])

    await reconcileInstanceModReadiness({ instanceId: INSTANCE_ID, installPath })
    const second = await reconcileInstanceModReadiness({ instanceId: INSTANCE_ID, installPath })

    assert.deepEqual(second, { demotedToPending: [], markedFailed: [], renamed: [] })
    assert.equal(patches.length, 1)
  })

  it('ignores mods that are not ready', async () => {
    const installPath = makeInstallPath()
    const mod = createMockMod({ workshopId: '777', installStatus: 'pending' })
    const { patches } = createHarness([mod])

    const result = await reconcileInstanceModReadiness({ instanceId: INSTANCE_ID, installPath })

    assert.deepEqual(result, { demotedToPending: [], markedFailed: [], renamed: [] })
    assert.equal(patches.length, 0)
  })
})
