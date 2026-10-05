import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  closeDatabase,
  createGameInstance,
  getBackupById,
  getGameInstanceById,
  initDatabase,
  listInstanceMods,
} from '../../shared/db/index'
import type { DbGameInstance } from '../../shared/db/index'
import { DST_APP_ID, resolveDstSteamWorkshopModDir } from '../../infra/game-adapter/dst/constants'
import {
  resetModDownloadExecutorForTest,
  setModDownloadExecutorForTest,
} from '../mod/mod-download-service'
import { InstanceArchiveBusyError, withInstanceArchiveOperationLock } from './archive-lock'
import { importSaveToInstance, probeSaveImportSource } from './import-service'

let workDir: string
let sourceRoot: string

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

let seq = 0

/** 构造一份外部 Klei 集群存档（源档），返回集群目录路径 */
function buildSourceCluster(dirName: string, opts?: { token?: boolean, shardEnabled?: boolean }): string {
  seq += 1
  const clusterPath = path.join(sourceRoot, dirName)
  const masterDir = path.join(clusterPath, 'Master')
  const cavesDir = path.join(clusterPath, 'Caves')
  fs.mkdirSync(path.join(masterDir, 'save', 'session', 'KleiSession'), { recursive: true })
  fs.mkdirSync(path.join(cavesDir, 'save', 'session'), { recursive: true })
  fs.writeFileSync(path.join(clusterPath, 'cluster.ini'), [
    '[GAMEPLAY]',
    'game_mode = survival',
    'max_players = 6',
    '',
    '[NETWORK]',
    `cluster_name = 导入测试房-${seq}`,
    'cluster_password = 123',
    '',
    '[SHARD]',
    `shard_enabled = ${opts?.shardEnabled ?? true}`,
    'bind_ip = 127.0.0.1',
    'master_ip = 127.0.0.1',
    'master_port = 10888',
    'cluster_key = mykey',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(masterDir, 'save', 'session', 'KleiSession', 'world.txt'), '源世界数据')
  fs.writeFileSync(path.join(masterDir, 'server.ini'), '[SHARD]\nis_master = true\nname = Master\n\n[NETWORK]\nserver_port = 27015\n')
  fs.writeFileSync(path.join(cavesDir, 'server.ini'), '[SHARD]\nis_master = false\nname = Caves\n\n[NETWORK]\nserver_port = 27016\n')
  fs.writeFileSync(path.join(masterDir, 'modoverrides.lua'), [
    'return {',
    '  ["workshop-123456789"]={ enabled=true, configuration_options={ ["maze"]="on" } },',
    '  ["workshop-987654321"]={ enabled=false },',
    '}',
    '',
  ].join('\n'))
  if (opts?.token) {
    fs.writeFileSync(path.join(clusterPath, 'cluster_token.txt'), 'pds-sourcetoken123\n')
  }
  return clusterPath
}

/** 构造一个已完成游戏安装的目标实例（bin64 二进制 + 可选旧存档/令牌） */
async function buildInstalledInstance(opts?: {
  gamePort?: number
  withOldSave?: boolean
  withExistingToken?: boolean
  withDiskServerIni?: number
  gameCode?: string
}): Promise<DbGameInstance> {
  seq += 1
  const installPath = path.join(workDir, 'instances', `inst-${seq}`)
  fs.mkdirSync(path.join(installPath, 'bin64'), { recursive: true })
  fs.writeFileSync(path.join(installPath, 'bin64', 'dontstarve_dedicated_server_nullrenderer_x64'), 'binary')
  fs.mkdirSync(path.join(installPath, 'steamapps'), { recursive: true })
  fs.writeFileSync(path.join(installPath, 'steamapps', 'appmanifest_343050.acf'), '"buildid" "25540104"\n')
  fs.writeFileSync(path.join(installPath, 'version.txt'), '747465\n')
  if (opts?.withOldSave) {
    const oldSave = path.join(installPath, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1', 'Master', 'save')
    fs.mkdirSync(oldSave, { recursive: true })
    fs.writeFileSync(path.join(oldSave, 'old-world.txt'), '旧世界数据')
  }
  if (opts?.withExistingToken) {
    const tokenPath = path.join(installPath, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1', 'cluster_token.txt')
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true })
    fs.writeFileSync(tokenPath, 'pds-existingtoken456\n')
  }
  if (opts?.withDiskServerIni) {
    const iniPath = path.join(installPath, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1', 'Master', 'server.ini')
    fs.mkdirSync(path.dirname(iniPath), { recursive: true })
    fs.writeFileSync(iniPath, `[SHARD]\nis_master = true\nname = Master\n\n[NETWORK]\nserver_port = ${opts.withDiskServerIni}\n`)
  }
  return await createGameInstance({
    nodeId: 'local-node',
    name: `导入测试实例-${seq}`,
    gameCode: opts?.gameCode ?? DST_APP_ID,
    installPath,
    gamePort: opts?.gamePort ?? 10999,
  })
}

function resolveClusterRoot(installPath: string): string {
  return path.join(installPath, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1')
}

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-import-service-test-'))
  process.env.BSP_BACKUPS_ROOT = path.join(workDir, 'backups')
  process.env.BSP_INSTANCES_ROOT = path.join(workDir, 'instances')
  sourceRoot = path.join(workDir, 'sources')
  fs.mkdirSync(sourceRoot, { recursive: true })
  // 导入后会把缺失内容的 Mod 排进下载队列：这里只验证入库与 Lua 状态，不真的下载
  setModDownloadExecutorForTest(() => new Promise<{ ok: boolean }>(() => {}))
  await initDatabase(path.join(workDir, `test-${randomUUID()}.sqlite`), migrationsFolder, {
    adminUsername: 'superadmin',
    adminPassword: '123456',
    seedDevelopmentUsers: false,
  })
})

after(() => {
  resetModDownloadExecutorForTest()
  closeDatabase()
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('save import probe', () => {
  it('recognizes a cluster directory itself', () => {
    const clusterPath = buildSourceCluster('Cluster_A')
    const probed = probeSaveImportSource(clusterPath)
    assert.equal(probed.ok, true)
    assert.equal(probed.result!.candidates.length, 1)
    const candidate = probed.result!.candidates[0]!
    assert.equal(candidate.dirName, 'Cluster_A')
    assert.equal(candidate.clusterName, '导入测试房-1')
    assert.deepEqual(candidate.shards, ['master', 'caves'])
    assert.equal(candidate.worldGenerated, true)
    assert.equal(candidate.modCount, 2)
    assert.equal(candidate.hasTokenFile, false)
    assert.ok(candidate.sizeBytes > 0)
    assert.deepEqual(candidate.warnings, [])
  })

  it('lists Cluster_* candidates under a Klei user-id directory', () => {
    const userIdRoot = path.join(sourceRoot, 'klei-uid', 'DoNotStarveTogether', '342760437')
    fs.mkdirSync(userIdRoot, { recursive: true })
    buildSourceCluster(path.join('klei-uid', 'DoNotStarveTogether', '342760437', 'Cluster_2'))
    const probed = probeSaveImportSource(path.join(sourceRoot, 'klei-uid', 'DoNotStarveTogether'))
    assert.equal(probed.ok, true)
    assert.equal(probed.result!.candidates.length, 1)
    assert.equal(probed.result!.candidates[0]!.dirName, 'Cluster_2')
  })

  it('lists Cluster_* candidates under a Klei root directory', () => {
    const kleiRoot = path.join(sourceRoot, 'klei-root', 'DoNotStarveTogether')
    fs.mkdirSync(kleiRoot, { recursive: true })
    buildSourceCluster(path.join('klei-root', 'DoNotStarveTogether', 'Cluster_201'))
    buildSourceCluster(path.join('klei-root', 'DoNotStarveTogether', 'Cluster_202'), { token: true })
    const probed = probeSaveImportSource(kleiRoot)
    assert.equal(probed.ok, true)
    assert.equal(probed.result!.candidates.length, 2)
    const withToken = probed.result!.candidates.find(item => item.dirName === 'Cluster_202')
    assert.ok(withToken)
    assert.equal(withToken.hasTokenFile, true)
  })

  it('fails on a directory without cluster candidates', () => {
    const emptyDir = path.join(sourceRoot, 'empty-dir')
    fs.mkdirSync(emptyDir, { recursive: true })
    const probed = probeSaveImportSource(emptyDir)
    assert.equal(probed.ok, false)
    assert.match(probed.message ?? '', /未在该目录下找到存档/)
  })

  it('fails on a missing directory', () => {
    const probed = probeSaveImportSource(path.join(sourceRoot, 'not-exists'))
    assert.equal(probed.ok, false)
    assert.match(probed.message ?? '', /源目录不存在/)
  })
})

describe('save import execution', () => {
  it('imports source cluster into an instance with old save, creating pre_import backup', async () => {
    const sourcePath = buildSourceCluster('Cluster_Happy')
    const instance = await buildInstalledInstance({ gamePort: 10999, withOldSave: true })
    const result = await importSaveToInstance({
      instanceId: instance.id,
      sourceClusterPath: sourcePath,
      createdBy: 'tester',
    })
    assert.equal(result.ok, true)
    const detail = result.result!
    assert.equal(fs.readFileSync(path.join(instance.installPath!, 'version.txt'), 'utf8'), '747465\n')
    assert.equal(fs.readFileSync(path.join(instance.installPath!, 'steamapps', 'appmanifest_343050.acf'), 'utf8'), '"buildid" "25540104"\n')
    assert.equal(fs.readFileSync(path.join(instance.installPath!, 'bin64', 'dontstarve_dedicated_server_nullrenderer_x64'), 'utf8'), 'binary')
    assert.deepEqual(detail.importedShards, ['master', 'caves'])
    assert.equal(detail.tokenSource, 'none')
    assert.ok(detail.safetyBackupId)

    const clusterRoot = resolveClusterRoot(instance.installPath!)
    // 旧存档被替换，源档世界数据就位
    assert.ok(!fs.existsSync(path.join(clusterRoot, 'Master', 'save', 'old-world.txt')))
    assert.equal(fs.readFileSync(path.join(clusterRoot, 'Master', 'save', 'session', 'KleiSession', 'world.txt'), 'utf8'), '源世界数据')
    // cluster.ini 保留源档房间设置
    assert.match(fs.readFileSync(path.join(clusterRoot, 'cluster.ini'), 'utf8'), /cluster_name = 导入测试房/)
    // 端口重写为实例端口体系（DB gamePort=10999 推导：master 10999 / caves 11000）
    const masterIni = fs.readFileSync(path.join(clusterRoot, 'Master', 'server.ini'), 'utf8')
    assert.match(masterIni, /server_port = 10999/)
    const cavesIni = fs.readFileSync(path.join(clusterRoot, 'Caves', 'server.ini'), 'utf8')
    assert.match(cavesIni, /server_port = 11000/)
    // 面板元数据就位
    const meta = JSON.parse(fs.readFileSync(path.join(clusterRoot, '.bsp-panel-config.json'), 'utf8'))
    assert.ok(meta.roomSavedAt)
    assert.ok(meta.masterWorldSavedAt)
    // 导入前安全备份
    const safety = await getBackupById(detail.safetyBackupId!)
    assert.ok(safety)
    assert.equal(safety.kind, 'pre_import')
    // Mod 反向入库：本机没有创意工坊内容，必须记为「等待下载」而不是「已就绪」
    assert.equal(detail.modCount, 2)
    const mods = await listInstanceMods(instance.id)
    assert.equal(mods.length, 2)
    const first = mods.find(mod => mod.workshopId === '123456789')
    assert.ok(first)
    assert.equal(first.enabled, true)
    assert.equal(first.installStatus, 'pending')
    assert.match(first.installError ?? '', /创意工坊/)
    assert.deepEqual(JSON.parse(first.config ?? '{}'), { maze: 'on' })
    const second = mods.find(mod => mod.workshopId === '987654321')
    assert.ok(second)
    assert.equal(second.enabled, false)
    assert.equal(second.installStatus, 'pending')
    // workshop 内容缺失提示（实例未下载 mod 内容）：面板不自动下载，提示去 Mod 页点开始
    assert.deepEqual(detail.missingWorkshopContent.sort(), ['123456789', '987654321'])
    assert.ok(detail.warnings.some(warning => warning.includes('Mod 管理 → 已订阅')))
    assert.ok(detail.warnings.every(warning => !warning.includes('世界设置 → 模组')))
    // 缺失内容的 Mod 不进 modoverrides.lua：否则 DST 每次启动都会自行补下载，legacy 包常超时失败
    assert.equal(fs.readFileSync(path.join(clusterRoot, 'Master', 'modoverrides.lua'), 'utf8'), 'return {}\n')
    // staging 清理
    assert.equal(fs.readdirSync(instance.installPath!).filter(name => name.startsWith('.import-staging-')).length, 0)
  })

  it('imports a mod as ready only when its workshop content already exists', async () => {
    const sourcePath = buildSourceCluster('Cluster_ModsPresent')
    const instance = await buildInstalledInstance({ withOldSave: true })
    // 预置其中一个 Mod 的创意工坊下载产物（steamapps/workshop/content/<appid>/<id>）
    const presentDir = resolveDstSteamWorkshopModDir(instance.installPath!, '123456789')
    fs.mkdirSync(presentDir, { recursive: true })
    fs.writeFileSync(path.join(presentDir, 'modinfo.lua'), 'return { name = "已下载的 Mod" }\n')

    const result = await importSaveToInstance({
      instanceId: instance.id,
      sourceClusterPath: sourcePath,
      createdBy: 'tester',
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.result!.missingWorkshopContent, ['987654321'])

    const mods = await listInstanceMods(instance.id)
    const present = mods.find(mod => mod.workshopId === '123456789')
    const missing = mods.find(mod => mod.workshopId === '987654321')
    assert.equal(present?.installStatus, 'ready')
    assert.equal(present?.installError, null)
    assert.equal(missing?.installStatus, 'pending')

    // 只有就绪的 Mod 进 modoverrides.lua，且源档的开关与配置照旧
    const overrides = fs.readFileSync(path.join(resolveClusterRoot(instance.installPath!), 'Master', 'modoverrides.lua'), 'utf8')
    assert.match(overrides, /\["workshop-123456789"\]=\{ enabled=true, configuration_options=\{ maze="on" \} \},/)
    assert.doesNotMatch(overrides, /workshop-987654321/)
  })

  it('prefers an explicit token over existing and source tokens', async () => {
    const sourcePath = buildSourceCluster('Cluster_TokenProvided', { token: true })
    const instance = await buildInstalledInstance({ withOldSave: true, withExistingToken: true })
    const result = await importSaveToInstance({
      instanceId: instance.id,
      sourceClusterPath: sourcePath,
      clusterToken: 'pds-providedtoken789',
    })
    assert.equal(result.ok, true)
    assert.equal(result.result!.tokenSource, 'provided')
    assert.match(
      fs.readFileSync(path.join(resolveClusterRoot(instance.installPath!), 'cluster_token.txt'), 'utf8'),
      /pds-providedtoken789/,
    )
  })

  it('keeps the existing instance token when none is provided', async () => {
    const sourcePath = buildSourceCluster('Cluster_TokenExisting')
    const instance = await buildInstalledInstance({ withOldSave: true, withExistingToken: true })
    const result = await importSaveToInstance({
      instanceId: instance.id,
      sourceClusterPath: sourcePath,
    })
    assert.equal(result.ok, true)
    assert.equal(result.result!.tokenSource, 'existing')
    assert.match(
      fs.readFileSync(path.join(resolveClusterRoot(instance.installPath!), 'cluster_token.txt'), 'utf8'),
      /pds-existingtoken456/,
    )
  })

  it('skips the safety backup when the instance has no storage yet', async () => {
    const sourcePath = buildSourceCluster('Cluster_Fresh')
    const instance = await buildInstalledInstance()
    const result = await importSaveToInstance({
      instanceId: instance.id,
      sourceClusterPath: sourcePath,
    })
    assert.equal(result.ok, true)
    assert.equal(result.result!.safetyBackupId, undefined)
  })

  it('syncs DB gamePort when the instance disk server.ini defines a different port', async () => {
    const sourcePath = buildSourceCluster('Cluster_PortSync')
    const instance = await buildInstalledInstance({ gamePort: 10999, withOldSave: true, withDiskServerIni: 20010 })
    const result = await importSaveToInstance({
      instanceId: instance.id,
      sourceClusterPath: sourcePath,
    })
    assert.equal(result.ok, true)
    assert.equal(result.result!.gamePortSynced, true)
    const refreshed = await getGameInstanceById(instance.id)
    assert.equal(refreshed!.gamePort, 20010)
    const masterIni = fs.readFileSync(path.join(resolveClusterRoot(instance.installPath!), 'Master', 'server.ini'), 'utf8')
    assert.match(masterIni, /server_port = 20010/)
  })

  it('rejects a running instance', async () => {
    const sourcePath = buildSourceCluster('Cluster_Running')
    const instance = await buildInstalledInstance({ withOldSave: true })
    await getGameInstanceById(instance.id)
    const { updateGameInstanceRuntime } = await import('../../shared/db/index')
    await updateGameInstanceRuntime(instance.id, { status: 'running' })
    const result = await importSaveToInstance({
      instanceId: instance.id,
      sourceClusterPath: sourcePath,
    })
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /先停止实例/)
  })

  it('rejects non-DST instances', async () => {
    const sourcePath = buildSourceCluster('Cluster_WrongGame')
    const instance = await buildInstalledInstance({ gameCode: 'other-game', withOldSave: true })
    const result = await importSaveToInstance({
      instanceId: instance.id,
      sourceClusterPath: sourcePath,
    })
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /DST 实例/)
  })

  it('rejects instances without the game binary installed', async () => {
    const sourcePath = buildSourceCluster('Cluster_NoBinary')
    const instance = await createGameInstance({
      nodeId: 'local-node',
      name: '未安装实例',
      gameCode: DST_APP_ID,
      installPath: path.join(workDir, 'instances', 'no-binary'),
      gamePort: 10999,
    })
    fs.mkdirSync(instance.installPath!, { recursive: true })
    const result = await importSaveToInstance({
      instanceId: instance.id,
      sourceClusterPath: sourcePath,
    })
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /尚未完成游戏安装/)
  })

  it('rejects a source directory without cluster.ini', async () => {
    const notCluster = path.join(sourceRoot, 'not-a-cluster')
    fs.mkdirSync(notCluster, { recursive: true })
    const instance = await buildInstalledInstance({ withOldSave: true })
    const result = await importSaveToInstance({
      instanceId: instance.id,
      sourceClusterPath: notCluster,
    })
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /缺少房间配置文件/)
  })

  it('rejects a source path that contains the instance install path (self-copy)', async () => {
    const instance = await buildInstalledInstance({ withOldSave: true })
    // 源=安装目录本身：staging 建在安装目录下，复制会造成自我嵌套，必须拒绝
    const result = await importSaveToInstance({
      instanceId: instance.id,
      sourceClusterPath: instance.installPath!,
    })
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /不能包含实例安装目录|缺少房间配置文件/)
  })

  it('rejects concurrent import while the instance archive lock is held', async () => {
    const sourcePath = buildSourceCluster('Cluster_Lock')
    const instance = await buildInstalledInstance({ withOldSave: true })
    await withInstanceArchiveOperationLock(instance.id, async () => {
      const result = await importSaveToInstance({
        instanceId: instance.id,
        sourceClusterPath: sourcePath,
      })
      assert.equal(result.ok, false)
      assert.match(result.message ?? '', /正在执行文件操作、启动或下载/)
    })
    // 锁释放后可正常导入
    const retry = await importSaveToInstance({
      instanceId: instance.id,
      sourceClusterPath: sourcePath,
    })
    assert.equal(retry.ok, true)
  })

  it('throws InstanceArchiveBusyError from the lock helper on contention', async () => {
    const release = { fn: () => {} }
    const promise = withInstanceArchiveOperationLock('lock-helper-instance', () => new Promise<void>(resolve => { release.fn = resolve }))
    try {
      await withInstanceArchiveOperationLock('lock-helper-instance', async () => {})
      assert.fail('should have thrown')
    }
    catch (error) {
      assert.ok(error instanceof InstanceArchiveBusyError)
    }
    release.fn()
    await promise
  })
})
