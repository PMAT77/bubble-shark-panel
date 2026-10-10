/** Linux DST integration smoke. Requires an isolated game tree and an empty persistent root. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { buildMaintenanceProbe, parseMaintenanceProbe, buildSaveObserver, buildSnapshotRollbackCommand, type MaintenanceWorldProbe } from '../src/infra/game-adapter/dst/maintenance-probe'
import { buildServerIni } from '../src/infra/game-adapter/dst/server-ini'
import { buildWorldSeedModInfoContent, buildWorldSeedModWorldgenMainContent } from '../src/infra/game-adapter/dst/world-seed'

const game = process.env.BSP_SMOKE_GAME_ROOT!
const root = process.env.BSP_SMOKE_STATE_ROOT!
if (process.platform !== 'linux' || !game || !root || !path.isAbsolute(root)) throw new Error('Requires Linux and explicit isolated game/state paths')
fs.mkdirSync(root, { recursive: true })
if (fs.readdirSync(root).length) throw new Error('Smoke state root must be empty; never use an existing player world')
const cluster = path.join(root, 'DoNotStarveTogether', 'Smoke')
fs.mkdirSync(cluster, { recursive: true })
fs.writeFileSync(path.join(cluster, 'cluster.ini'), '[GAMEPLAY]\ngame_mode = survival\nmax_players = 2\npause_when_empty = false\n[NETWORK]\ncluster_name = BSP isolated smoke\ncluster_password = isolated\noffline_cluster = true\nlan_only_cluster = false\n[SHARD]\nshard_enabled = true\nbind_ip = 127.0.0.1\nmaster_ip = 127.0.0.1\nmaster_port = 11998\ncluster_key = isolated-world-maintenance-smoke\n[MISC]\nmax_snapshots = 6\n')
const helper = path.join(game, 'mods', 'workshop-99999999999')
fs.mkdirSync(helper, { recursive: true })
fs.writeFileSync(path.join(helper, 'modinfo.lua'), buildWorldSeedModInfoContent())
fs.writeFileSync(path.join(helper, 'modworldgenmain.lua'), buildWorldSeedModWorldgenMainContent())
fs.writeFileSync(path.join(game, 'mods', 'dedicated_server_mods_setup.lua'), '')
fs.writeFileSync(path.join(game, 'mods', 'modsettings.lua'), '')
type Shard = 'master' | 'caves'
const folder = (shard: Shard) => shard === 'master' ? 'Master' : 'Caves'
function setSeed(shard: Shard, seed: string | null) {
  fs.writeFileSync(path.join(cluster, folder(shard), 'modoverrides.lua'), seed === null ? 'return {}' : `return { ["workshop-99999999999"] = { enabled = true, configuration_options = { seed = "${seed}" } } }`)
}
for (const [shard, port, id] of [['master', 12001, 1], ['caves', 12002, 2]] as const) {
  const dir = path.join(cluster, folder(shard)); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'server.ini'), buildServerIni({isMaster: shard === 'master', shardName: folder(shard), serverPort: port, steamAuthPort: 12100 + id, steamMasterPort: 12200 + id}))
  fs.writeFileSync(path.join(dir, 'worldgenoverride.lua'), `return {override_enabled=true,preset="${shard === 'master' ? 'SURVIVAL_TOGETHER' : 'DST_CAVE'}",overrides={world_size="small"}}`)
  setSeed(shard, shard === 'master' ? '123456' : '654321')
}
const output: Record<Shard, string[]> = { master: [], caves: [] }
const children: Partial<Record<Shard, ChildProcessWithoutNullStreams>> = {}
let live = true
function launch(shard: Shard) {
  const child = spawn(path.join(game, 'bin64', 'dontstarve_dedicated_server_nullrenderer_x64'), ['-console', '-bind_ip', shard === 'master' ? '127.0.0.1' : '127.0.0.2', '-port', shard === 'master' ? '12001' : '12002', '-persistent_storage_root', root, '-conf_dir', 'DoNotStarveTogether', '-cluster', 'Smoke', '-shard', folder(shard), '-ugc_directory', path.join(root, 'ugc', folder(shard))], { cwd: path.join(game, 'bin64'), stdio: 'pipe' })
  children[shard] = child
  let pending = ''
  const append = (chunk: Buffer) => {
    pending += chunk.toString()
    const lines = pending.split('\n'); pending = lines.pop() ?? ''
    for (const line of lines) { output[shard].push(line); fs.appendFileSync(path.join(root, `${shard}.log`), `${line}\n`) }
  }
  child.stdout.on('data', append); child.stderr.on('data', append)
  child.on('exit', () => { if (children[shard] === child) delete children[shard]; if (live) setTimeout(() => { if (live && !children[shard]) launch(shard) }, 1000) })
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function send(shard: Shard, command: string) {
  const child = children[shard]
  if (!child || child.stdin.destroyed) throw new Error(`${shard} process unavailable`)
  child.stdin.write(`${command}\n`)
}
async function query(shard: Shard, masterId?: string): Promise<MaintenanceWorldProbe | null> {
  const token = randomUUID(); const after = output[shard].length
  try { send(shard, buildMaintenanceProbe(token, masterId)) } catch { return null }
  for (let i = 0; i < 15; i += 1) {
    await sleep(100)
    for (const line of output[shard].slice(after)) { const result = parseMaintenanceProbe(line, token); if (result) return result }
  }
  return null
}
async function ready(check?: (worlds: Record<Shard, MaintenanceWorldProbe>) => boolean) {
  const until = Date.now() + 240000
  while (Date.now() < until) {
    const master = await query('master')
    if (master?.ready && master.sessionId && master.shardId) {
      const caves = await query('caves', master.shardId)
      if (caves?.ready && caves.sessionId && caves.remoteConnected && (!check || check({ master, caves }))) return { master, caves }
    }
    await sleep(1000)
  }
  throw new Error(`world verification timed out\n${output.master.slice(-10).join('\n')}\n${output.caves.slice(-10).join('\n')}`)
}
async function save() {
  const token = randomUUID()
  const cursors = { master: output.master.length, caves: output.caves.length }
  for (const shard of ['master', 'caves'] as const) send(shard, buildSaveObserver(token, 30))
  await sleep(500)
  send('master', 'c_save()')
  const until = Date.now() + 30000
  while (Date.now() < until) {
    if ((['master', 'caves'] as const).every(shard => output[shard].slice(cursors[shard]).some(line => line.replace(/^\[\d+:\d+:\d+\]:\s*/, '').trim().startsWith(`BSPSAVED:${token}|`)))) return ready()
    await sleep(250)
  }
  throw new Error('coordinated save callback missing')
}
async function stop() {
  live = false
  for (const child of Object.values(children)) { child.stdin.end(); child.kill('SIGTERM') }
  await sleep(2000)
  for (const child of Object.values(children)) child.kill('SIGKILL')
  await sleep(500)
}
const checks: string[] = []
function passed(name: string) { checks.push(name); console.log(`PASS ${name}`) }
try {
  launch('master')
  // 洞穴只有主世界已生成后才启动。
  const until = Date.now() + 240000
  while (Date.now() < until) { if ((await query('master'))?.ready) break; await sleep(1000) }
  launch('caves')
  let worlds = await ready()
  assert.equal(worlds.master.seed, '123456'); assert.equal(worlds.caves.seed, '654321'); passed('different per-shard seeds')
  const initial = await save()
  await save(); worlds = await save(); passed('coordinated saves and multiple snapshots in one day')
  send('caves', buildSnapshotRollbackCommand(worlds.caves.sessionId!, initial.caves.snapshotId!, randomUUID(), false, 'caves'))
  send('master', buildSnapshotRollbackCommand(worlds.master.sessionId!, initial.master.snapshotId!, randomUUID(), false))
  worlds = await ready(w => w.master.snapshotId === initial.master.snapshotId && w.caves.snapshotId === initial.caves.snapshotId)
  passed('exact rollback within 30 seconds of save, both shards synchronized')
  const sessions = { master: worlds.master.sessionId, caves: worlds.caves.sessionId }
  send('master', 'c_regenerateworld()')
  worlds = await ready(w => w.master.sessionId !== sessions.master && w.caves.sessionId !== sessions.caves)
  assert.equal(worlds.master.seed, '123456'); assert.equal(worlds.caves.seed, '654321'); passed('running whole-room regeneration preserves separate seeds')
  const previousCaves = worlds.caves.sessionId
  setSeed('caves', '123456'); send('caves', 'c_regenerateshard()')
  worlds = await ready(w => w.caves.sessionId !== previousCaves && w.caves.seed === '123456')
  assert.equal(worlds.master.seed, '123456'); passed('running selected-shard regeneration and same seeds')
  const previousMaster = worlds.master.sessionId
  setSeed('master', null); send('master', 'c_regenerateshard()')
  worlds = await ready(w => w.master.sessionId !== previousMaster)
  assert.equal(worlds.caves.seed, '123456'); passed('only one shard specified; clearing seed uses game random seed')
  await stop()
  for (const shard of ['master', 'caves'] as const) fs.rmSync(path.join(cluster, folder(shard), 'save'), { recursive: true, force: true })
  setSeed('master', '42'); setSeed('caves', '42')
  live = true; launch('master'); launch('caves')
  worlds = await ready(w => w.master.seed === '42' && w.caves.seed === '42')
  passed('stopped whole-room regeneration')
  await stop()
  const lastCaves = worlds.caves.sessionId
  fs.rmSync(path.join(cluster, 'Caves', 'save'), { recursive: true, force: true })
  live = true; launch('master'); launch('caves')
  await ready(w => w.caves.sessionId !== lastCaves && w.caves.seed === '42')
  passed('stopped selected-shard regeneration; repeating the same seed')
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ passed: checks }, null, 2))
}
finally { await stop() }
