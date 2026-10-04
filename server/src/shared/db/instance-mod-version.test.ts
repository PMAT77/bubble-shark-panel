import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  closeDatabase,
  getInstanceModByWorkshopId,
  initDatabase,
  listInstanceMods,
  updateInstanceModByWorkshopId,
  upsertInstanceMod,
} from './index'

const dbFilePath = path.join(os.tmpdir(), `gsh-mod-version-test-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

/** Mod 版本时间入库：迁移新增三列后，读写两侧的列名必须对得上 */
describe('instance_mods version columns', () => {
  it('persists explicit intent, preserves omitted values and clears it explicitly', async () => {
    const instanceId = `intent-${randomUUID()}`
    const input = { instanceId, workshopId: '777', name: 'Disabled update', enabled: false, loadOrder: 0, installStatus: 'pending' as const }
    await upsertInstanceMod({ ...input, downloadIntent: 'update' })
    assert.equal((await getInstanceModByWorkshopId(instanceId, '777'))?.downloadIntent, 'update')
    await upsertInstanceMod(input)
    assert.equal((await listInstanceMods(instanceId))[0]?.downloadIntent, 'update')
    await updateInstanceModByWorkshopId(instanceId, '777', { downloadIntent: null })
    assert.equal((await getInstanceModByWorkshopId(instanceId, '777'))?.downloadIntent, null)
  })
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
  })

  after(() => {
    closeDatabase()
    for (const suffix of ['', '-shm', '-wal']) {
      fs.rmSync(`${dbFilePath}${suffix}`, { force: true })
    }
  })

  it('stores and reads back the local/remote version times', async () => {
    const instanceId = `inst-${randomUUID().slice(0, 8)}`
    const localUpdatedAt = new Date(1_800_000_000 * 1000).toISOString()
    const remoteUpdatedAt = new Date(1_800_086_400 * 1000).toISOString()
    const checkedAt = new Date().toISOString()

    await upsertInstanceMod({
      instanceId,
      workshopId: '111',
      name: '版本测试 Mod',
      enabled: true,
      loadOrder: 0,
      installStatus: 'ready',
      localUpdatedAt,
      remoteUpdatedAt,
      updateCheckedAt: checkedAt,
    })

    const stored = await getInstanceModByWorkshopId(instanceId, '111')
    assert.equal(stored?.localUpdatedAt, localUpdatedAt)
    assert.equal(stored?.remoteUpdatedAt, remoteUpdatedAt)
    assert.equal(stored?.updateCheckedAt, checkedAt)

    const listed = await listInstanceMods(instanceId)
    assert.equal(listed[0]?.localUpdatedAt, localUpdatedAt)
  })

  it('keeps existing version times when an upsert omits them', async () => {
    const instanceId = `inst-${randomUUID().slice(0, 8)}`
    const localUpdatedAt = new Date(1_800_000_000 * 1000).toISOString()

    await upsertInstanceMod({
      instanceId,
      workshopId: '222',
      name: '既有版本',
      enabled: false,
      loadOrder: 0,
      localUpdatedAt,
    })
    // 订阅/补齐路径不带版本字段：不能把已记录的本机版本时间抹掉
    await upsertInstanceMod({
      instanceId,
      workshopId: '222',
      name: '重新订阅',
      enabled: false,
      loadOrder: 0,
    })
    const stored = await getInstanceModByWorkshopId(instanceId, '222')
    assert.equal(stored?.name, '重新订阅')
    assert.equal(stored?.localUpdatedAt, localUpdatedAt)

    const patchCheckedAt = new Date().toISOString()
    const patched = await updateInstanceModByWorkshopId(instanceId, '222', {
      updateCheckedAt: patchCheckedAt,
      remoteUpdatedAt: localUpdatedAt,
    })
    assert.equal(patched?.updateCheckedAt, patchCheckedAt)
    assert.equal(patched?.localUpdatedAt, localUpdatedAt)
  })

  it('stores the stale-loaded-copy flag so the list can offer an update', async () => {
    const instanceId = `inst-${randomUUID().slice(0, 8)}`

    await upsertInstanceMod({
      instanceId,
      workshopId: '333',
      name: '落位没跟上',
      enabled: true,
      loadOrder: 0,
      loadedCopyStale: true,
    })
    const stored = await getInstanceModByWorkshopId(instanceId, '333')
    assert.equal(stored?.loadedCopyStale, true)

    // 重新落位后同一个标记必须能清掉，否则列表会永远挂着「有新版本」
    const cleared = await updateInstanceModByWorkshopId(instanceId, '333', { loadedCopyStale: false })
    assert.equal(cleared?.loadedCopyStale, false)
    assert.equal((await listInstanceMods(instanceId))[0]?.loadedCopyStale, false)
  })

  it('defaults the stale flag to false for rows written without it', async () => {
    const instanceId = `inst-${randomUUID().slice(0, 8)}`

    await upsertInstanceMod({
      instanceId,
      workshopId: '444',
      name: '普通 Mod',
      enabled: true,
      loadOrder: 0,
    })

    const stored = await getInstanceModByWorkshopId(instanceId, '444')
    assert.equal(stored?.loadedCopyStale, false)
  })
})
