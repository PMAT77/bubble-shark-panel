import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { closeDatabase, initDatabase } from './index'
import {
  findPlayerProfilesByKuIds,
  listPlayerProfiles,
  removePlayerProfilesByInstance,
  setPlayerProfileNote,
  upsertPlayerProfiles,
} from './player-profile-repository'

const dbFilePath = path.join(os.tmpdir(), `bsp-player-profile-test-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

const INSTANCE_A = 'inst-profile-a'
const INSTANCE_B = 'inst-profile-b'

describe('player profile repository', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
  })

  after(() => {
    closeDatabase()
  })

  it('records a player name seen online', async () => {
    await upsertPlayerProfiles(INSTANCE_A, [{ kuId: 'KU_alpha01', name: 'Wilson' }])
    const profiles = await listPlayerProfiles(INSTANCE_A)
    assert.equal(profiles.length, 1)
    assert.equal(profiles[0].kuId, 'KU_alpha01')
    assert.equal(profiles[0].name, 'Wilson')
  })

  it('keeps the existing name when a later observation has none', async () => {
    await upsertPlayerProfiles(INSTANCE_A, [{ kuId: 'KU_alpha01', name: '' }])
    const profiles = await listPlayerProfiles(INSTANCE_A)
    assert.equal(profiles[0].name, 'Wilson')
  })

  it('updates the name when the player renamed themselves', async () => {
    await upsertPlayerProfiles(INSTANCE_A, [{ kuId: 'KU_alpha01', name: 'Wilson Reborn' }])
    const profiles = await listPlayerProfiles(INSTANCE_A)
    assert.equal(profiles[0].name, 'Wilson Reborn')
  })

  it('searches by name and by id regardless of case', async () => {
    await upsertPlayerProfiles(INSTANCE_A, [
      { kuId: 'KU_beta02', name: 'Willow' },
      { kuId: 'KU_gamma03', name: 'Wendy' },
    ])
    const byName = await listPlayerProfiles(INSTANCE_A, { keyword: 'will' })
    assert.deepEqual(byName.map(item => item.kuId), ['KU_beta02'])
    const byId = await listPlayerProfiles(INSTANCE_A, { keyword: 'ku_gamma' })
    assert.deepEqual(byId.map(item => item.kuId), ['KU_gamma03'])
  })

  it('treats wildcard characters as literal text in the keyword', async () => {
    await upsertPlayerProfiles(INSTANCE_A, [{ kuId: 'KU_delta04', name: '100% pro' }])
    const percent = await listPlayerProfiles(INSTANCE_A, { keyword: '100%' })
    assert.deepEqual(percent.map(item => item.kuId), ['KU_delta04'])
    // `%` 若被当成通配符，这次查询会把所有人都捞出来
    const wildcardOnly = await listPlayerProfiles(INSTANCE_A, { keyword: '%' })
    assert.deepEqual(wildcardOnly.map(item => item.kuId), ['KU_delta04'])
  })

  it('finds profiles by ku ids ignoring case', async () => {
    const found = await findPlayerProfilesByKuIds(INSTANCE_A, ['ku_beta02', 'KU_MISSING'])
    assert.equal(found.get('ku_beta02')?.name, 'Willow')
    assert.equal(found.has('ku_missing'), false)
  })

  it('stores a manual note without touching the recorded name', async () => {
    const updated = await setPlayerProfileNote(INSTANCE_A, 'KU_beta02', '常驻服主的小号')
    assert.equal(updated?.note, '常驻服主的小号')
    assert.equal(updated?.name, 'Willow')

    const cleared = await setPlayerProfileNote(INSTANCE_A, 'KU_beta02', '')
    assert.equal(cleared?.note, '')
  })

  it('creates a profile on the fly when only an id is known', async () => {
    const created = await setPlayerProfileNote(INSTANCE_A, 'KU_unknown9', '待确认是谁')
    assert.equal(created?.name, '')
    assert.equal(created?.note, '待确认是谁')
  })

  it('keeps profiles of different instances apart', async () => {
    await upsertPlayerProfiles(INSTANCE_B, [{ kuId: 'KU_alpha01', name: 'Someone Else' }])
    const a = await listPlayerProfiles(INSTANCE_A)
    const b = await listPlayerProfiles(INSTANCE_B)
    assert.equal(a.find(item => item.kuId === 'KU_alpha01')?.name, 'Wilson Reborn')
    assert.equal(b.find(item => item.kuId === 'KU_alpha01')?.name, 'Someone Else')
  })

  it('removes every profile of one instance on delete', async () => {
    const removed = await removePlayerProfilesByInstance(INSTANCE_B)
    assert.equal(removed, 1)
    assert.deepEqual(await listPlayerProfiles(INSTANCE_B), [])
    assert.ok((await listPlayerProfiles(INSTANCE_A)).length > 0)
  })
})
