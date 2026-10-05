import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { registerAuthModule } from '../auth/index'
import { registerDatabaseBackupRoutes } from '../system/db-backup-routes'
import { addUserInstanceGrants, findUserByAccount } from '../../shared/db/index'
import { closeDatabase, createBackupRecord, getBackupById, initDatabase, listBackups, newBackupId } from '../../shared/db/index'
import { registerBackupModule } from './index'

/**
 * 导入外部面板数据库快照。
 *
 * 这条链路的风险不在「接口返回什么」，而在它会不会把不能用的文件放进快照列表——
 * 用户看到列表里有一条「导入自 xxx.sqlite」，点恢复之前不会知道它其实是坏的。
 * 所以这里钉住：只有真正能用面板数据库才允许入库。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-db-import-'))
const dbFilePath = path.join(workDir, 'bubblesharkpanel.sqlite')
const backupsRoot = path.join(workDir, 'backups')
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

process.env.DB_PATH = dbFilePath
process.env.BSP_BACKUPS_ROOT = backupsRoot
process.env.BSP_SAVE_IMPORT_ROOT = path.join(workDir, 'uploads')

interface ApiEnvelope<T> {
  status: 0 | 1
  error: string
  code: string
  data: T
}

let app: FastifyInstance
let token = ''

function createPanelDatabase(filePath: string): void {
  const db = new DatabaseSync(filePath)
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  db.exec('CREATE TABLE game_instances (id TEXT PRIMARY KEY)')
  db.exec('CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT)')
  db.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT, created_at NUMERIC)')
  db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('seed', 1)
  db.close()
}

function uploadSnapshot(fileName: string, payload: Buffer) {
  return app.inject({
    method: 'POST',
    url: `/app/system/db/backup/import?fileName=${encodeURIComponent(fileName)}`,
    payload,
    headers: {
      token,
      'content-type': 'application/octet-stream',
    },
  })
}

describe('database snapshot import route', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder, {
      adminUsername: 'superadmin',
      adminPassword: '123456',
      seedDevelopmentUsers: false,
    })

    app = Fastify({ logger: false })
    registerAuthModule(app)
    registerBackupModule(app)
    // 快照自己的列表接口由 system 模块注册：两条列表的边界正是这次要钉住的东西
    registerDatabaseBackupRoutes(app)
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/app/account/login',
      payload: { account: 'superadmin', password: '123456' },
    })
    const body = JSON.parse(login.body) as ApiEnvelope<{ token: string }>
    assert.equal(body.status, 1, `登录失败：${login.body}`)
    token = body.data.token

    /**
     * 实例级隔离生效后，「看得到某个实例的存档备份」以该实例的授权为前提：
     * 备份列表会按可见实例过滤。生产环境里实例由创建接口建立、创建者自动获得授权，
     * 而这个测试直接造备份记录、跳过了那一步，所以这里补一条授权。
     */
    const admin = await findUserByAccount('superadmin')
    assert.ok(admin, '前置条件：管理员账号存在')
    await addUserInstanceGrants(admin.id, ['inst-1'], null)
  })

  after(async () => {
    await app.close()
    closeDatabase()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('未登录时拒绝', async () => {
    const sourcePath = path.join(workDir, 'anon.sqlite')
    createPanelDatabase(sourcePath)
    const response = await app.inject({
      method: 'POST',
      url: '/app/system/db/backup/import?fileName=anon.sqlite',
      payload: fs.readFileSync(sourcePath),
      headers: { 'content-type': 'application/octet-stream' },
    })
    assert.equal(response.statusCode, 401)
  })

  it('导入面板数据库快照：登记为 database 类型的备份', async () => {
    const sourcePath = path.join(workDir, 'from-other-machine.sqlite')
    createPanelDatabase(sourcePath)

    const response = await uploadSnapshot('from-other-machine.sqlite', fs.readFileSync(sourcePath))
    assert.equal(response.statusCode, 200, response.body)
    const body = JSON.parse(response.body) as ApiEnvelope<{ backupId: string }>
    assert.equal(body.status, 1)
    assert.ok(body.data.backupId)

    const record = await getBackupById(body.data.backupId)
    assert.ok(record)
    assert.equal(record.kind, 'database')
    assert.equal(record.instanceId, 'panel-db')
    assert.equal(record.status, 'completed')
    assert.match(record.note, /from-other-machine\.sqlite/)
    // 落盘位置必须在快照目录里：列表页的下载/删除都按备份根目录校验
    assert.ok(record.filePath.startsWith(path.join(backupsRoot, 'db')))
    assert.ok(fs.existsSync(record.filePath))
    assert.deepEqual(fs.readFileSync(record.filePath), fs.readFileSync(sourcePath))
  })

  it('拒绝不是 SQLite 的文件，且不入库', async () => {
    const before = (await listBackups()).length
    const response = await uploadSnapshot('not-a-db.sqlite', Buffer.from('这不是数据库，只是一段文本'))
    assert.equal(response.statusCode, 400)
    const body = JSON.parse(response.body) as ApiEnvelope<unknown>
    assert.equal(body.code, 'BACKUP_IMPORT_SOURCE_INVALID')
    assert.match(body.error, /不是 SQLite/)
    assert.equal((await listBackups()).length, before, '校验失败不允许留下记录')
  })

  it('拒绝缺少面板核心表的数据库', async () => {
    const sourcePath = path.join(workDir, 'foreign.sqlite')
    const db = new DatabaseSync(sourcePath)
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
    db.close()

    const response = await uploadSnapshot('foreign.sqlite', fs.readFileSync(sourcePath))
    assert.equal(response.statusCode, 400)
    const body = JSON.parse(response.body) as ApiEnvelope<unknown>
    assert.match(body.error, /不是本面板的数据库/)
  })

  /**
   * 回归：面板快照一度会同时出现在上方那张实例存档表和下方的快照区块里——
   * 存档列表接口不传实例时把哨兵记录也带出来了。快照有它自己的列表，这里必须干净。
   */
  it('面板快照不出现在实例存档列表里，实例备份照旧返回', async () => {
    const filePath = path.join(backupsRoot, 'inst-1', '20260924-120000-manual.tar.gz')
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'fake-archive')
    const instanceBackupId = newBackupId()
    await createBackupRecord({
      id: instanceBackupId,
      instanceId: 'inst-1',
      filePath,
      sizeBytes: 12,
      note: '',
      kind: 'manual',
      status: 'completed',
      createdBy: 'superadmin',
    })

    const instanceList = await app.inject({
      method: 'POST',
      url: '/app/instance/backup/list',
      payload: {},
      headers: { token },
    })
    const instanceBody = JSON.parse(instanceList.body) as ApiEnvelope<Array<{ id: string, instanceId: string }>>
    assert.equal(instanceBody.status, 1, instanceList.body)
    assert.equal(instanceBody.data.some(item => item.instanceId === 'panel-db'), false, '存档列表里不该有面板快照')
    assert.ok(instanceBody.data.some(item => item.id === instanceBackupId), '实例存档备份必须照旧返回')

    const snapshotList = await app.inject({
      method: 'GET',
      url: '/app/system/db/backup',
      headers: { token },
    })
    const snapshotBody = JSON.parse(snapshotList.body) as ApiEnvelope<Array<{ instanceId: string }>>
    assert.equal(snapshotBody.status, 1, snapshotList.body)
    assert.ok(snapshotBody.data.length > 0, '快照仍要在它自己的列表里')
    assert.ok(snapshotBody.data.every(item => item.instanceId === 'panel-db'))
  })
})
