import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'node:test'
import { closeDatabase, createScheduleTask, getScheduleTaskById, initDatabase } from './index'
import { ensureDb } from './connection'

it('旧更新检查任务迁移为停用的定时更新，保留时间配置并在重启后保持迁移说明', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-schedule-migration-'))
  const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')
  const previousMigrations = path.join(root, 'previous-migrations')
  const database = path.join(root, 'test.sqlite')
  fs.cpSync(migrations, previousMigrations, { recursive: true })
  const journalPath = path.join(previousMigrations, 'meta', '_journal.json')
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag !== '0032_scheduled_update')
  fs.writeFileSync(journalPath, JSON.stringify(journal))
  try {
    await initDatabase(database, previousMigrations, { seedDevelopmentUsers: false })
    await createScheduleTask({
      id: 'legacy-update', instanceId: 'inst-existing', kind: 'backup', scheduleType: 'daily', scheduleValue: '03:15',
      scheduleTz: 'server', enabled: true, nextRunAt: '2030-01-01T03:15:00.000Z',
    })
    ensureDb().sqliteDb.prepare("UPDATE scheduled_tasks SET kind = 'update_check' WHERE id = 'legacy-update'").run()
    closeDatabase()
    await initDatabase(database, migrations, { seedDevelopmentUsers: false })
    const task = await getScheduleTaskById('legacy-update')
    assert.equal(task?.kind, 'update')
    assert.equal(task?.enabled, false)
    assert.equal(task?.nextRunAt, null)
    assert.equal(task?.instanceId, 'inst-existing')
    assert.equal(task?.scheduleValue, '03:15')
    assert.equal(task?.scheduleTz, 'server')
    assert.equal(task?.lastRunMessage, '已改为定时更新，请确认后启用')
    closeDatabase()
    await initDatabase(database, migrations, { seedDevelopmentUsers: false })
    assert.deepEqual(await getScheduleTaskById('legacy-update'), task)
  }
  finally { closeDatabase(); fs.rmSync(root, { recursive: true, force: true }) }
})
