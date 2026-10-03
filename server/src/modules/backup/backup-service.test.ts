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
  getSystemBackupSettings,
  initDatabase,
  saveSystemBackupSettings,
  updateGameInstanceRuntime,
} from '../../shared/db/index'
import type { DbGameInstance } from '../../shared/db/index'
import { withInstanceArchiveOperationLock } from './archive-lock'
import { createInstanceBackup, restoreInstanceBackup } from './backup-service'

let workDir: string
let instance: DbGameInstance

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

function buildFakeStorageRoot(instanceId: string) {
  const installPath = path.join(workDir, 'instances', instanceId)
  const saveDir = path.join(installPath, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1', 'Master', 'save')
  fs.mkdirSync(saveDir, { recursive: true })
  fs.writeFileSync(path.join(saveDir, 'world.txt'), '世界存档内容-A')
  return installPath
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-backup-service-test-'))
  process.env.GSH_BACKUPS_ROOT = path.join(workDir, 'backups')
  // 无 installPath 的实例回退到 instancesRoot/{id}，fake 存档目录必须与之对齐
  process.env.GSH_INSTANCES_ROOT = path.join(workDir, 'instances')
  await initDatabase(path.join(workDir, `test-${randomUUID()}.sqlite`), migrationsFolder, {
    adminUsername: 'superadmin',
    adminPassword: '123456',
    seedDevelopmentUsers: false,
  })
  instance = await createGameInstance({
    nodeId: 'local-node',
    name: '备份测试实例',
    gameCode: 'dst',
  })
  buildFakeStorageRoot(instance.id)
})

after(() => {
  closeDatabase()
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('backup service', () => {
  it('creates a backup record and archive file for a stopped instance', async () => {
    const result = await createInstanceBackup({
      instanceId: instance.id,
      kind: 'manual',
      note: '集成测试备份',
      createdBy: 'tester',
      saveBeforeArchive: false,
      hotSaveDelayMs: 0,
    })
    assert.equal(result.ok, true)
    assert.ok(result.backup)
    assert.ok(fs.existsSync(result.backup.filePath))
    assert.ok(result.backup.sizeBytes > 0)
    const fetched = await getBackupById(result.backup.id)
    assert.ok(fetched)
    assert.equal(fetched.note, '集成测试备份')
    assert.equal(fetched.kind, 'manual')
    assert.equal(fetched.createdBy, 'tester')
    assert.equal(fetched.shards, '["master"]')
  })

  // 回归：停止的实例此前反而无法手动备份——c_save() 在没运行的实例上必然失败，
  // 而手动备份把它当致命错误，提示还写着「可停止实例后重试」（它已经停止了）。
  it('creates a manual backup for a stopped instance without hot save', async () => {
    await updateGameInstanceRuntime(instance.id, { status: 'stopped' })
    const result = await createInstanceBackup({
      instanceId: instance.id,
      kind: 'manual',
      note: '停止状态下备份',
      createdBy: 'tester',
      hotSaveDelayMs: 0,
    })
    assert.equal(result.ok, true)
    assert.ok(result.backup)
    assert.ok(fs.existsSync(result.backup.filePath))
    assert.equal(result.backup.kind, 'manual')
  })

  // 回归：恢复流程会先把存档目录改名让位再重建，此时并发打包会读到半删除的目录，
  // 产出不完整的 tar 包却被记为 completed —— 用户以为有备份，实际没有。
  it('refuses to create a backup while another archive operation holds the instance lock', async () => {
    const locked = await createGameInstance({
      nodeId: 'local-node',
      name: '锁占用实例',
      gameCode: 'dst',
    })
    buildFakeStorageRoot(locked.id)

    let release: () => void = () => {}
    const holder = withInstanceArchiveOperationLock(locked.id, () => new Promise<void>((resolve) => {
      release = resolve
    }))

    const refused = await createInstanceBackup({
      instanceId: locked.id,
      kind: 'manual',
      saveBeforeArchive: false,
      hotSaveDelayMs: 0,
    })
    assert.equal(refused.ok, false)
    assert.match(refused.message ?? '', /文件操作、启动或下载/)
    assert.equal(refused.backup, undefined)

    release()
    await holder

    // 锁释放后同一实例的备份必须恢复正常，且不残留失败的记录
    const accepted = await createInstanceBackup({
      instanceId: locked.id,
      kind: 'manual',
      saveBeforeArchive: false,
      hotSaveDelayMs: 0,
    })
    assert.equal(accepted.ok, true)
    assert.ok(accepted.backup)
    assert.ok(fs.existsSync(accepted.backup.filePath))
    assert.ok(fs.statSync(accepted.backup.filePath).size > 0)
  })

  it('fails when the instance has no storage directory yet', async () => {
    const other = await createGameInstance({
      nodeId: 'local-node',
      name: '无存档实例',
      gameCode: 'dst',
    })
    const result = await createInstanceBackup({
      instanceId: other.id,
      saveBeforeArchive: false,
      hotSaveDelayMs: 0,
    })
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /尚未生成存档目录/)
  })

  it('restores the archived world content and creates a safety backup', async () => {
    const create = await createInstanceBackup({
      instanceId: instance.id,
      kind: 'manual',
      saveBeforeArchive: false,
      hotSaveDelayMs: 0,
    })
    assert.equal(create.ok, true)
    const backupId = create.backup!.id

    // 备份后存档继续推进
    const saveDir = path.join(workDir, 'instances', instance.id, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1', 'Master', 'save')
    fs.writeFileSync(path.join(saveDir, 'world.txt'), '世界存档内容-B')
    fs.writeFileSync(path.join(saveDir, 'extra.txt'), '备份之后新增')

    const restore = await restoreInstanceBackup({
      app: undefined as never,
      backupId,
    })
    assert.equal(restore.ok, true)
    assert.ok(restore.safetyBackup)
    assert.equal(fs.readFileSync(path.join(saveDir, 'world.txt'), 'utf8'), '世界存档内容-A')
    assert.ok(!fs.existsSync(path.join(saveDir, 'extra.txt')))
    // 恢复前安全备份真实存在
    const safety = await getBackupById(restore.safetyBackup!.id)
    assert.ok(safety)
    assert.equal(safety.kind, 'pre_restore')
    assert.ok(fs.existsSync(safety.filePath))
  })

  it('marks missing backup files as stale on restore attempt', async () => {
    const create = await createInstanceBackup({
      instanceId: instance.id,
      kind: 'manual',
      saveBeforeArchive: false,
      hotSaveDelayMs: 0,
    })
    const backupId = create.backup!.id
    fs.rmSync(create.backup!.filePath, { force: true })
    const restore = await restoreInstanceBackup({
      app: undefined as never,
      backupId,
    })
    assert.equal(restore.ok, false)
    assert.match(restore.message ?? '', /备份包文件已丢失/)
    const record = await getBackupById(backupId)
    assert.equal(record?.status, 'stale')
  })

  it('rejects restore while the instance is running', async () => {
    await updateGameInstanceRuntime(instance.id, { status: 'running' })
    const create = await createInstanceBackup({
      instanceId: instance.id,
      kind: 'manual',
      saveBeforeArchive: false,
      hotSaveDelayMs: 0,
    })
    const restore = await restoreInstanceBackup({
      app: undefined as never,
      backupId: create.backup!.id,
    })
    assert.equal(restore.ok, false)
    assert.match(restore.message ?? '', /先停止实例/)
    await updateGameInstanceRuntime(instance.id, { status: 'stopped' })
  })

  it('enforces per-instance retention by removing the oldest backups', async () => {
    await saveSystemBackupSettings({ perInstanceRetention: 2 })
    const settings = await getSystemBackupSettings()
    assert.equal(settings.perInstanceRetention, 2)

    const first = await createInstanceBackup({
      instanceId: instance.id,
      kind: 'manual',
      saveBeforeArchive: false,
      hotSaveDelayMs: 0,
    })
    assert.equal(first.ok, true)
    // 文件名时间戳精确到秒：跨秒创建，避免同名覆盖
    await sleep(1100)
    const second = await createInstanceBackup({
      instanceId: instance.id,
      kind: 'manual',
      saveBeforeArchive: false,
      hotSaveDelayMs: 0,
    })
    assert.equal(second.ok, true)
    await sleep(1100)
    const third = await createInstanceBackup({
      instanceId: instance.id,
      kind: 'manual',
      saveBeforeArchive: false,
      hotSaveDelayMs: 0,
    })
    assert.equal(third.ok, true)

    // 第一份应被保留策略淘汰（记录与文件都应消失）
    assert.equal(await getBackupById(first.backup!.id), undefined)
    assert.ok(!fs.existsSync(first.backup!.filePath))
    assert.ok(await getBackupById(second.backup!.id))
    assert.ok(await getBackupById(third.backup!.id))
  })
})
