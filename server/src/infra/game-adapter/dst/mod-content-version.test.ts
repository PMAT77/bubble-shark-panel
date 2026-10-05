import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { resolveWorkshopManifestPath } from './workshop-manifest'
import { resolveLocalModContentVersion } from './mod-content-version'

const tempDirs: string[] = []

function makeInstallPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-mod-content-version-'))
  tempDirs.push(dir)
  return dir
}

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

/** 写一份内容文件并把它的 mtime 固定下来，模拟内容真实的落地时间 */
function writeModContent(dir: string, mtimeIso: string, fileName = 'modinfo.lua'): void {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, fileName)
  fs.writeFileSync(filePath, 'return {}')
  const stamp = new Date(mtimeIso)
  fs.utimesSync(filePath, stamp, stamp)
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveLocalModContentVersion', () => {
  it('prefers the SteamCMD manifest time over file times', () => {
    const installPath = makeInstallPath()
    const manifestIso = new Date(1_800_000_000 * 1000).toISOString()
    writeWorkshopManifest(installPath, [{ workshopId: '111', timeupdated: 1_800_000_000 }])
    writeModContent(resolveDownloadedModDir(installPath, '111'), '2026-09-01T00:00:00.000Z')

    const version = resolveLocalModContentVersion(installPath, '111')

    assert.equal(version.updatedAt, manifestIso)
    assert.equal(version.source, 'workshop-manifest')
    assert.equal(version.loadedCopyStale, false)
  })

  it('falls back to the content file time when the manifest has no entry', () => {
    const installPath = makeInstallPath()
    // 清单存在但没有这个 Mod 的条目：历史实例、手工放置内容都会这样
    writeWorkshopManifest(installPath, [{ workshopId: '999', timeupdated: 1_800_000_000 }])
    writeModContent(resolveDownloadedModDir(installPath, '222'), '2026-01-02T03:04:05.000Z')

    const version = resolveLocalModContentVersion(installPath, '222')

    assert.equal(version.updatedAt, '2026-01-02T03:04:05.000Z')
    assert.equal(version.source, 'content-mtime')
  })

  it('falls back to the content file time when the manifest is missing entirely', () => {
    const installPath = makeInstallPath()
    writeModContent(resolveDownloadedModDir(installPath, '333'), '2026-02-03T04:05:06.000Z')

    const version = resolveLocalModContentVersion(installPath, '333')

    assert.equal(version.updatedAt, '2026-02-03T04:05:06.000Z')
    assert.equal(version.source, 'content-mtime')
  })

  it('uses the legacy archive time when the content dir has no lua files', () => {
    const installPath = makeInstallPath()
    writeModContent(resolveDownloadedModDir(installPath, '444'), '2026-03-04T05:06:07.000Z', '123_legacy.bin')

    const version = resolveLocalModContentVersion(installPath, '444')

    assert.equal(version.updatedAt, '2026-03-04T05:06:07.000Z')
    assert.equal(version.source, 'content-mtime')
  })

  it('reports no evidence at all instead of guessing', () => {
    const installPath = makeInstallPath()

    const version = resolveLocalModContentVersion(installPath, '555')

    assert.equal(version.updatedAt, null)
    assert.equal(version.source, null)
    assert.equal(version.loadedCopyStale, false)
  })

  it('treats an empty download directory as no evidence', () => {
    const installPath = makeInstallPath()
    // 下到一半的目录：什么都没有，目录自身的时间不能当版本凭据
    fs.mkdirSync(resolveDownloadedModDir(installPath, '556'), { recursive: true })

    const version = resolveLocalModContentVersion(installPath, '556')

    assert.equal(version.updatedAt, null)
    assert.equal(version.source, null)
  })

  it('flags the game-loaded copy when ugc_mods is older than the downloaded content', () => {
    const installPath = makeInstallPath()
    writeModContent(resolveDownloadedModDir(installPath, '666'), '2026-05-06T07:08:09.000Z')
    // 落位发生在下载之前：游戏读到的仍是旧内容
    writeModContent(resolveUgcModDir(installPath, '666'), '2026-04-01T00:00:00.000Z')

    const version = resolveLocalModContentVersion(installPath, '666')

    assert.equal(version.loadedCopyStale, true)
  })

  it('does not flag a freshly relocated copy', () => {
    const installPath = makeInstallPath()
    writeModContent(resolveDownloadedModDir(installPath, '777'), '2026-05-06T07:08:09.000Z')
    // 落位晚于下载：cpSync 会写下当前时间，游戏读到的就是这份内容
    writeModContent(resolveUgcModDir(installPath, '777'), '2026-05-06T07:09:00.000Z')

    const version = resolveLocalModContentVersion(installPath, '777')

    assert.equal(version.loadedCopyStale, false)
  })

  it('still reports the downloaded content time while flagging a stale copy', () => {
    const installPath = makeInstallPath()
    writeWorkshopManifest(installPath, [{ workshopId: '888', timeupdated: 1_800_000_000 }])
    writeModContent(resolveDownloadedModDir(installPath, '888'), '2026-05-06T07:08:09.000Z')
    writeModContent(resolveUgcModDir(installPath, '888'), '2026-04-01T00:00:00.000Z')

    const version = resolveLocalModContentVersion(installPath, '888')

    assert.equal(version.source, 'workshop-manifest')
    assert.equal(version.loadedCopyStale, true)
  })

  it('returns unknown for empty inputs', () => {
    assert.deepEqual(resolveLocalModContentVersion('', '111'), {
      updatedAt: null,
      source: null,
      loadedCopyStale: false,
    })
    assert.equal(resolveLocalModContentVersion(makeInstallPath(), '   ').updatedAt, null)
  })
})
