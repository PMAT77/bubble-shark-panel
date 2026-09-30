import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { resolveDstSteamWorkshopModDir } from '../../infra/game-adapter/dst/mod-download'
import type { WorkshopModMetadata } from '../../infra/game-adapter/dst/steam-workshop'
import { ensureDstUgcModLayout, resolveDstUgcModDir } from '../../infra/game-adapter/dst/ugc-mod-install'
import { resolveWorkshopManifestPath } from '../../infra/game-adapter/dst/workshop-manifest'
import type { DbInstanceMod } from '../../shared/db/index'
import {
  resetModFileSyncDbHooksForTest,
  setModFileSyncDbHooksForTest,
} from './mod-file-sync-service.ts'
import {
  enqueueModDownload,
  enqueueModDownloads,
  getModDownloadQueueSnapshot,
  getModInstallJob,
  MOD_DOWNLOAD_MAX_ATTEMPTS,
  MOD_DOWNLOAD_RETRY_DELAYS_MS,
  pauseModDownloadQueue,
  resetModDownloadDbHooksForTest,
  resetModDownloadExecutorForTest,
  resetModDownloadQueueForTest,
  resetModDownloadRetryDelaysForTest,
  resetModInstallJobsForTest,
  resolveModDownloadQueueState,
  resolveModInstallJob,
  setModDownloadDbHooksForTest,
  setModDownloadExecutorForTest,
  setModDownloadRetryDelaysForTest,
  startModDownloadQueue,
  waitForModDownloadQueueIdle,
  waitForModInstallJob,
} from './mod-download-service.ts'
import { writeModDependencyMap } from '../../infra/game-adapter/dst/mod-service'

const tempDirs: string[] = []
const upsertCalls: Array<Record<string, unknown>> = []
const updateCalls: Array<Record<string, unknown>> = []
let listedMods: DbInstanceMod[] = []
/** 工坊侧「最新版本时间」：null 表示这次取不到（离线/被墙） */
let workshopUpdatedAtIso: string | null = null
let workshopMetadataCalls = 0

function createMockMod(input: Partial<DbInstanceMod> & Pick<DbInstanceMod, 'instanceId' | 'workshopId' | 'name'>): DbInstanceMod {
  const now = new Date().toISOString()
  return {
    id: input.id ?? `mod-${input.workshopId}`,
    previewImage: input.previewImage ?? null,
    enabled: input.enabled ?? false,
    loadOrder: input.loadOrder ?? 0,
    version: input.version ?? null,
    installStatus: input.installStatus ?? 'ready',
    installError: input.installError ?? null,
    localUpdatedAt: input.localUpdatedAt ?? null,
    remoteUpdatedAt: input.remoteUpdatedAt ?? null,
    updateCheckedAt: input.updateCheckedAt ?? null,
    loadedCopyStale: input.loadedCopyStale ?? false,
    config: input.config ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    ...input,
    retryCount: input.retryCount ?? 0,
    nextRetryAt: input.nextRetryAt ?? null,
  }
}

function createInstallPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-mod-download-service-'))
  tempDirs.push(dir)
  return dir
}

function writeWorkshopMod(installPath: string, workshopId: string) {
  const modDir = resolveDstSteamWorkshopModDir(installPath, workshopId)
  fs.mkdirSync(modDir, { recursive: true })
  fs.writeFileSync(path.join(modDir, 'modinfo.lua'), 'name = "Test Mod"\n')
}

/** 写入 SteamCMD 清单条目：本机内容对应的工坊版本时间 */
function writeWorkshopManifest(installPath: string, workshopId: string, timeupdated: number) {
  const manifestPath = resolveWorkshopManifestPath(installPath)
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.writeFileSync(manifestPath, [
    '"AppWorkshop"',
    '{',
    '\t"WorkshopItemsInstalled"',
    '\t{',
    `\t\t"${workshopId}"`,
    '\t\t{',
    `\t\t\t"timeupdated"\t\t"${timeupdated}"`,
    '\t\t}',
    '\t}',
    '}',
  ].join('\n'))
}

function installDbHooks() {
  setModFileSyncDbHooksForTest({
    listReadyInstanceMods: async (instanceId: string) =>
      listedMods.filter(mod => mod.instanceId === instanceId && mod.installStatus === 'ready'),
  })
  setModDownloadDbHooksForTest({
    // 下载完成后面板会核对一次工坊版本时间：测试里不打真实网络
    fetchWorkshopModMetadata: async (workshopIds: string[]) => {
      workshopMetadataCalls += 1
      const items = new Map<string, WorkshopModMetadata>()
      if (workshopUpdatedAtIso) {
        for (const workshopId of workshopIds) {
          items.set(workshopId, {
            title: null,
            previewImage: null,
            updatedAt: workshopUpdatedAtIso,
            fileSize: null,
          })
        }
      }
      return { ok: true, items }
    },
    getInstanceModByWorkshopId: async (_instanceId: string, workshopId: string) =>
      listedMods.find(mod => mod.workshopId === workshopId),
    listInstanceMods: async () => listedMods,
    upsertInstanceMod: async (input) => {
      upsertCalls.push(input)
      const existingIndex = listedMods.findIndex(mod => mod.workshopId === input.workshopId)
      const nextMod = createMockMod({
        instanceId: input.instanceId,
        workshopId: input.workshopId,
        name: input.name,
        previewImage: input.previewImage ?? null,
        enabled: input.enabled ?? false,
        loadOrder: input.loadOrder ?? 0,
        version: input.version ?? null,
        installStatus: input.installStatus ?? 'ready',
        installError: input.installError ?? null,
        retryCount: input.retryCount ?? 0,
        nextRetryAt: input.nextRetryAt ?? null,
        id: listedMods[existingIndex]?.id,
        createdAt: listedMods[existingIndex]?.createdAt,
      })
      if (existingIndex >= 0) {
        listedMods[existingIndex] = nextMod
      }
      else {
        listedMods.push(nextMod)
      }
      return nextMod
    },
    updateInstanceModByWorkshopId: async (_instanceId: string, workshopId: string, patch) => {
      updateCalls.push({ workshopId, ...patch })
      const existingIndex = listedMods.findIndex(mod => mod.workshopId === workshopId)
      if (existingIndex < 0) {
        return undefined
      }
      const existing = listedMods[existingIndex]
      listedMods[existingIndex] = createMockMod({
        ...existing,
        installStatus: patch.installStatus ?? existing.installStatus,
        installError: typeof patch.installError !== 'undefined'
          ? (patch.installError ?? null)
          : existing.installError,
        retryCount: typeof patch.retryCount !== 'undefined' ? patch.retryCount : existing.retryCount,
        nextRetryAt: typeof patch.nextRetryAt !== 'undefined' ? (patch.nextRetryAt ?? null) : existing.nextRetryAt,
        updatedAt: new Date().toISOString(),
      })
      return listedMods[existingIndex]
    },
  })
}

afterEach(() => {
  resetModInstallJobsForTest()
  resetModDownloadExecutorForTest()
  resetModDownloadDbHooksForTest()
  resetModFileSyncDbHooksForTest()
  upsertCalls.length = 0
  updateCalls.length = 0
  listedMods = []
  workshopUpdatedAtIso = null
  workshopMetadataCalls = 0
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('mod-download-service', () => {
  it('writes pending record immediately and marks failed when download fails', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    setModDownloadExecutorForTest(async () => ({ ok: false, error: 'mock failure' }))

    const job = await enqueueModDownload({
      instanceId: 'instance-a',
      installPath,
      payload: {
        workshopId: '12345',
        name: 'Failed Mod',
      },
    })
    assert.equal(job.status, 'downloading')
    assert.equal(upsertCalls.length, 1)
    assert.equal(upsertCalls[0]?.installStatus, 'pending')
    await waitForModInstallJob('instance-a', '12345')

    const finished = getModInstallJob('instance-a', '12345')
    assert.equal(finished.status, 'failed')
    assert.equal(finished.error, 'mock failure')
    assert.equal(listedMods[0]?.installStatus, 'failed')
    assert.equal(listedMods[0]?.installError, 'mock failure')
    assert.equal(updateCalls.length, 1)
  })

  it('marks subscription ready after successful download and verification', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    writeWorkshopMod(installPath, '54321')
    setModDownloadExecutorForTest(async () => ({ ok: true }))

    const job = await enqueueModDownload({
      instanceId: 'instance-b',
      installPath,
      payload: {
        workshopId: '54321',
        name: 'Ready Mod',
      },
    })
    assert.equal(job.status, 'downloading')
    await waitForModInstallJob('instance-b', '54321')

    const finished = getModInstallJob('instance-b', '54321')
    assert.equal(finished.status, 'success')
    assert.equal(listedMods[0]?.installStatus, 'ready')
    assert.equal(upsertCalls.some(call => call.installStatus === 'pending'), true)
    assert.equal(upsertCalls.some(call => call.installStatus === 'ready'), true)
    assert.equal(fs.existsSync(path.join(installPath, 'mods', 'dedicated_server_mods_setup.lua')), true)
    // DST 只从 ugc_mods 加载创意工坊 Mod，下载完成即必须完成落位
    assert.equal(fs.existsSync(path.join(resolveDstUgcModDir(installPath, 'Master', '54321'), 'modinfo.lua')), true)
  })

  it('returns success immediately when mod files already exist and mod is ready', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    writeWorkshopMod(installPath, '77777')
    listedMods = [createMockMod({
      instanceId: 'instance-c',
      workshopId: '77777',
      name: 'Existing Mod',
      installStatus: 'ready',
    })]

    const job = await enqueueModDownload({
      instanceId: 'instance-c',
      installPath,
      payload: {
        workshopId: '77777',
        name: 'Existing Mod',
      },
    })

    assert.equal(job.status, 'success')
    assert.equal(upsertCalls.length, 0)
  })

  it('force re-downloads a ready mod even when files already exist', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    writeWorkshopMod(installPath, '77777')
    listedMods = [createMockMod({
      instanceId: 'instance-c',
      workshopId: '77777',
      name: 'Existing Mod',
      installStatus: 'ready',
      enabled: true,
    })]
    let downloadCount = 0
    setModDownloadExecutorForTest(async () => {
      downloadCount += 1
      return { ok: true }
    })

    const job = await enqueueModDownload({
      instanceId: 'instance-c',
      installPath,
      payload: {
        workshopId: '77777',
        name: 'Existing Mod',
      },
      force: true,
    })
    assert.equal(job.status, 'downloading')
    await waitForModInstallJob('instance-c', '77777')

    const finished = getModInstallJob('instance-c', '77777')
    assert.equal(finished.status, 'success')
    assert.equal(downloadCount, 1)
    assert.equal(upsertCalls.some(call => call.installStatus === 'pending'), true)
    assert.equal(listedMods[0]?.installStatus, 'ready')
    assert.equal(listedMods[0]?.enabled, true)
  })

  it('records the installed workshop version after a forced update', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    writeWorkshopMod(installPath, '66666')
    writeWorkshopManifest(installPath, '66666', 1_800_000_000)
    workshopUpdatedAtIso = new Date(1_800_000_000 * 1000).toISOString()
    listedMods = [createMockMod({
      instanceId: 'instance-e',
      workshopId: '66666',
      name: 'Updated Mod',
      installStatus: 'ready',
    })]
    setModDownloadExecutorForTest(async () => ({ ok: true }))

    await enqueueModDownload({
      instanceId: 'instance-e',
      installPath,
      payload: { workshopId: '66666', name: 'Updated Mod' },
      force: true,
    })
    await waitForModInstallJob('instance-e', '66666')

    const readyCall = upsertCalls.find(call => call.installStatus === 'ready')
    const versionIso = new Date(1_800_000_000 * 1000).toISOString()
    // 本机内容对应的版本时间来自内容凭据（这里是 SteamCMD 清单），更新后必须重新入账
    assert.equal(readyCall?.localUpdatedAt, versionIso)
    // 远端写的是工坊给出的时间，不再把本机时间复制给远端自证「已是最新」
    assert.equal(readyCall?.remoteUpdatedAt, versionIso)
    assert.ok(readyCall?.updateCheckedAt)
    // 下载并重新落位后游戏加载的就是这份内容：陈旧标记必须被清掉
    assert.equal(readyCall?.loadedCopyStale, false)
    assert.equal(workshopMetadataCalls, 1)
  })

  it('keeps the version evidence instead of stamping the download time', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    writeWorkshopMod(installPath, '66667')
    const contentFile = path.join(resolveDstSteamWorkshopModDir(installPath, '66667'), 'modinfo.lua')
    // 内容文件的时间就是本机内容的落地时间：这里模拟「盘上那份其实是旧版本」
    const staleStamp = new Date('2025-01-01T00:00:00.000Z')
    fs.utimesSync(contentFile, staleStamp, staleStamp)
    listedMods = [createMockMod({
      instanceId: 'instance-h',
      workshopId: '66667',
      name: 'Stale Mod',
      installStatus: 'ready',
    })]
    setModDownloadExecutorForTest(async () => ({ ok: true }))

    await enqueueModDownload({
      instanceId: 'instance-h',
      installPath,
      payload: { workshopId: '66667', name: 'Stale Mod' },
      force: true,
    })
    await waitForModInstallJob('instance-h', '66667')

    const readyCall = upsertCalls.find(call => call.installStatus === 'ready')
    assert.equal(readyCall?.localUpdatedAt, '2025-01-01T00:00:00.000Z')
    // 工坊取不到就什么都不写：绝不拿「刚下载的时刻」冒充版本时间
    assert.equal(readyCall?.remoteUpdatedAt, undefined)
    assert.equal(readyCall?.updateCheckedAt, undefined)
  })

  it('does not claim up to date when the workshop already moved past the local content', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    writeWorkshopMod(installPath, '66668')
    // 本机内容对应工坊的旧版本，而工坊已经有更新的版本：这次更新没有真正生效
    writeWorkshopManifest(installPath, '66668', 1_800_000_000)
    workshopUpdatedAtIso = new Date(1_800_086_400 * 1000).toISOString()
    listedMods = [createMockMod({
      instanceId: 'instance-i',
      workshopId: '66668',
      name: 'Not Applied',
      installStatus: 'ready',
    })]
    setModDownloadExecutorForTest(async () => ({ ok: true }))

    await enqueueModDownload({
      instanceId: 'instance-i',
      installPath,
      payload: { workshopId: '66668', name: 'Not Applied' },
      force: true,
    })
    await waitForModInstallJob('instance-i', '66668')

    const readyCall = upsertCalls.find(call => call.installStatus === 'ready')
    assert.equal(readyCall?.localUpdatedAt, new Date(1_800_000_000 * 1000).toISOString())
    assert.equal(readyCall?.remoteUpdatedAt, workshopUpdatedAtIso)
  })

  it('queues the subscription first and the missing backfill in its own batch', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    listedMods = [
      createMockMod({ instanceId: 'instance-f', workshopId: '100', name: 'Pending A', installStatus: 'pending', enabled: true }),
      createMockMod({ instanceId: 'instance-f', workshopId: '200', name: 'Pending B', installStatus: 'pending', enabled: true }),
      createMockMod({ instanceId: 'instance-f', workshopId: '300', name: 'Ready C', installStatus: 'ready', enabled: true }),
    ]
    writeWorkshopMod(installPath, '300')
    const downloadBatches: string[][] = []
    setModDownloadExecutorForTest(async (input) => {
      downloadBatches.push([...input.workshopIds])
      for (const workshopId of input.workshopIds) {
        writeWorkshopMod(installPath, workshopId)
      }
      return { ok: true }
    })

    await enqueueModDownload({
      instanceId: 'instance-f',
      installPath,
      payload: { workshopId: '100', name: 'Pending A' },
    })
    await waitForModDownloadQueueIdle('instance-f')

    // 批次由队列统一决定：用户订阅的 100 先成一批，随后补齐项 200 单独成批；已就绪的 300 不参与
    assert.deepEqual(downloadBatches, [['100'], ['200']])
    assert.equal(getModInstallJob('instance-f', '100').status, 'success')
    assert.equal(listedMods.find(mod => mod.workshopId === '100')?.installStatus, 'ready')
    assert.equal(listedMods.find(mod => mod.workshopId === '200')?.installStatus, 'ready')
  })

  it('keeps going when a backfill mod fails in the previous batch', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    listedMods = [
      createMockMod({ instanceId: 'instance-g', workshopId: '111', name: 'Pending A', installStatus: 'pending', enabled: true }),
      createMockMod({ instanceId: 'instance-g', workshopId: '222', name: 'Pending B', installStatus: 'pending', enabled: true }),
    ]
    setModDownloadRetryDelaysForTest([5, 10, 20])
    let batchIndex = 0
    setModDownloadExecutorForTest(async (input) => {
      batchIndex += 1
      // 第一批（用户订阅的那个）正常下载，第二批（补齐项）失败：单批失败不能把队列带走
      if (batchIndex === 1) {
        for (const workshopId of input.workshopIds) {
          writeWorkshopMod(installPath, workshopId)
        }
      }
      return { ok: true }
    })

    await enqueueModDownload({
      instanceId: 'instance-g',
      installPath,
      payload: { workshopId: '111', name: 'Pending A' },
    })
    await waitForModDownloadQueueIdle('instance-g')

    assert.equal(getModInstallJob('instance-g', '111').status, 'success')
    assert.equal(listedMods.find(mod => mod.workshopId === '111')?.installStatus, 'ready')
    // 另一个 Mod 自己重试到预算用尽才失败，整个过程不影响已经就绪的 111
    const failed = listedMods.find(mod => mod.workshopId === '222')
    assert.equal(failed?.installStatus, 'failed')
    assert.equal(failed?.retryCount, MOD_DOWNLOAD_MAX_ATTEMPTS)
  })

  it('deduplicates in-flight download jobs for the same workshop id', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    let resolveDownload: ((value: { ok: boolean }) => void) | undefined
    const downloadPromise = new Promise<{ ok: boolean }>((resolve) => {
      resolveDownload = resolve
    })
    setModDownloadExecutorForTest(async (input) => {
      await downloadPromise
      for (const workshopId of input.workshopIds) {
        writeWorkshopMod(installPath, workshopId)
      }
      return { ok: true }
    })

    const first = await enqueueModDownload({
      instanceId: 'instance-d',
      installPath,
      payload: { workshopId: '88888', name: 'Queued Mod' },
    })
    const second = await enqueueModDownload({
      instanceId: 'instance-d',
      installPath,
      payload: { workshopId: '88888', name: 'Queued Mod' },
    })

    assert.equal(first.status, 'downloading')
    assert.equal(second.status, 'downloading')
    resolveDownload?.({ ok: true })
    await waitForModInstallJob('instance-d', '88888')
    assert.equal(getModInstallJob('instance-d', '88888').status, 'success')
    // 第二次入队命中「已在队列中」的判定：不再多写一条 pending 记录
    assert.equal(upsertCalls.filter(call => call.installStatus === 'pending').length, 1)
  })

  it('clears failed status before retrying download', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    listedMods.push(createMockMod({
      instanceId: 'instance-e',
      workshopId: '99999',
      name: 'Retry Mod',
      installStatus: 'failed',
      installError: 'previous failure',
    }))
    setModDownloadExecutorForTest(async () => ({ ok: false, error: 'retry failed' }))

    await enqueueModDownload({
      instanceId: 'instance-e',
      installPath,
      payload: { workshopId: '99999', name: 'Retry Mod' },
    })
    await waitForModInstallJob('instance-e', '99999')

    assert.ok(updateCalls.some(call => call.installStatus === 'pending' && call.installError === null))
    assert.equal(listedMods[0]?.installStatus, 'failed')
  })

  it('unpacks a legacy workshop download into ugc_mods and marks the mod ready', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const modDir = resolveDstSteamWorkshopModDir(installPath, '501385076')
    fs.mkdirSync(modDir, { recursive: true })
    const archive = zipSync({
      'modinfo.lua': strToU8('name = "Quick Pick"\n'),
      'modmain.lua': strToU8('-- main\n'),
    })
    fs.writeFileSync(path.join(modDir, '1665728219799633209_legacy.bin'), Buffer.from(archive))
    setModDownloadExecutorForTest(async () => ({ ok: true }))

    await enqueueModDownload({
      instanceId: 'instance-h',
      installPath,
      payload: { workshopId: '501385076', name: '快速采集' },
    })
    await waitForModInstallJob('instance-h', '501385076')

    assert.equal(getModInstallJob('instance-h', '501385076').status, 'success')
    assert.equal(listedMods[0]?.installStatus, 'ready')
    const ugcModDir = resolveDstUgcModDir(installPath, 'Master', '501385076')
    assert.equal(fs.existsSync(path.join(ugcModDir, 'modmain.lua')), true)
  })

  it('fails the subscription when the downloaded mod cannot be placed into ugc_mods', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const modDir = resolveDstSteamWorkshopModDir(installPath, '40404')
    fs.mkdirSync(modDir, { recursive: true })
    fs.writeFileSync(path.join(modDir, '123_legacy.bin'), Buffer.from('not a zip'))
    setModDownloadExecutorForTest(async () => ({ ok: true }))

    await enqueueModDownload({
      instanceId: 'instance-g',
      installPath,
      payload: { workshopId: '40404', name: 'Broken Legacy Mod' },
    })
    await waitForModInstallJob('instance-g', '40404')

    const finished = getModInstallJob('instance-g', '40404')
    assert.equal(finished.status, 'failed')
    assert.match(finished.error ?? '', /未能安装到服务器目录/)
    assert.equal(listedMods[0]?.installStatus, 'failed')
    assert.equal(upsertCalls.some(call => call.installStatus === 'ready'), false)
  })

  it('resolveModInstallJob falls back to failed mod record when memory job is gone', async () => {
    installDbHooks()
    listedMods.push(createMockMod({
      instanceId: 'instance-f',
      workshopId: '77777',
      name: 'Failed Memory Mod',
      installStatus: 'failed',
      installError: 'mock failure persisted',
    }))

    const job = await resolveModInstallJob('instance-f', '77777')
    assert.equal(job.status, 'failed')
    assert.equal(job.error, 'mock failure persisted')
  })
})

describe('mod-download-queue', () => {
  /** 迁移包导入后的典型形态：一条条 pending，谁都没在下载 */
  function createPendingMods(instanceId: string, ids: string[], enabled = true) {
    return ids.map((workshopId, index) => createMockMod({
      instanceId,
      workshopId,
      name: `Mod ${workshopId}`,
      installStatus: 'pending',
      enabled,
      loadOrder: index,
      installError: '创意工坊内容缺失，未下载',
    }))
  }

  afterEach(() => {
    delete process.env.GSH_MOD_DOWNLOAD_COALESCE_LIMIT
    resetModDownloadRetryDelaysForTest()
    resetModDownloadQueueForTest()
  })

  it('turns 30 pending mods into a bounded number of batches', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const instanceId = 'inst-many'
    const ids = Array.from({ length: 30 }, (_value, index) => String(10_000 + index))
    listedMods = createPendingMods(instanceId, ids)
    const batches: string[][] = []
    setModDownloadExecutorForTest(async (input) => {
      batches.push([...input.workshopIds])
      for (const workshopId of input.workshopIds) {
        writeWorkshopMod(installPath, workshopId)
      }
      return { ok: true }
    })

    await startModDownloadQueue({ instanceId, installPath })
    await waitForModDownloadQueueIdle(instanceId)

    // 30 个 pending 不再等于 30 个任务：单批上限 5 → 6 批
    assert.equal(batches.length, 6)
    assert.ok(batches.every(batch => batch.length <= 5))
    assert.equal(listedMods.every(mod => mod.installStatus === 'ready'), true)
  })

  it('runs exactly one SteamCMD batch at a time', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const instanceId = 'inst-serial'
    listedMods = createPendingMods(
      instanceId,
      Array.from({ length: 12 }, (_value, index) => String(20_000 + index)),
    )
    let inFlight = 0
    let peak = 0
    setModDownloadExecutorForTest(async (input) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      for (const workshopId of input.workshopIds) {
        writeWorkshopMod(installPath, workshopId)
      }
      inFlight -= 1
      return { ok: true }
    })

    // 重复 start 是幂等的：仍然只有一条队列、一个 worker
    await Promise.all([
      startModDownloadQueue({ instanceId, installPath }),
      startModDownloadQueue({ instanceId, installPath }),
      startModDownloadQueue({ instanceId, installPath }),
    ])
    await waitForModDownloadQueueIdle(instanceId)

    assert.equal(peak, 1)
  })

  it('deduplicates the same workshop id inside the queue', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const instanceId = 'inst-dedupe'
    listedMods = createPendingMods(instanceId, ['900'])
    const batches: string[][] = []
    setModDownloadExecutorForTest(async (input) => {
      batches.push([...input.workshopIds])
      for (const workshopId of input.workshopIds) {
        writeWorkshopMod(installPath, workshopId)
      }
      return { ok: true }
    })

    await startModDownloadQueue({
      instanceId,
      installPath,
      head: [
        { workshopId: '900', force: false, source: 'user' },
        { workshopId: '900', force: false, source: 'user' },
      ],
    })
    await waitForModDownloadQueueIdle(instanceId)

    assert.deepEqual(batches, [['900']])
    assert.equal(listedMods.filter(mod => mod.workshopId === '900').length, 1)
  })

  it('does not download disabled mods automatically', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const instanceId = 'inst-disabled'
    listedMods = [
      createMockMod({
        instanceId,
        workshopId: '1111',
        name: 'Enabled Mod',
        installStatus: 'pending',
        enabled: true,
      }),
      createMockMod({
        instanceId,
        workshopId: '2222',
        name: 'Disabled Mod',
        installStatus: 'pending',
        enabled: false,
      }),
    ]
    const batches: string[][] = []
    setModDownloadExecutorForTest(async (input) => {
      batches.push([...input.workshopIds])
      for (const workshopId of input.workshopIds) {
        writeWorkshopMod(installPath, workshopId)
      }
      return { ok: true }
    })

    await startModDownloadQueue({ instanceId, installPath })
    await waitForModDownloadQueueIdle(instanceId)

    assert.deepEqual(batches, [['1111']])
    assert.equal(listedMods.find(mod => mod.workshopId === '2222')?.installStatus, 'pending')
  })

  it('downloads a dependency before the mod that needs it', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const instanceId = 'inst-deps'
    listedMods = createPendingMods(instanceId, ['1000', '2000'])
    // 面板记录的依赖关系：1000 依赖 2000
    writeModDependencyMap(installPath, { '1000': ['2000'] })
    const batches: string[][] = []
    setModDownloadExecutorForTest(async (input) => {
      batches.push([...input.workshopIds])
      for (const workshopId of input.workshopIds) {
        writeWorkshopMod(installPath, workshopId)
      }
      return { ok: true }
    })

    await startModDownloadQueue({ instanceId, installPath })
    await waitForModDownloadQueueIdle(instanceId)

    assert.deepEqual(batches, [['2000', '1000']])
  })

  it('keeps processing later batches after one batch fails', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const instanceId = 'inst-continue'
    process.env.GSH_MOD_DOWNLOAD_COALESCE_LIMIT = '1'
    listedMods = createPendingMods(instanceId, ['3001', '3002', '3003'])
    setModDownloadRetryDelaysForTest([5, 10, 20])
    let calls = 0
    setModDownloadExecutorForTest(async (input) => {
      calls += 1
      // 只让第一批失败：后面的批必须照常执行
      if (calls > 1) {
        for (const workshopId of input.workshopIds) {
          writeWorkshopMod(installPath, workshopId)
        }
      }
      return { ok: true }
    })

    await startModDownloadQueue({ instanceId, installPath })
    await waitForModDownloadQueueIdle(instanceId)

    assert.ok(calls >= 3)
    assert.equal(listedMods.find(mod => mod.workshopId === '3002')?.installStatus, 'ready')
    assert.equal(listedMods.find(mod => mod.workshopId === '3003')?.installStatus, 'ready')
  })

  it('backs off failed backfill mods and gives up after the retry budget', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const instanceId = 'inst-backoff'
    process.env.GSH_MOD_DOWNLOAD_COALESCE_LIMIT = '1'
    listedMods = createPendingMods(instanceId, ['4001'])
    setModDownloadRetryDelaysForTest([5, 10, 20])
    let calls = 0
    setModDownloadExecutorForTest(async () => {
      calls += 1
      return { ok: false, error: 'network down' }
    })

    await startModDownloadQueue({ instanceId, installPath })
    await waitForModDownloadQueueIdle(instanceId)

    // 退避用尽（3 次）后转 failed，等用户手动重试；每次失败都重排一次，不阻塞队列
    assert.equal(calls, MOD_DOWNLOAD_MAX_ATTEMPTS)
    const mod = listedMods[0]
    assert.equal(mod?.installStatus, 'failed')
    assert.equal(mod?.retryCount, MOD_DOWNLOAD_MAX_ATTEMPTS)
    assert.match(mod?.installError ?? '', /network down/)

    // 默认退避序列就是 10s / 30s / 60s
    assert.deepEqual(MOD_DOWNLOAD_RETRY_DELAYS_MS, [10_000, 30_000, 60_000])
  })

  it('keeps a failed batch retrying with backoff before the budget runs out', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const instanceId = 'inst-backoff-once'
    process.env.GSH_MOD_DOWNLOAD_COALESCE_LIMIT = '1'
    listedMods = createPendingMods(instanceId, ['4501'])
    setModDownloadRetryDelaysForTest([50, 60, 70])
    let calls = 0
    setModDownloadExecutorForTest(async (input) => {
      calls += 1
      // 第一次失败，第二次成功：失败项应带着退避重新排队
      if (calls === 1) {
        return { ok: false, error: 'network down' }
      }
      for (const workshopId of input.workshopIds) {
        writeWorkshopMod(installPath, workshopId)
      }
      return { ok: true }
    })

    await startModDownloadQueue({ instanceId, installPath })
    await waitForModDownloadQueueIdle(instanceId)

    assert.equal(calls, 2)
    assert.equal(listedMods[0]?.installStatus, 'ready')
    assert.equal(listedMods[0]?.retryCount, 0)
    assert.equal(listedMods[0]?.nextRetryAt, null)
  })

  it('rebuilds the pending queue from the database after a restart', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const instanceId = 'inst-restart'
    listedMods = createPendingMods(instanceId, ['5001', '5002', '5003'])
    let executorCalls = 0
    setModDownloadExecutorForTest(async (input) => {
      executorCalls += 1
      for (const workshopId of input.workshopIds) {
        writeWorkshopMod(installPath, workshopId)
      }
      return { ok: true }
    })

    // 模拟面板重启：内存队列清空，DB 里仍是 pending
    resetModDownloadQueueForTest()
    const state = await resolveModDownloadQueueState({ instanceId, installPath })
    assert.equal(state.status, 'idle')
    assert.equal(state.total, 3)
    assert.equal(state.queued, 3)
    assert.equal(state.downloading, 0)
    assert.equal(executorCalls, 0, '重启后不得自动开跑')

    await startModDownloadQueue({ instanceId, installPath })
    await waitForModDownloadQueueIdle(instanceId)
    assert.equal(executorCalls, 1)
    assert.equal(listedMods.every(mod => mod.installStatus === 'ready'), true)
  })

  it('marks mods whose content is already on disk ready without calling SteamCMD', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const instanceId = 'inst-ondisk'
    listedMods = createPendingMods(instanceId, ['6001'])
    writeWorkshopMod(installPath, '6001')
    let executorCalls = 0
    setModDownloadExecutorForTest(async () => {
      executorCalls += 1
      return { ok: true }
    })

    await startModDownloadQueue({ instanceId, installPath })
    await waitForModDownloadQueueIdle(instanceId)

    assert.equal(executorCalls, 0)
    assert.equal(listedMods[0]?.installStatus, 'ready')
  })

  it('pauses the queue at the batch boundary', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const instanceId = 'inst-pause'
    listedMods = createPendingMods(instanceId, ['7001', '7002'])
    setModDownloadExecutorForTest(async (input) => {
      for (const workshopId of input.workshopIds) {
        writeWorkshopMod(installPath, workshopId)
      }
      return { ok: true }
    })

    await startModDownloadQueue({ instanceId, installPath })
    const paused = pauseModDownloadQueue(instanceId)
    assert.ok(paused)
    assert.ok(paused?.status === 'paused' || paused?.status === 'pausing')
    await waitForModDownloadQueueIdle(instanceId)
    const queue = await resolveModDownloadQueueState({ instanceId, installPath })
    assert.equal(queue.status, 'paused')
  })

  it('sends a multi-mod update as one batch instead of one batch per mod', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const instanceId = 'inst-batch-update'
    listedMods = ['8001', '8002'].map(workshopId => createMockMod({
      instanceId,
      workshopId,
      name: `Mod ${workshopId}`,
      installStatus: 'ready',
      enabled: true,
    }))
    writeWorkshopMod(installPath, '8001')
    writeWorkshopMod(installPath, '8002')
    const batches: string[][] = []
    setModDownloadExecutorForTest(async (input) => {
      batches.push([...input.workshopIds])
      return { ok: true }
    })

    await enqueueModDownloads({
      instanceId,
      installPath,
      force: true,
      payloads: [
        { workshopId: '8001', name: 'Mod 8001' },
        { workshopId: '8002', name: 'Mod 8002' },
      ],
    })
    await waitForModDownloadQueueIdle(instanceId)

    // 两个 Mod 一次下完：不是「每个 Mod 各一批」
    assert.deepEqual(batches, [['8001', '8002']])
    assert.equal(listedMods.every(mod => mod.installStatus === 'ready'), true)
  })

  it('re-places the mod into ugc_mods when force updating an already ready mod', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const instanceId = 'inst-refresh'
    listedMods = [createMockMod({
      instanceId,
      workshopId: '8501',
      name: 'Outdated Mod',
      installStatus: 'ready',
      enabled: true,
    })]
    // 下载目录是旧内容，ugc_mods 里也是旧的落位结果
    const sourceDir = resolveDstSteamWorkshopModDir(installPath, '8501')
    fs.mkdirSync(sourceDir, { recursive: true })
    fs.writeFileSync(path.join(sourceDir, 'modinfo.lua'), 'name = "old"\n')
    await ensureDstUgcModLayout(installPath, ['8501'])
    const ugcModInfo = path.join(resolveDstUgcModDir(installPath, 'Master', '8501'), 'modinfo.lua')
    assert.match(fs.readFileSync(ugcModInfo, 'utf8'), /old/)

    setModDownloadExecutorForTest(async (input) => {
      // SteamCMD 把下载目录换成了新内容（这里只有一个待更新 Mod）
      assert.ok(input.workshopIds.includes('8501'))
      fs.writeFileSync(path.join(sourceDir, 'modinfo.lua'), 'name = "new"\n')
      return { ok: true }
    })

    await enqueueModDownloads({
      instanceId,
      installPath,
      force: true,
      payloads: [{ workshopId: '8501', name: 'Outdated Mod' }],
    })
    await waitForModDownloadQueueIdle(instanceId)

    // 目标目录只有 modinfo.lua 时本来会被判「已落位」而跳过：强制更新必须重新落位，
    // 否则游戏读的还是旧文件，版本状态会永远停在「有新版本」
    assert.match(fs.readFileSync(ugcModInfo, 'utf8'), /new/)
  })

  it('counts the queue total without double-counting head items that are already pending', async () => {
    installDbHooks()
    const installPath = createInstallPath()
    const instanceId = 'inst-total'
    listedMods = createPendingMods(instanceId, ['9001', '9002', '9003'])
    const totals: number[] = []
    setModDownloadExecutorForTest(async (input) => {
      for (const workshopId of input.workshopIds) {
        writeWorkshopMod(installPath, workshopId)
      }
      const snapshot = getModDownloadQueueSnapshot(instanceId)
      totals.push(snapshot?.total ?? 0)
      return { ok: true }
    })

    // 9001 既在插队项里、库里也是 pending：总数只能算一次
    await startModDownloadQueue({
      instanceId,
      installPath,
      head: [{ workshopId: '9001', force: false, source: 'user' }],
    })
    await waitForModDownloadQueueIdle(instanceId)

    assert.equal(totals[0], 3)
    const finalQueue = getModDownloadQueueSnapshot(instanceId)
    assert.equal(finalQueue?.total, 3)
    assert.equal(finalQueue?.success, 3)
  })
})
