import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { after, before, it } from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import Fastify from 'fastify'
import { registerAuthModule } from '../auth/index'
import { registerModImportRoutes } from './mod-import-routes'
import { commitLocalMod, discardLocalMod, inspectLocalMod, resolveModImportRoot } from './mod-import-service'
import { closeDatabase, initDatabase, createGameInstance, listInstanceMods, updateInstanceModByWorkshopId, updateGameInstanceRuntime, addUserInstanceGrants, findUserByAccount } from '../../shared/db/index'
import { ensureDb } from '../../shared/db/connection'
import { resolveDstSteamWorkshopModDir } from '../../infra/game-adapter/dst/constants'
import { ensureDstUgcModLayout, resolveDstUgcModDir, resolveDstLegacyModDir } from '../../infra/game-adapter/dst/ugc-mod-install'
import { resolveLocalModContentVersion } from '../../infra/game-adapter/dst/mod-content-version'
import { beginInstanceContentActivity, withInstanceContentOperation } from '../../shared/instance-content/operation'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-local-mod-test-'))
const install = path.join(root, 'instance')
const id = 'local-import-test'
const owner = 'owner'
const oldFetch = globalThis.fetch
let fetchCount = 0
before(async () => {
  process.env.GSH_MOD_IMPORT_ROOT = path.join(root, 'uploads')
  fs.mkdirSync(path.join(install, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1', 'Master'), { recursive: true })
  await initDatabase(path.join(root, 'db.sqlite'), path.resolve('server/drizzle'), { adminUsername: 'superadmin', adminPassword: '123456', seedDevelopmentUsers: false })
  await createGameInstance({ id, nodeId: 'local-node', name: 'Local import', gameCode: '343050', status: 'stopped', installPath: install })
  globalThis.fetch = (() => { fetchCount++; throw new Error('network forbidden') }) as typeof fetch
})
after(() => { globalThis.fetch = oldFetch; closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); delete process.env.GSH_MOD_IMPORT_ROOT })
function zip(entries: Record<string, string>) { return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, strToU8(value)])))) }
const content = (version: string) => ({ 'modinfo.lua': `name = "Offline Mod"\nversion = "${version}"\n`, 'modmain.lua': `-- ${version}` })
const inspect = (data: Buffer, name = '123.zip') => inspectLocalMod(Readable.from([data]), id, owner, name)

it('authenticates before creating upload directories', async () => {
  const app = Fastify()
  registerAuthModule(app)
  registerModImportRoutes(app, async () => null)
  const response = await app.inject({ method: 'POST', url: `/app/instances/${id}/mods/import/inspect`, headers: { 'content-type': 'application/x-gsh-mod-archive' }, payload: zip(content('1')) })
  assert.equal(response.statusCode, 403)
  assert.equal(fs.existsSync(resolveModImportRoot()), false)
  const admin = await findUserByAccount('superadmin')
  await addUserInstanceGrants(admin!.id, [id], null)
  const login = await app.inject({ method: 'POST', url: '/app/account/login', payload: { account: 'superadmin', password: '123456' } })
  const token = JSON.parse(login.body).data.token
  const authorized = await app.inject({ method: 'POST', url: `/app/instances/${id}/mods/import/inspect?fileName=777.zip`, headers: { token, 'content-type': 'application/x-gsh-mod-archive' }, payload: zip(content('1')) })
  assert.equal(JSON.parse(authorized.body).status, 1, authorized.body)
  const preview = JSON.parse(authorized.body).data
  assert.equal(preview.workshopId, '777')
  await app.close()
})

it('installs offline into canonical/UGC/loading directories, disables new mods and consumes preview', async () => {
  const preview = await inspect(zip(content('1')))
  assert.equal(preview.name, 'Offline Mod')
  assert.equal(preview.version, '1')
  const record = await commitLocalMod({ importId: preview.importId, workshopId: '123', overwrite: false }, id, owner, install)
  assert.equal(record.enabled, false)
  assert.equal(record.installStatus, 'ready')
  assert.equal(record.contentSource, 'local')
  for (const dir of [resolveDstSteamWorkshopModDir(install, '123'), resolveDstUgcModDir(install, 'Master', '123'), resolveDstLegacyModDir(install, '123')]) assert.equal(fs.readFileSync(path.join(dir, 'modmain.lua'), 'utf8'), '-- 1')
  assert.equal((await listInstanceMods(id))[0]!.contentSource, 'local')
  await assert.rejects(commitLocalMod({ importId: preview.importId, workshopId: '123', overwrite: true }, id, owner, install), /过期|消费/)
  assert.equal(fetchCount, 0)
})

it('requires explicit overwrite and preserves enabled/order/config; stale Steam manifest does not give a version', async () => {
  await updateInstanceModByWorkshopId(id, '123', { enabled: true, loadOrder: 7, config: '{"choice":"old"}' })
  const acf = path.join(install, 'steamapps', 'workshop', 'appworkshop_322330.acf')
  fs.mkdirSync(path.dirname(acf), { recursive: true })
  fs.writeFileSync(acf, '"AppWorkshop" { "WorkshopItemsInstalled" { "123" { "timeupdated" "1750000000" } } }')
  const preview = await inspect(zip(content('2')))
  const inactiveCaves = resolveDstUgcModDir(install, 'Caves', '123')
  fs.mkdirSync(inactiveCaves, { recursive: true })
  fs.writeFileSync(path.join(inactiveCaves, 'modinfo.lua'), 'name="old inactive copy"')
  await assert.rejects(commitLocalMod({ importId: preview.importId, workshopId: '123', overwrite: false }, id, owner, install), /明确选择覆盖/)
  const record = await commitLocalMod({ importId: preview.importId, workshopId: '123', overwrite: true }, id, owner, install)
  assert.equal(record.enabled, true)
  assert.equal(record.loadOrder, 7)
  assert.equal(record.config, '{"choice":"old"}')
  assert.equal(fs.existsSync(inactiveCaves), false)
  assert.equal(resolveLocalModContentVersion(install, '123', { contentSource: record.contentSource }).updatedAt, null)
  assert.equal(fetchCount, 0)
})

it('rejects another owner/instance, expiration, running commit and concurrent activities', async () => {
  const preview = await inspect(zip(content('3')))
  const input = { importId: preview.importId, workshopId: '123', overwrite: true }
  await assert.rejects(commitLocalMod(input, id, 'other-owner', install), /不属于/)
  assert.throws(() => discardLocalMod(preview.importId, owner, 'other-instance'), /不属于/)
  await updateGameInstanceRuntime(id, { status: 'running' })
  await assert.rejects(commitLocalMod(input, id, owner, install), /先停止/)
  await updateGameInstanceRuntime(id, { status: 'stopped' })
  const release = beginInstanceContentActivity(id)
  try { await assert.rejects(commitLocalMod(input, id, owner, install), /正在执行/) } finally { release() }
  let unblock!: () => void
  const operation = withInstanceContentOperation(id, () => new Promise<void>(resolve => unblock = resolve))
  try { assert.throws(() => beginInstanceContentActivity(id), /正在执行/) } finally { unblock(); await operation }
  const recordFile = path.join(resolveModImportRoot(), preview.importId, 'record.json')
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
  fs.writeFileSync(recordFile, JSON.stringify({ ...record, createdAt: Date.now() - 3_600_001 }))
  await assert.rejects(commitLocalMod(input, id, owner, install), /过期/)
})

it('offers manual ID for conflicts and rejects multiple roots or arbitrary nesting', async () => {
  const one = content('1')
  const wrapped = Object.fromEntries(Object.entries(one).map(([file, value]) => [`workshop-456/${file}`, value]))
  const preview = await inspect(zip(wrapped), '789.zip')
  assert.equal(preview.workshopId, null)
  assert.equal(preview.idCandidates.length, 2)
  await commitLocalMod({ importId: preview.importId, workshopId: '456', overwrite: false }, id, owner, install)
  await assert.rejects(inspect(zip({ 'a/modinfo.lua': 'name="a"', 'b/modinfo.lua': 'name="b"' })), /一个 Mod/)
  await assert.rejects(inspect(zip({ 'a/b/modinfo.lua': 'name="a"' })), /一个 Mod/)
})

it('rolls files, Lua and DB back when configuration write fails after replacement', async () => {
  const before = (await listInstanceMods(id)).find(mod => mod.workshopId === '123')!
  const preview = await inspect(zip(content('failure')))
  const write = fs.writeFileSync
  let injected = false
  fs.writeFileSync = ((file, ...args: unknown[]) => {
    if (!injected && String(file).includes('dedicated_server_mods_setup.lua.tmp')) { injected = true; throw new Error('injected writer failure') }
    return (write as (...args: unknown[]) => void)(file, ...args)
  }) as typeof fs.writeFileSync
  try { await assert.rejects(commitLocalMod({ importId: preview.importId, workshopId: '123', overwrite: true }, id, owner, install), /injected writer/) }
  finally { fs.writeFileSync = write }
  assert.deepEqual((await listInstanceMods(id)).find(mod => mod.workshopId === '123'), before)
  assert.equal(fs.readFileSync(path.join(resolveDstLegacyModDir(install, '123'), 'modmain.lua'), 'utf8'), '-- 2')
  assert.equal(fs.existsSync(path.join(install, '.gsh-content-transaction')), false)
})

it('restores all files and the old source record when the short DB commit fails', async () => {
  const before = await listInstanceMods(id)
  const preview = await inspect(zip(content('db failure')))
  const db = ensureDb().sqliteDb
  const exec = db.exec
  let injected = false
  db.exec = (sql: string) => {
    if (!injected && sql === 'RELEASE gsh_content_mods') { injected = true; throw new Error('injected database commit failure') }
    exec.call(db, sql)
  }
  try { await assert.rejects(commitLocalMod({ importId: preview.importId, workshopId: '123', overwrite: true }, id, owner, install), /injected database/) }
  finally { db.exec = exec }
  assert.deepEqual(await listInstanceMods(id), before)
  assert.equal(fs.readFileSync(path.join(resolveDstLegacyModDir(install, '123'), 'modmain.lua'), 'utf8'), '-- 2')
})

it('builds new caves content from the imported canonical source without a download', async () => {
  const caves = path.join(install, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1', 'Caves')
  fs.mkdirSync(caves, { recursive: true })
  fs.writeFileSync(path.join(caves, 'server.ini'), '[SHARD]\nis_master=false\n')
  const outcomes = await ensureDstUgcModLayout(install, ['123'])
  assert.equal(outcomes[0]?.status, 'installed')
  assert.equal(fs.readFileSync(path.join(resolveDstUgcModDir(install, 'Caves', '123'), 'modmain.lua'), 'utf8'), '-- 2')
  assert.equal(fetchCount, 0)
})
