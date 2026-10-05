import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import {
  finalizePendingDatabaseRestore,
  resolveMigrationsFolder,
  resolveRestoreMarkerPath,
  swapDatabaseFile,
} from './db-restore-service'

/**
 * 恢复面板数据的物理部分与启动收尾。
 *
 * 这里盯的是「面板会不会变砖」：恢复后的库不可用时，启动收尾必须自己回退到恢复前的数据，
 * 否则进程会在「启动即崩」里被 systemd/Docker 反复拉起，而用户没有任何界面可用。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-db-restore-'))
const migrationsFolder = resolveMigrationsFolder()

/** 只用到 log；用最小替身避免为一次日志拉起整个服务 */
function fakeApp() {
  const lines: { level: string, message: string }[] = []
  const app = {
    log: {
      info: (_payload: unknown, message?: string) => lines.push({ level: 'info', message: message ?? '' }),
      warn: (_payload: unknown, message?: string) => lines.push({ level: 'warn', message: message ?? '' }),
      error: (_payload: unknown, message?: string) => lines.push({ level: 'error', message: message ?? '' }),
    },
  } as unknown as FastifyInstance
  return { app, lines }
}

/** 结构完整的面板库：启动收尾的校验要能通过 */
function createPanelDatabase(filePath: string): void {
  const db = new DatabaseSync(filePath)
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  db.exec('CREATE TABLE game_instances (id TEXT PRIMARY KEY)')
  db.exec('CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT)')
  db.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT, created_at NUMERIC)')
  db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('seed', 1)
  db.close()
}

function caseDir(name: string): string {
  const dir = path.join(workDir, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe('database restore', () => {
  before(() => {
    fs.mkdirSync(workDir, { recursive: true })
  })

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('替换主库、清掉 WAL 副文件，并把旧库留在原地', () => {
    const dir = caseDir('swap')
    const dbPath = path.join(dir, 'bubblesharkpanel.sqlite')
    const preparedPath = `${dbPath}.restore-tmp`
    const replacedPath = `${dbPath}.replaced-test`
    fs.writeFileSync(dbPath, 'old-database')
    // WAL 副文件必须被清掉：残留的 WAL 会盖在刚放回去的库上
    fs.writeFileSync(`${dbPath}-wal`, 'wal')
    fs.writeFileSync(`${dbPath}-shm`, 'shm')
    fs.writeFileSync(preparedPath, 'new-database')

    swapDatabaseFile({ dbPath, preparedSourcePath: preparedPath, replacedPath })

    assert.equal(fs.readFileSync(dbPath, 'utf8'), 'new-database')
    assert.equal(fs.existsSync(preparedPath), false)
    assert.equal(fs.readFileSync(replacedPath, 'utf8'), 'old-database')
    assert.equal(fs.existsSync(`${dbPath}-wal`), false)
    assert.equal(fs.existsSync(`${dbPath}-shm`), false)
  })

  it('没有恢复标记时启动收尾什么都不做', async () => {
    const dir = caseDir('no-marker')
    const dbPath = path.join(dir, 'bubblesharkpanel.sqlite')
    createPanelDatabase(dbPath)
    const { app } = fakeApp()

    await finalizePendingDatabaseRestore({ app, dbPath, migrationsFolder })

    assert.equal(fs.existsSync(dbPath), true)
    assert.equal(fs.existsSync(resolveRestoreMarkerPath(dbPath)), false)
  })

  it('恢复成功后清理标记与恢复前的旧库', async () => {
    const dir = caseDir('finalize-ok')
    const dbPath = path.join(dir, 'bubblesharkpanel.sqlite')
    const replacedPath = `${dbPath}.replaced-1`
    createPanelDatabase(dbPath)
    fs.writeFileSync(replacedPath, 'previous-database')
    fs.writeFileSync(resolveRestoreMarkerPath(dbPath), JSON.stringify({
      targetBackupId: 'backup-1',
      replacedPath,
      preRestoreSnapshotPath: null,
      at: new Date().toISOString(),
    }))
    const { app, lines } = fakeApp()

    await finalizePendingDatabaseRestore({ app, dbPath, migrationsFolder })

    assert.equal(fs.existsSync(resolveRestoreMarkerPath(dbPath)), false)
    assert.equal(fs.existsSync(replacedPath), false, '恢复成功就不该再留着恢复前的旧库')
    assert.ok(lines.some(line => line.level === 'info' && line.message.includes('恢复完成')))
  })

  it('恢复后的库不可用时自动回退到恢复前的数据', async () => {
    const dir = caseDir('rollback')
    const dbPath = path.join(dir, 'bubblesharkpanel.sqlite')
    const replacedPath = `${dbPath}.replaced-2`
    // 当前主库是坏文件（模拟替换进去的库打不开），恢复前的旧库仍在
    fs.writeFileSync(dbPath, 'broken')
    createPanelDatabase(replacedPath)
    const previousContent = fs.readFileSync(replacedPath)
    fs.writeFileSync(resolveRestoreMarkerPath(dbPath), JSON.stringify({
      targetBackupId: 'backup-2',
      replacedPath,
      preRestoreSnapshotPath: null,
      at: new Date().toISOString(),
    }))
    const { app, lines } = fakeApp()

    await finalizePendingDatabaseRestore({ app, dbPath, migrationsFolder })

    assert.deepEqual(fs.readFileSync(dbPath), previousContent, '主库必须回到恢复前的数据')
    assert.equal(fs.existsSync(resolveRestoreMarkerPath(dbPath)), false)
    assert.ok(lines.some(line => line.level === 'warn' && line.message.includes('已回退')))
    // 坏库挪开留证，便于事后排查
    assert.ok(fs.readdirSync(dir).some(name => name.startsWith('bubblesharkpanel.sqlite.broken-')))
  })
})
