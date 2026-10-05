import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'node:test'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { resolveMigrationsFolder } from './db-restore-service'
import { verifyPanelDatabaseFile } from './db-snapshot-verify'

/**
 * 面板数据库文件体检。
 *
 * 这份判断同时是导入、恢复与启动收尾的准入条件：放行了不该放行的文件，
 * 用户会拿到一个"导入成功但一恢复面板就起不来"的结果；拒了该放行的文件，
 * 灾难恢复时唯一的退路就没了。因此逐条钉住每个拒绝理由。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-db-verify-'))
const migrationsFolder = resolveMigrationsFolder()

/** 造一份结构完整的「面板数据库」；createdAt 用来模拟不同版本的迁移记录 */
function createPanelDatabase(filePath: string, options: { migrationCreatedAt?: number } = {}): void {
  const db = new DatabaseSync(filePath)
  db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)')
  db.exec('CREATE TABLE game_instances (id TEXT PRIMARY KEY)')
  db.exec('CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT)')
  db.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT, created_at NUMERIC)')
  db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run('seed', options.migrationCreatedAt ?? 1)
  db.close()
}

function supportedLatestMigration(): number {
  return readMigrationFiles({ migrationsFolder })
    .reduce((max, file) => Math.max(max, file.folderMillis), 0)
}

describe('panel database verify', () => {
  before(() => {
    fs.mkdirSync(workDir, { recursive: true })
  })

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('接受结构完整的面板数据库', () => {
    const filePath = path.join(workDir, 'ok.sqlite')
    createPanelDatabase(filePath)
    const result = verifyPanelDatabaseFile(filePath, migrationsFolder)
    assert.equal(result.ok, true, result.message)
    assert.equal(result.migrationCount, 1)
  })

  it('拒绝不存在的文件', () => {
    const result = verifyPanelDatabaseFile(path.join(workDir, 'missing.sqlite'), migrationsFolder)
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /不存在/)
  })

  it('拒绝空文件', () => {
    const filePath = path.join(workDir, 'empty.sqlite')
    fs.writeFileSync(filePath, '')
    const result = verifyPanelDatabaseFile(filePath, migrationsFolder)
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /空的/)
  })

  it('拒绝不是 SQLite 的文件', () => {
    const filePath = path.join(workDir, 'not-a-db.sqlite')
    fs.writeFileSync(filePath, 'tar.gz 或者随便什么文本')
    const result = verifyPanelDatabaseFile(filePath, migrationsFolder)
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /不是 SQLite/)
  })

  it('拒绝缺少面板核心表的数据库', () => {
    const filePath = path.join(workDir, 'other.sqlite')
    const db = new DatabaseSync(filePath)
    db.exec('CREATE TABLE something_else (id TEXT PRIMARY KEY)')
    db.close()
    const result = verifyPanelDatabaseFile(filePath, migrationsFolder)
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /不是本面板的数据库/)
  })

  it('拒绝来自更新版本面板的快照', () => {
    const filePath = path.join(workDir, 'from-newer.sqlite')
    createPanelDatabase(filePath, { migrationCreatedAt: supportedLatestMigration() + 60_000 })
    const result = verifyPanelDatabaseFile(filePath, migrationsFolder)
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /更新版本的面板/)
  })

  it('接受迁移版本与当前代码一致的快照', () => {
    const filePath = path.join(workDir, 'same-version.sqlite')
    createPanelDatabase(filePath, { migrationCreatedAt: supportedLatestMigration() })
    const result = verifyPanelDatabaseFile(filePath, migrationsFolder)
    assert.equal(result.ok, true, result.message)
  })
})
