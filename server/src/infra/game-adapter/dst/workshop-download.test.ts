import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, it } from 'node:test'
import { cancelDstWorkshopDownloads, runWorkshopDownload, setWorkshopCacheRootForTest, setWorkshopDownloadWorkerForTest } from './workshop-download'
import { withSteamcmdAppUpdateLock } from '../../container/steamcmd-app-update-queue'
import { withInstallPathLock } from '../../../shared/instance-content/install-lock'
import { ContentTransaction } from '../../backup/content-transaction'
import { resolveDstSteamWorkshopModDir } from './constants'
import { resolveDstUgcModDir } from './ugc-mod-install'

const directories: string[] = []
afterEach(() => {
  setWorkshopDownloadWorkerForTest()
  setWorkshopCacheRootForTest()
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-cdn-install-'))
  directories.push(root)
  setWorkshopCacheRootForTest(path.join(root, 'cache'))
  const input = { instanceId: 'cdn-test', hostInstallPath: root, workshopIds: ['123'] }
  const canonical = resolveDstSteamWorkshopModDir(root, '123')
  const loaded = resolveDstUgcModDir(root, 'Master', '123')
  for (const dir of [canonical, loaded]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'modinfo.lua'), 'name="old"') }
  setWorkshopDownloadWorkerForTest(async (_input, cacheRoot) => {
    const sourceDir = path.join(cacheRoot, '123', '777', 'content')
    fs.mkdirSync(sourceDir, { recursive: true })
    fs.writeFileSync(path.join(sourceDir, 'modinfo.lua'), 'name="new"')
    return { cancelled: false, results: [{ workshopId: '123', ok: true, sourceDir, manifestId: '777', updatedAt: '2026-01-01T00:00:00.000Z' }] }
  })
  return { input, canonical, loaded }
}
it('installs only verified content and records the actual downloaded version', async t => {
  const previous = process.env.BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS
  process.env.BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS = '0'
  t.after(() => { if (previous === undefined) delete process.env.BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS; else process.env.BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS = previous })
  const { input, canonical, loaded } = fixture()
  const result = await runWorkshopDownload(input)
  assert.equal(result.items?.[0]?.installed, true)
  for (const dir of [canonical, loaded]) {
    assert.equal(fs.readFileSync(path.join(dir, 'modinfo.lua'), 'utf8'), 'name="new"')
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.bsp-workshop-download.json'), 'utf8')).manifestId, '777')
  }
})
it('restores both canonical and loaded old content if installation fails after replacement', async t => {
  const previous = process.env.BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS
  process.env.BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS = '0'
  t.after(() => { if (previous === undefined) delete process.env.BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS; else process.env.BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS = previous })
  const { input, canonical, loaded } = fixture()
  const apply = ContentTransaction.prototype.apply
  t.mock.method(ContentTransaction.prototype, 'apply', function (this: ContentTransaction<null>) { apply.call(this); throw new Error('fixture install failure') })
  const result = await runWorkshopDownload(input)
  assert.equal(result.ok, false)
  for (const dir of [canonical, loaded]) assert.equal(fs.readFileSync(path.join(dir, 'modinfo.lua'), 'utf8'), 'name="old"')
})

it('downloads and installs an unrelated instance while a SteamCMD global job is active', async () => {
  const { input } = fixture()
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const hold = withSteamcmdAppUpdateLock('other-instance', async () => {
    entered()
    await new Promise<void>(resolve => { release = resolve })
  })
  await started
  try {
    const result = await runWorkshopDownload(input)
    assert.equal(result.ok, true)
  }
  finally { release(); await hold }
})

it('cancels a mod waiting for its installation directory without replacing the old content', async () => {
  const { input, canonical } = fixture()
  let release!: () => void
  let waiting!: () => void
  const queued = new Promise<void>(resolve => { waiting = resolve })
  const hold = withInstallPathLock(input.hostInstallPath, () => new Promise<void>(resolve => { release = resolve }))
  await Promise.resolve()
  const task = runWorkshopDownload({ ...input, onProgress: event => { if (event.phase === 'waiting_install') waiting() } })
  await queued
  assert.equal(cancelDstWorkshopDownloads(input.instanceId), true)
  const result = await task
  assert.equal(result.cancelled, true)
  assert.equal(fs.readFileSync(path.join(canonical, 'modinfo.lua'), 'utf8'), 'name="old"')
  release()
  await hold
})
