import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, before, it } from 'node:test'
import type { MigrationMod } from '../../../../shared/contracts/migration'
import { inspectMigrationContents, readMigrationBundle, writeMigrationBundle } from '../../infra/game-adapter/dst/migration-bundle'
import { sha256File, inspectContentTree } from '../../infra/game-adapter/dst/mod-content'
import { extractArchive } from '../../infra/backup/archive'
import { importSaveToInstance } from './import-service'
import { closeDatabase, initDatabase, createGameInstance, listInstanceMods, upsertInstanceMod, getGameInstanceById } from '../../shared/db/index'
import { resolveDstSteamWorkshopModDir } from '../../infra/game-adapter/dst/constants'
import { resolveDstLegacyModDir } from '../../infra/game-adapter/dst/ugc-mod-install'
import { setModDownloadExecutorForTest, resetModDownloadExecutorForTest } from '../mod/mod-download-service'
import { beginContentTransaction } from '../../shared/instance-content/state'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-migration-bundle-'))
const source = path.join(root, 'source', 'Cluster_7')
const modsSource = path.join(root, 'mods-source')
const oldFetch = globalThis.fetch
let networkCalls = 0
let seq = 0
const mod = (id: string, enabled: boolean, dependencies: string[] = []): MigrationMod => ({ workshopId: id, name: `Mod ${id}`, enabled, loadOrder: 0, configurationOptions: { option: 'kept' }, dependencyIds: dependencies, version: 'v1', localUpdatedAt: '2025-01-01T00:00:00.000Z', content: null })
before(async () => {
  process.env.GSH_BACKUPS_ROOT = path.join(root, 'backups')
  process.env.GSH_MOD_DOWNLOAD_AUTO_START = '1'
  await initDatabase(path.join(root, 'db.sqlite'), path.resolve('server/drizzle'), { adminUsername: 'superadmin', adminPassword: '123456', seedDevelopmentUsers: false })
  fs.mkdirSync(path.join(source, 'Master', 'save'), { recursive: true })
  fs.writeFileSync(path.join(source, 'cluster.ini'), '[NETWORK]\ncluster_name = Bundle\n[SHARD]\nshard_enabled = false\n')
  fs.writeFileSync(path.join(source, 'Master', 'server.ini'), '[NETWORK]\nserver_port = 27015\n[SHARD]\nis_master = true\n')
  fs.writeFileSync(path.join(source, 'Master', 'worldgenoverride.lua'), 'return { preset = "SURVIVAL_TOGETHER" }')
  fs.writeFileSync(path.join(source, 'Master', 'save', 'world'), 'source world')
  fs.writeFileSync(path.join(source, 'Master', 'modoverrides.lua'), 'return { ["workshop-100"]={enabled=true,configuration_options={option="kept"}},["workshop-300"]={enabled=false} }')
  for (const id of ['100', '200']) {
    fs.mkdirSync(path.join(modsSource, id), { recursive: true })
    fs.writeFileSync(path.join(modsSource, id, 'modinfo.lua'), `name="Mod ${id}"\nversion="v1"\n${id === '100' ? 'mod_dependencies = { { workshop = "200" } }' : ''}`)
    fs.writeFileSync(path.join(modsSource, id, 'modmain.lua'), `-- bundle ${id}`)
  }
  globalThis.fetch = (() => { networkCalls++; throw new Error('network forbidden') }) as typeof fetch
  setModDownloadExecutorForTest(async () => { networkCalls++; throw new Error('SteamCMD forbidden') })
})
after(() => {
  globalThis.fetch = oldFetch
  resetModDownloadExecutorForTest()
  closeDatabase()
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.GSH_BACKUPS_ROOT
  delete process.env.GSH_MOD_DOWNLOAD_AUTO_START
})
const inspect = () => inspectMigrationContents([mod('100', true, ['200']), mod('300', false)], true, async id => fs.existsSync(path.join(modsSource, id)) ? path.join(modsSource, id) : null)
async function createTarget() {
  const installPath = path.join(root, `target-${seq++}`)
  fs.mkdirSync(path.join(installPath, 'bin64'), { recursive: true })
  fs.writeFileSync(path.join(installPath, 'bin64', 'dontstarve_dedicated_server_nullrenderer_x64'), 'binary')
  return createGameInstance({ nodeId: 'local-node', name: 'Target', gameCode: '343050', status: 'stopped', installPath, gamePort: 10999 })
}
async function prepareBundle() {
  const archive = path.join(root, `bundle-${seq++}.tar.gz`)
  await writeMigrationBundle({ clusterPath: source, archivePath: archive, reportText: 'offline bundle', inspected: await inspect(), includeMods: true })
  const extracted = path.join(root, `extracted-${seq++}`)
  await extractArchive(archive, extracted)
  return path.join(extracted, 'Cluster_7')
}

it('requires enabled/dependency content but permits missing disabled metadata', async () => {
  const inspected = await inspect()
  assert.equal(inspected.summary.canExport, true)
  assert.equal(inspected.summary.includedModCount, 2)
  assert.deepEqual(inspected.summary.missingOptionalMods, ['300'])
  const absent = await inspectMigrationContents([mod('100', true, ['200'])], true, async id => id === '100' ? path.join(modsSource, id) : null)
  assert.equal(absent.summary.canExport, false)
  assert.deepEqual(absent.summary.missingRequiredMods, ['200'])
})
it('restores a complete bundle offline and replaces target IDs even when already ready', async () => {
  const cluster = await prepareBundle()
  const target = await createTarget()
  const old = resolveDstSteamWorkshopModDir(target.installPath!, '100')
  fs.mkdirSync(old, { recursive: true })
  fs.writeFileSync(path.join(old, 'modinfo.lua'), 'name="old"')
  await upsertInstanceMod({ instanceId: target.id, workshopId: '100', name: 'old', enabled: false, loadOrder: 0, version: null, installStatus: 'ready' })
  const result = await importSaveToInstance({ instanceId: target.id, sourceClusterPath: cluster })
  assert.equal(result.ok, true, result.message)
  const records = await listInstanceMods(target.id)
  assert.equal(records.length, 3)
  assert.equal(records.find(item => item.workshopId === '100')?.enabled, true)
  assert.equal(records.find(item => item.workshopId === '300')?.installStatus, 'pending')
  assert.equal(records.find(item => item.workshopId === '100')?.contentSource, 'migration')
  assert.equal(records.find(item => item.workshopId === '100')?.localUpdatedAt, '2025-01-01T00:00:00.000Z')
  assert.equal(fs.readFileSync(path.join(resolveDstLegacyModDir(target.installPath!, '100'), 'modmain.lua'), 'utf8'), '-- bundle 100')
  assert.equal(networkCalls, 0)
})
it('rejects damaged hashes and unknown manifests instead of importing as an ordinary save', async () => {
  const cluster = await prepareBundle()
  const bundle = (await readMigrationBundle(cluster))!
  fs.appendFileSync(path.join(bundle.modRoot, '100', 'modmain.lua'), 'damaged')
  await assert.rejects(readMigrationBundle(cluster), /完整性/)
  const target = await createTarget()
  assert.equal((await importSaveToInstance({ instanceId: target.id, sourceClusterPath: cluster })).ok, false)
  const file = path.join(path.dirname(bundle.modRoot), 'manifest.json')
  fs.writeFileSync(file, JSON.stringify({ ...bundle.manifest, formatVersion: 99 }))
  await assert.rejects(readMigrationBundle(cluster), /格式不兼容/)
  assert.equal((await listInstanceMods(target.id)).length, 0)
})
it('keeps all old world/mod/DB state on a multi-Mod configuration failure', async () => {
  const cluster = await prepareBundle()
  const target = await createTarget()
  const oldCluster = path.join(target.installPath!, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1')
  fs.mkdirSync(path.join(oldCluster, 'Master', 'save'), { recursive: true })
  fs.writeFileSync(path.join(oldCluster, 'Master', 'save', 'old'), 'old world')
  const old = resolveDstSteamWorkshopModDir(target.installPath!, '100')
  fs.mkdirSync(old, { recursive: true })
  fs.writeFileSync(path.join(old, 'modinfo.lua'), 'name="old"')
  await upsertInstanceMod({ instanceId: target.id, workshopId: '100', name: 'old', enabled: false, loadOrder: 0, version: null, installStatus: 'ready' })
  const before = await listInstanceMods(target.id)
  const write = fs.writeFileSync
  let injected = false
  fs.writeFileSync = ((file, ...args: unknown[]) => {
    if (!injected && String(file).includes('dedicated_server_mods_setup.lua.tmp')) { injected = true; throw new Error('injected migration config failure') }
    return (write as (...args: unknown[]) => void)(file, ...args)
  }) as typeof fs.writeFileSync
  try {
    const result = await importSaveToInstance({ instanceId: target.id, sourceClusterPath: cluster })
    assert.equal(result.ok, false)
    assert.match(result.message!, /injected migration config/)
  }
  finally { fs.writeFileSync = write }
  assert.deepEqual(await listInstanceMods(target.id), before)
  assert.equal(fs.readFileSync(path.join(oldCluster, 'Master', 'save', 'old'), 'utf8'), 'old world')
  assert.equal(fs.readFileSync(path.join(old, 'modinfo.lua'), 'utf8'), 'name="old"')
  assert.equal(fs.existsSync(resolveDstSteamWorkshopModDir(target.installPath!, '200')), false)
})
it('replays a DB snapshot during database initialization before readiness synchronization', async () => {
  const target = await createTarget()
  const transaction = await beginContentTransaction(target.id, target.installPath!)
  await upsertInstanceMod({ instanceId: target.id, workshopId: '999', name: 'uncommitted', enabled: false, loadOrder: 0, version: null, installStatus: 'ready' })
  assert.equal((await listInstanceMods(target.id)).length, 1)
  closeDatabase()
  await initDatabase(path.join(root, 'db.sqlite'), path.resolve('server/drizzle'), { seedDevelopmentUsers: false })
  assert.equal((await listInstanceMods(target.id)).length, 0)
  assert.equal(fs.existsSync(transaction.root), false)
  assert.equal((await getGameInstanceById(target.id))?.status, 'stopped')
})
it('CLI full exports share the manifest/hash format and reject duplicate sources', async () => {
  const out = path.join(root, 'cli-out')
  const command = [path.resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/export-cluster-archive.ts', '--source', source, '--out', out, '--include-mods', '--mods-source', modsSource]
  const result = spawnSync(process.execPath, command, { encoding: 'utf8', env: process.env, windowsHide: true })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const archive = path.join(out, fs.readdirSync(out).find(file => file.endsWith('.tar.gz'))!)
  assert.match(await sha256File(archive), /^[0-9a-f]{64}$/)
  const extracted = path.join(root, 'cli-extracted')
  await extractArchive(archive, extracted)
  const bundle = (await readMigrationBundle(path.join(extracted, 'Cluster_7')))!
  assert.equal(bundle.manifest.mods.find(item => item.workshopId === '300')?.content, null)
  const tree = await inspectContentTree(path.join(modsSource, '100'))
  assert.equal(bundle.manifest.mods.find(item => item.workshopId === '100')?.content?.sha256, tree.sha256)
  const target = await createTarget()
  assert.equal((await importSaveToInstance({ instanceId: target.id, sourceClusterPath: path.join(extracted, 'Cluster_7') })).ok, true)
  await fs.promises.cp(path.join(modsSource, '100'), path.join(modsSource, 'workshop-100'), { recursive: true })
  const duplicate = spawnSync(process.execPath, command, { encoding: 'utf8', env: process.env, windowsHide: true })
  assert.equal(duplicate.status, 1)
  assert.match(duplicate.stderr, /两份来源/)
})
