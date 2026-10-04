import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { after, before, it } from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import Fastify from 'fastify'
import { registerAuthModule } from '../auth/index'
import { registerModImportRoutes } from './mod-import-routes'
import { commitLocalMod, commitLocalMods, discardLocalMod, inspectLocalMod, resolveModImportRoot } from './mod-import-service'
import type { ModImportInspection } from '../../../../shared/contracts/mod'
import { ErrorCode } from '../../../../shared/constants/error-code'
import { ContentTransaction } from '../../infra/backup/content-transaction'
import { recoverInstanceContentOperations } from '../../shared/instance-content/state'
import { closeDatabase, initDatabase, createGameInstance, listInstanceMods, updateInstanceModByWorkshopId, updateGameInstanceRuntime, addUserInstanceGrants, findUserByAccount, createUserRecord, replaceUserPermissions } from '../../shared/db/index'
import { ensureDb, hashPassword } from '../../shared/db/connection'
import { resolveDstSteamWorkshopModDir } from '../../infra/game-adapter/dst/constants'
import { ensureDstUgcModLayout, resolveDstUgcModDir, resolveDstLegacyModDir } from '../../infra/game-adapter/dst/ugc-mod-install'
import { resolveLocalModContentVersion } from '../../infra/game-adapter/dst/mod-content-version'
import { beginInstanceContentActivity, hasContentRecoveryFailure, withInstanceContentOperation } from '../../shared/instance-content/operation'

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
function batchZip(ids: string[], version = 'batch') {
  return zip(Object.fromEntries(ids.flatMap(workshopId => Object.entries(content(version)).map(([file, value]) => [`mods/workshop-${workshopId}/${file}`, value]))))
}
const batchInput = (preview: ModImportInspection, overwrite = false) => ({
  importId: preview.importId, items: preview.items.map(item => ({ itemId: item.itemId, workshopId: item.workshopId! })), overwrite,
})

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
  await updateInstanceModByWorkshopId(id, '123', { enabled: true, loadOrder: 7, config: '{"choice":"old"}', downloadIntent: 'update' })
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
  assert.equal(record.downloadIntent, null)
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

it('offers manual IDs, supports wrapper directories and rejects overlapping Mod roots', async () => {
  const one = content('1')
  const wrapped = Object.fromEntries(Object.entries(one).map(([file, value]) => [`workshop-456/${file}`, value]))
  const preview = await inspect(zip(wrapped), '789.zip')
  assert.equal(preview.workshopId, null)
  assert.equal(preview.idCandidates.length, 2)
  await commitLocalMod({ importId: preview.importId, workshopId: '456', overwrite: false }, id, owner, install)
  const manual = await inspect(zip({ 'a/modinfo.lua': 'name="a"', 'b/modinfo.lua': 'name="b"' }))
  assert.equal(manual.items.length, 2)
  assert.deepEqual(manual.items.map(item => item.workshopId), [null, null], 'batch never applies ZIP filename ID to every Mod')
  const nested = await inspect(zip({ 'a/b/modinfo.lua': 'name="a"' }), 'wrapper.zip')
  assert.equal(nested.items[0]!.directory, 'a/b')
  await assert.rejects(inspect(zip({ 'a/modinfo.lua': 'name="a"', 'a/b/modinfo.lua': 'name="b"' })), /嵌套冲突.*a.*a\/b/)
  await assert.rejects(inspect(zip({ 'readme.txt': 'no mod' })), /未找到 Mod/)
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

it('installs 30 Mods offline, preserves unrelated records and applies limits to the whole ZIP', async () => {
  const ids = Array.from({ length: 30 }, (_, index) => String(1000 + index))
  const before = await listInstanceMods(id)
  const preview = await inspect(batchZip(ids), 'all-mods.zip')
  assert.deepEqual(preview.items.map(item => item.workshopId), ids)
  const result = await commitLocalMods(batchInput(preview), id, owner, install)
  assert.deepEqual(result.summary, { installed: 30, failed: 0, remaining: 0 })
  assert.equal(result.retryBlocked, false)
  assert.equal(result.installedMods.every(mod => !mod.enabled && mod.installStatus === 'ready'), true)
  assert.deepEqual((await listInstanceMods(id)).filter(mod => !ids.includes(mod.workshopId)), before)
  assert.equal(result.installedMods[29]!.loadOrder - result.installedMods[0]!.loadOrder, 29)
  for (const workshopId of ids) assert.equal(fs.readFileSync(path.join(resolveDstSteamWorkshopModDir(install, workshopId), 'modmain.lua'), 'utf8'), '-- batch')
  assert.equal(fetchCount, 0)
  const limit = process.env.GSH_MOD_IMPORT_MAX_FILES
  process.env.GSH_MOD_IMPORT_MAX_FILES = '3'
  try { await assert.rejects(inspect(batchZip(['1100', '1101'])), /条目数超过上限/) }
  finally { if (limit === undefined) delete process.env.GSH_MOD_IMPORT_MAX_FILES; else process.env.GSH_MOD_IMPORT_MAX_FILES = limit }
  const byteLimit = process.env.GSH_MOD_IMPORT_MAX_EXTRACTED_BYTES
  process.env.GSH_MOD_IMPORT_MAX_EXTRACTED_BYTES = '60'
  try { await assert.rejects(inspect(batchZip(['1100', '1101'])), /大小超过上限/) }
  finally { if (byteLimit === undefined) delete process.env.GSH_MOD_IMPORT_MAX_EXTRACTED_BYTES; else process.env.GSH_MOD_IMPORT_MAX_EXTRACTED_BYTES = byteLimit }
})

it('validates the entire batch before writes and requires one explicit overwrite confirmation', async () => {
  const before = await listInstanceMods(id)
  const preview = await inspect(batchZip(['123', '1200']), 'package.zip')
  const input = batchInput(preview)
  await assert.rejects(commitLocalMod({ importId: preview.importId, workshopId: '1200', overwrite: false }, id, owner, install), /批量导入/)
  await assert.rejects(commitLocalMods(input, id, owner, install), /明确选择覆盖/)
  await assert.rejects(commitLocalMods({ ...input, items: input.items.map(item => ({ ...item, workshopId: '1200' })), overwrite: true }, id, owner, install), /ID 重复/)
  await assert.rejects(commitLocalMods({ ...input, items: [{ ...input.items[0]!, itemId: randomUUID() }, input.items[1]!], overwrite: true }, id, owner, install), /条目无效/)
  await assert.rejects(commitLocalMods({ ...input, items: [{ ...input.items[0]!, workshopId: '99999999999' }, input.items[1]!], overwrite: true }, id, owner, install), /保留 ID/)
  await assert.rejects(commitLocalMods({ ...input, items: [{ ...input.items[0]!, workshopId: 'invalid' }, input.items[1]!], overwrite: true }, id, owner, install), /正整数字符串/)
  assert.deepEqual(await listInstanceMods(id), before)
  const result = await commitLocalMods({ ...input, overwrite: true }, id, owner, install)
  const previous = before.find(mod => mod.workshopId === '123')!
  const replaced = result.installedMods.find(mod => mod.workshopId === '123')!
  assert.equal(replaced.enabled, previous.enabled)
  assert.equal(replaced.config, previous.config)
  assert.equal(replaced.loadOrder, previous.loadOrder)
  assert.equal(result.installedMods.find(mod => mod.workshopId === '1200')!.enabled, false)
  const changed = await inspect(batchZip(['1201', '1202']), 'changed.zip')
  fs.writeFileSync(path.join(resolveModImportRoot(), changed.importId, 'extract', 'mods', 'workshop-1202', 'modmain.lua'), 'changed')
  const after = await listInstanceMods(id)
  await assert.rejects(commitLocalMods(batchInput(changed), id, owner, install), /内容发生变化/)
  assert.deepEqual(await listInstanceMods(id), after)
})

for (const failure of ['files', 'config', 'database'] as const) {
  it(`keeps successes and retries only the failed Mod after ${failure} failure`, async () => {
    const ids = failure === 'files' ? ['1300', '1301', '1302'] : failure === 'config' ? ['1310', '1311', '1312'] : ['1320', '1321', '1322']
    // 中间项已存在，回滚必须恢复其旧内容、配置与下载意图。
    const old = await inspect(batchZip([ids[1]!], 'old'), 'old.zip')
    await commitLocalMod({ importId: old.importId, workshopId: ids[1]!, overwrite: false }, id, owner, install)
    await updateInstanceModByWorkshopId(id, ids[1]!, { enabled: true, config: '{"keep":true}', downloadIntent: 'update' })
    const previous = (await listInstanceMods(id)).find(mod => mod.workshopId === ids[1])!
    const preview = await inspect(batchZip(ids, 'new'), 'new.zip')
    const input = batchInput(preview, true)
    const cp = fs.promises.cp
    const write = fs.writeFileSync
    const db = ensureDb().sqliteDb
    const exec = db.exec
    let injected = false
    let releases = 0
    if (failure === 'files') {
      fs.promises.cp = (async (source, target, options) => {
        if (!injected && String(source).endsWith(`workshop-${ids[1]}`)) { injected = true; throw new Error('injected files failure') }
        return cp(source, target, options)
      }) as typeof fs.promises.cp
    }
    if (failure === 'config') {
      fs.writeFileSync = ((file, ...args: unknown[]) => {
        if (!injected && String(file).includes('dedicated_server_mods_setup.lua.tmp')
          && fs.readFileSync(path.join(resolveDstSteamWorkshopModDir(install, ids[1]!), 'modmain.lua'), 'utf8') === '-- new') {
          injected = true; throw new Error('injected config failure')
        }
        return (write as (...args: unknown[]) => void)(file, ...args)
      }) as typeof fs.writeFileSync
    }
    if (failure === 'database') db.exec = (sql: string) => {
      if (sql === 'RELEASE gsh_content_mods' && ++releases === 2) { injected = true; throw new Error('injected database failure') }
      exec.call(db, sql)
    }
    let result: Awaited<ReturnType<typeof commitLocalMods>>
    try { result = await commitLocalMods(input, id, owner, install) }
    finally { fs.promises.cp = cp; fs.writeFileSync = write; db.exec = exec }
    assert.equal(injected, true)
    assert.deepEqual(result!.results.map(item => item.status), ['installed', 'failed', 'installed'])
    assert.deepEqual(result!.summary, { installed: 2, failed: 1, remaining: 1 })
    assert.deepEqual((await listInstanceMods(id)).find(mod => mod.workshopId === ids[1]), previous)
    assert.equal(fs.readFileSync(path.join(resolveDstSteamWorkshopModDir(install, ids[1]!), 'modmain.lua'), 'utf8'), '-- old')
    const successes = (await listInstanceMods(id)).filter(mod => [ids[0], ids[2]].includes(mod.workshopId))
    const retried = await commitLocalMods({ ...input, items: [input.items[1]!] }, id, owner, install)
    assert.deepEqual(retried.summary, { installed: 3, failed: 0, remaining: 0 })
    assert.deepEqual((await listInstanceMods(id)).filter(mod => [ids[0], ids[2]].includes(mod.workshopId)), successes)
    const updated = (await listInstanceMods(id)).find(mod => mod.workshopId === ids[1])!
    assert.equal(updated.downloadIntent, null)
    assert.equal(updated.enabled, true)
    assert.equal(updated.config, previous.config)
    assert.equal(fetchCount, 0)
  })
}

it('stops after rollback failure and startup recovery preserves earlier successes', async () => {
  const preview = await inspect(batchZip(['1400', '1401', '1402']), 'recovery.zip')
  const cp = fs.promises.cp
  const rollback = ContentTransaction.prototype.rollback
  fs.promises.cp = (async (source, target, options) => {
    if (String(source).endsWith('workshop-1401')) throw new Error('injected prepare failure')
    return cp(source, target, options)
  }) as typeof fs.promises.cp
  ContentTransaction.prototype.rollback = () => { throw new Error('injected rollback failure') }
  try {
    const result = await commitLocalMods(batchInput(preview), id, owner, install)
    assert.deepEqual(result.results.map(item => item.status), ['installed', 'failed', 'not_processed'])
    assert.equal(result.retryBlocked, true)
    assert.equal(hasContentRecoveryFailure(id), true)
    assert.equal((await listInstanceMods(id)).some(mod => mod.workshopId === '1402'), false)
  }
  finally { fs.promises.cp = cp; ContentTransaction.prototype.rollback = rollback }
  await recoverInstanceContentOperations()
  assert.equal(hasContentRecoveryFailure(id), false)
  assert.equal((await listInstanceMods(id)).find(mod => mod.workshopId === '1400')!.installStatus, 'ready')
  assert.equal((await listInstanceMods(id)).some(mod => mod.workshopId === '1401'), false)
  await assert.rejects(commitLocalMods(batchInput(preview), id, owner, install), /未完成.*重新上传/)
})

it('batch routes check dependencies after all items and retain the legacy single response', async () => {
  const app = Fastify()
  registerAuthModule(app)
  registerModImportRoutes(app, async () => null)
  try {
    const login = await app.inject({ method: 'POST', url: '/app/account/login', payload: { account: 'superadmin', password: '123456' } })
    const token = JSON.parse(login.body).data.token
    const archive = zip({
      'workshop-1500/modinfo.lua': 'name="Parent"\ndependencies={"workshop-1501"}',
      'workshop-1501/modinfo.lua': 'name="Dependency"',
    })
    const inspected = await app.inject({ method: 'POST', url: `/app/instances/${id}/mods/import/inspect?fileName=deps.zip`,
      headers: { token, 'content-type': 'application/x-gsh-mod-archive' }, payload: archive })
    const preview = JSON.parse(inspected.body).data as ModImportInspection
    const committed = await app.inject({ method: 'POST', url: `/app/instances/${id}/mods/import/commit`, headers: { token }, payload: batchInput(preview) })
    const body = JSON.parse(committed.body)
    assert.equal(body.status, 1, committed.body)
    assert.equal(body.error, '', committed.body)
    assert.deepEqual(body.data.summary, { installed: 2, failed: 0, remaining: 0 })
    assert.equal(body.data.riskTip, null, 'dependency from the same ZIP is already installed')
    const legacyInspected = await app.inject({ method: 'POST', url: `/app/instances/${id}/mods/import/inspect?fileName=1502.zip`,
      headers: { token, 'content-type': 'application/x-gsh-mod-archive' }, payload: zip(content('legacy')) })
    const legacyPreview = JSON.parse(legacyInspected.body).data as ModImportInspection
    const legacy = await app.inject({ method: 'POST', url: `/app/instances/${id}/mods/import/commit`, headers: { token },
      payload: { importId: legacyPreview.importId, workshopId: '1502', overwrite: false } })
    assert.deepEqual(JSON.parse(legacy.body).data, { saved: true, riskTip: null, mod: null })
    assert.equal(fetchCount, 0)
  }
  finally { await app.close() }
})

it('rejects read-only and ungranted batch import requests without changing files or DB', async () => {
  for (const [userId, permissions, grant] of [['import-reader', ['mod:read'], true], ['import-ungranted', ['mod:install'], false]] as const) {
    await createUserRecord({ id: userId, account: userId, passwordHash: hashPassword('123456'), email: '', avatar: '', status: 1, mustChangePassword: false })
    await replaceUserPermissions(userId, permissions)
    if (grant) await addUserInstanceGrants(userId, [id], null)
  }
  const app = Fastify()
  registerAuthModule(app)
  registerModImportRoutes(app, async () => null)
  const preview = await inspect(batchZip(['1600', '1601']), 'permissions.zip')
  const before = await listInstanceMods(id)
  try {
    for (const userId of ['import-reader', 'import-ungranted']) {
      const login = await app.inject({ method: 'POST', url: '/app/account/login', payload: { account: userId, password: '123456' } })
      const token = JSON.parse(login.body).data.token
      const committed = await app.inject({ method: 'POST', url: `/app/instances/${id}/mods/import/commit`, headers: { token }, payload: batchInput(preview) })
      assert.equal(JSON.parse(committed.body).code, ErrorCode.FORBIDDEN)
      const uploaded = await app.inject({ method: 'POST', url: `/app/instances/${id}/mods/import/inspect`, headers: { token, 'content-type': 'application/x-gsh-mod-archive' }, payload: batchZip(['1600', '1601']) })
      assert.equal(uploaded.statusCode, 403)
    }
    assert.deepEqual(await listInstanceMods(id), before)
    assert.equal(fs.existsSync(resolveDstSteamWorkshopModDir(install, '1600')), false)
  }
  finally { await app.close() }
})
