import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { DbInstanceMod } from '../../shared/db/index'
import type { WorkshopModMetadata } from '../../infra/game-adapter/dst/steam-workshop'
import { resolveWorkshopManifestPath } from '../../infra/game-adapter/dst/workshop-manifest'
import {
  checkInstanceModUpdates,
  resetModUpdateDbHooksForTest,
  resolveModUpdateStatus,
  resolveStoredModUpdateStatus,
  setModUpdateDbHooksForTest,
} from './mod-update-service'

const INSTANCE_ID = 'inst-mod-update'
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-mod-update-'))
  tempDirs.push(dir)
  return dir
}

/** 写入 SteamCMD 清单：timeupdated 就是本机内容对应的工坊版本时间 */
function writeWorkshopManifest(installPath: string, entries: Array<{ workshopId: string, timeupdated: number }>) {
  const manifestPath = resolveWorkshopManifestPath(installPath)
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  const rows = entries.flatMap(entry => [
    `\t\t"${entry.workshopId}"`,
    '\t\t{',
    `\t\t\t"size"\t\t"1024"`,
    `\t\t\t"timeupdated"\t\t"${entry.timeupdated}"`,
    `\t\t\t"manifest"\t\t"99"`,
    '\t\t}',
  ])
  fs.writeFileSync(manifestPath, ['"AppWorkshop"', '{', '\t"WorkshopItemsInstalled"', '\t{', ...rows, '\t}', '}'].join('\n'))
}

function resolveDownloadedModDir(installPath: string, workshopId: string): string {
  return path.join(installPath, 'steamapps', 'workshop', 'content', '322330', workshopId)
}

function resolveUgcModDir(installPath: string, workshopId: string, shardFolder = 'Master'): string {
  return path.join(installPath, 'ugc_mods', 'Cluster_1', shardFolder, 'content', '322330', workshopId)
}

/** 写一份内容文件并固定它的 mtime：模拟内容真实的落地时间 */
function writeModContent(dir: string, mtimeIso: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, 'modinfo.lua')
  fs.writeFileSync(filePath, 'return {}')
  const stamp = new Date(mtimeIso)
  fs.utimesSync(filePath, stamp, stamp)
}

function createHarness(mods: DbInstanceMod[], metadata: Map<string, WorkshopModMetadata>, options?: { ok?: boolean, message?: string }) {
  const patches: Array<{ workshopId: string, patch: Record<string, unknown> }> = []
  let fetchCalls = 0
  setModUpdateDbHooksForTest({
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
    fetchWorkshopModMetadata: async () => {
      fetchCalls += 1
      return {
        ok: options?.ok ?? true,
        message: options?.message,
        items: metadata,
      }
    },
  })
  return { patches, fetchCount: () => fetchCalls }
}

afterEach(() => {
  resetModUpdateDbHooksForTest()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveModUpdateStatus', () => {
  it('compares version times and never guesses when one side is missing', () => {
    assert.equal(
      resolveModUpdateStatus('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
      'outdated',
    )
    assert.equal(
      resolveModUpdateStatus('2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
      'up_to_date',
    )
    assert.equal(
      resolveModUpdateStatus('2026-01-03T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
      'up_to_date',
    )
    assert.equal(resolveModUpdateStatus(null, '2026-01-02T00:00:00.000Z'), 'unknown')
    assert.equal(resolveModUpdateStatus('2026-01-02T00:00:00.000Z', null), 'unknown')
    assert.equal(resolveModUpdateStatus(null, null), 'unknown')
    assert.equal(resolveModUpdateStatus('not-a-date', '2026-01-02T00:00:00.000Z'), 'unknown')
  })
})

describe('resolveStoredModUpdateStatus', () => {
  it('reports outdated for a stale game-loaded copy even when both times agree', () => {
    const iso = '2026-01-02T00:00:00.000Z'
    // 两个时间戳一模一样时，只看时间会得出「已是最新」；但游戏加载的那份是旧的
    assert.equal(
      resolveStoredModUpdateStatus({ loadedCopyStale: true, localUpdatedAt: iso, remoteUpdatedAt: iso }),
      'outdated',
    )
    assert.equal(
      resolveStoredModUpdateStatus({ loadedCopyStale: false, localUpdatedAt: iso, remoteUpdatedAt: iso }),
      'up_to_date',
    )
    assert.equal(
      resolveStoredModUpdateStatus({ loadedCopyStale: false, localUpdatedAt: null, remoteUpdatedAt: iso }),
      'unknown',
    )
  })
})

describe('checkInstanceModUpdates', () => {
  it('marks a mod outdated when the workshop is newer and records both sides', async () => {
    const installPath = makeInstallPath()
    writeWorkshopManifest(installPath, [{ workshopId: '111', timeupdated: 1_800_000_000 }])
    const mod = createMockMod({ workshopId: '111', name: '采集助手' })
    const harness = createHarness([mod], new Map([
      ['111', {
        title: '采集助手',
        previewImage: 'https://example.com/a.png',
        updatedAt: new Date(1_800_086_400 * 1000).toISOString(),
        fileSize: 2048,
      }],
    ]))

    const outcome = await checkInstanceModUpdates({ instanceId: INSTANCE_ID, installPath, force: true })

    assert.equal(outcome.upstreamOk, true)
    assert.equal(outcome.summary.outdated, 1)
    assert.equal(outcome.items[0]?.updateStatus, 'outdated')
    assert.equal(outcome.items[0]?.localUpdatedAt, new Date(1_800_000_000 * 1000).toISOString())
    assert.equal(outcome.items[0]?.localVersionSource, 'workshop-manifest')
    assert.equal(mod.remoteUpdatedAt, new Date(1_800_086_400 * 1000).toISOString())
    assert.equal(mod.localUpdatedAt, new Date(1_800_000_000 * 1000).toISOString())
    assert.ok(mod.updateCheckedAt)
    // 缩略图缺失时顺带补齐
    assert.equal(mod.previewImage, 'https://example.com/a.png')
    assert.equal(harness.patches.length, 1)
    // 落位跟得上：陈旧标记必须被显式写成 false，不能留着上次的判定
    assert.equal(harness.patches[0]?.patch.loadedCopyStale, false)
  })

  it('reports an up-to-date mod without touching its name', async () => {
    const installPath = makeInstallPath()
    const versionIso = new Date(1_800_000_000 * 1000).toISOString()
    writeWorkshopManifest(installPath, [{ workshopId: '222', timeupdated: 1_800_000_000 }])
    const mod = createMockMod({ workshopId: '222', name: '本地名称' })
    createHarness([mod], new Map([
      ['222', { title: '本地名称', previewImage: null, updatedAt: versionIso, fileSize: null }],
    ]))

    const outcome = await checkInstanceModUpdates({ instanceId: INSTANCE_ID, installPath, force: true })

    assert.equal(outcome.summary.upToDate, 1)
    assert.equal(outcome.renamed.length, 0)
    assert.equal(mod.name, '本地名称')
  })

  it('repairs a junk mod name from the workshop title', async () => {
    const installPath = makeInstallPath()
    writeWorkshopManifest(installPath, [{ workshopId: '333', timeupdated: 1_800_000_000 }])
    // 导入存档后出现的异常名称，只能靠工坊标题纠正
    const mod = createMockMod({ workshopId: '333', name: 'EmptyNull' })
    createHarness([mod], new Map([
      ['333', {
        title: '真正的 Mod 名称',
        previewImage: null,
        updatedAt: new Date(1_800_000_000 * 1000).toISOString(),
        fileSize: null,
      }],
    ]))

    const outcome = await checkInstanceModUpdates({ instanceId: INSTANCE_ID, installPath, force: true })

    assert.deepEqual(outcome.renamed, [{
      workshopId: '333',
      previousName: 'EmptyNull',
      name: '真正的 Mod 名称',
    }])
    assert.equal(mod.name, '真正的 Mod 名称')
  })

  it('keeps unknown when the local manifest has no entry for the mod', async () => {
    const installPath = makeInstallPath()
    writeWorkshopManifest(installPath, [{ workshopId: '444', timeupdated: 1_800_000_000 }])
    const mod = createMockMod({ workshopId: '555', name: '未下载的 Mod', installStatus: 'pending' })
    createHarness([mod], new Map([
      ['555', {
        title: '未下载的 Mod',
        previewImage: null,
        updatedAt: new Date(1_800_000_000 * 1000).toISOString(),
        fileSize: null,
      }],
    ]))

    const outcome = await checkInstanceModUpdates({ instanceId: INSTANCE_ID, installPath, force: true })

    assert.equal(outcome.items[0]?.updateStatus, 'unknown')
    assert.match(outcome.items[0]?.reason ?? '', /尚未下载完成/)
    assert.equal(mod.localUpdatedAt, null)
  })

  it('judges the version from the content file time when the manifest has no entry', async () => {
    const installPath = makeInstallPath()
    writeWorkshopManifest(installPath, [{ workshopId: '900', timeupdated: 1_800_000_000 }])
    const mod = createMockMod({ workshopId: '901', name: '旧版本 Mod' })
    // 内容落地时间早于工坊当前版本时间：本机确实是旧版本，必须报「有新版本」
    writeModContent(resolveDownloadedModDir(installPath, '901'), '2026-01-01T00:00:00.000Z')
    createHarness([mod], new Map([
      ['901', {
        title: '旧版本 Mod',
        previewImage: null,
        updatedAt: '2026-05-01T00:00:00.000Z',
        fileSize: null,
      }],
    ]))

    const outcome = await checkInstanceModUpdates({ instanceId: INSTANCE_ID, installPath, force: true })

    assert.equal(outcome.summary.outdated, 1)
    assert.equal(outcome.summary.upToDate, 0)
    assert.equal(outcome.items[0]?.localVersionSource, 'content-mtime')
    assert.equal(outcome.items[0]?.localUpdatedAt, '2026-01-01T00:00:00.000Z')
    assert.equal(mod.localUpdatedAt, '2026-01-01T00:00:00.000Z')
  })

  it('never lets a recorded timestamp pass for the local version', async () => {
    const installPath = makeInstallPath()
    // 面板「记录这份内容」的时刻：历史实现会把它写进 local_updated_at，
    // 而它必然晚于当时的工坊版本，拿来比较只会得到「已是最新」
    const recordedIso = '2026-06-01T00:00:00.000Z'
    const mod = createMockMod({ workshopId: '902', localUpdatedAt: recordedIso })
    createHarness([mod], new Map([
      ['902', {
        title: '没有内容凭据的 Mod',
        previewImage: null,
        updatedAt: '2026-05-01T00:00:00.000Z',
        fileSize: null,
      }],
    ]))

    const outcome = await checkInstanceModUpdates({ instanceId: INSTANCE_ID, installPath, force: true })

    assert.equal(outcome.items[0]?.updateStatus, 'unknown')
    assert.equal(outcome.summary.upToDate, 0)
    assert.equal(outcome.items[0]?.localVersionSource, null)
    assert.equal(mod.localUpdatedAt, null)
    assert.match(outcome.items[0]?.reason ?? '', /找不到该 Mod 的版本记录/)
  })

  it('flags a stale ugc_mods copy as outdated even when the downloaded content is current', async () => {
    const installPath = makeInstallPath()
    writeWorkshopManifest(installPath, [{ workshopId: '903', timeupdated: 1_800_000_000 }])
    const mod = createMockMod({ workshopId: '903', name: '落位没跟上的 Mod' })
    writeModContent(resolveDownloadedModDir(installPath, '903'), '2026-05-06T07:08:09.000Z')
    // 落位发生在下载之前：下载目录是新的，游戏读到的还是旧的
    writeModContent(resolveUgcModDir(installPath, '903'), '2026-04-01T00:00:00.000Z')
    const harness = createHarness([mod], new Map([
      ['903', {
        title: '落位没跟上的 Mod',
        previewImage: null,
        updatedAt: new Date(1_800_000_000 * 1000).toISOString(),
        fileSize: null,
      }],
    ]))

    const outcome = await checkInstanceModUpdates({ instanceId: INSTANCE_ID, installPath, force: true })

    assert.equal(outcome.items[0]?.updateStatus, 'outdated')
    assert.match(outcome.items[0]?.reason ?? '', /游戏实际加载的 Mod 文件比已下载内容旧/)
    // 必须落库：列表按库里的状态渲染，只放进本次响应就会出现「说有新版本却无从更新」
    assert.equal(harness.patches[0]?.patch.loadedCopyStale, true)
    assert.equal(resolveStoredModUpdateStatus(mod), 'outdated')
  })

  it('keeps the previous state when the workshop cannot be reached', async () => {
    const installPath = makeInstallPath()
    const staleIso = new Date(1_700_000_000 * 1000).toISOString()
    const mod = createMockMod({
      workshopId: '666',
      localUpdatedAt: staleIso,
      remoteUpdatedAt: staleIso,
      updateCheckedAt: staleIso,
    })
    createHarness([mod], new Map(), { ok: false, message: '无法连接 Steam 创意工坊' })

    const outcome = await checkInstanceModUpdates({ instanceId: INSTANCE_ID, installPath, force: true })

    assert.equal(outcome.upstreamOk, false)
    assert.equal(outcome.metadataResolved, 0)
    assert.match(outcome.message ?? '', /Steam/)
    // 状态与检查时间都不被污染：不把「不知道」写成「已是最新」
    assert.equal(mod.remoteUpdatedAt, staleIso)
    assert.equal(mod.updateCheckedAt, staleIso)
    assert.equal(outcome.items[0]?.updateStatus, 'up_to_date')
    // 沿用库中旧结论时不改判，也不给「无法判定」的理由：工坊侧的原因在 message 里
    assert.equal(outcome.items[0]?.reason, null)
  })

  it('explains the unjudged reason for a mod that was never judged', async () => {
    const installPath = makeInstallPath()
    const mod = createMockMod({ workshopId: '667', localUpdatedAt: null, remoteUpdatedAt: null })
    createHarness([mod], new Map(), { ok: false, message: '无法连接 Steam 创意工坊' })

    const outcome = await checkInstanceModUpdates({ instanceId: INSTANCE_ID, installPath, force: true })

    assert.equal(outcome.items[0]?.updateStatus, 'unknown')
    assert.match(outcome.items[0]?.reason ?? '', /未能从创意工坊取到/)
  })

  it('reports a mod that no longer exists on the workshop as unknown', async () => {
    const installPath = makeInstallPath()
    writeWorkshopManifest(installPath, [{ workshopId: '777', timeupdated: 1_800_000_000 }])
    const mod = createMockMod({ workshopId: '777' })
    createHarness([mod], new Map([
      ['777', { title: null, previewImage: null, updatedAt: null, fileSize: null }],
    ]))

    const outcome = await checkInstanceModUpdates({ instanceId: INSTANCE_ID, installPath, force: true })

    assert.equal(outcome.items[0]?.updateStatus, 'unknown')
    assert.match(outcome.items[0]?.reason ?? '', /已下架/)
  })

  it('returns stored state without asking Steam when the last check is fresh', async () => {
    const installPath = makeInstallPath()
    const freshIso = new Date().toISOString()
    const mod = createMockMod({
      workshopId: '888',
      localUpdatedAt: freshIso,
      remoteUpdatedAt: freshIso,
      updateCheckedAt: freshIso,
    })
    const harness = createHarness([mod], new Map())

    const outcome = await checkInstanceModUpdates({ instanceId: INSTANCE_ID, installPath })

    assert.equal(harness.fetchCount(), 0)
    assert.equal(outcome.summary.upToDate, 1)
    assert.equal(outcome.metadataResolved, 0)
  })

  it('returns an empty result for an instance without mods', async () => {
    const installPath = makeInstallPath()
    const harness = createHarness([], new Map())

    const outcome = await checkInstanceModUpdates({ instanceId: INSTANCE_ID, installPath, force: true })

    assert.deepEqual(outcome.summary, { total: 0, outdated: 0, upToDate: 0, unknown: 0 })
    assert.equal(harness.fetchCount(), 0)
  })
})
