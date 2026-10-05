import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { closeDatabase, createGameInstance, initDatabase } from './index'
import {
  createScheduleTask,
  deleteScheduleTask,
  getScheduleTaskById,
  listDueScheduleTasks,
  listEnabledScheduleTasks,
  newScheduleTaskId,
  updateScheduleTask,
} from './schedule-repository'
import { recoverMissedTasksOnBoot } from '../../modules/schedule/scheduler'

const dbFilePath = path.join(os.tmpdir(), `bsp-schedule-repo-test-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

const stubApp = {
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
} as never

async function seedInstance(): Promise<string> {
  const instance = await createGameInstance({
    nodeId: 'local-node',
    name: `schedule-target-${randomUUID().slice(0, 6)}`,
    gameCode: 'dst',
    status: 'stopped',
    installPath: path.join(os.tmpdir(), `bsp-schedule-target-${randomUUID().slice(0, 6)}`),
  })
  return instance.id
}

describe('schedule repository & boot recovery', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
  })

  after(() => {
    closeDatabase()
  })

  it('creates a task with defaults and reads it back', async () => {
    const instanceId = await seedInstance()
    const task = await createScheduleTask({
      id: newScheduleTaskId(),
      instanceId,
      kind: 'backup',
      scheduleType: 'daily',
      scheduleValue: '04:30',
      nextRunAt: '2026-09-16T04:30:00.000Z',
      createdBy: 'tester',
    })
    assert.equal(task.enabled, true)
    assert.equal(task.kind, 'backup')
    assert.equal(task.lastRunStatus, null)
    const read = await getScheduleTaskById(task.id)
    assert.equal(read?.instanceId, instanceId)
    assert.equal(read?.scheduleValue, '04:30')
    assert.equal(read?.scheduleTz, 'beijing', 'daily task defaults to beijing timezone')
  })

  it('persists explicit schedule timezone and normalizes unknown values to beijing', async () => {
    const instanceId = await seedInstance()
    const serverTz = await createScheduleTask({
      id: newScheduleTaskId(),
      instanceId,
      kind: 'restart',
      scheduleType: 'daily',
      scheduleValue: '03:00',
      scheduleTz: 'server',
      nextRunAt: '2026-09-16T19:00:00.000Z',
    })
    assert.equal(serverTz.scheduleTz, 'server')
    const updated = await updateScheduleTask(serverTz.id, { scheduleTz: 'beijing' })
    assert.equal(updated?.scheduleTz, 'beijing')
  })

  it('filters due tasks by enabled + next_run_at <= now', async () => {
    const instanceId = await seedInstance()
    const due = await createScheduleTask({
      id: newScheduleTaskId(),
      instanceId,
      kind: 'restart',
      scheduleType: 'interval',
      scheduleValue: '24',
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    })
    const future = await createScheduleTask({
      id: newScheduleTaskId(),
      instanceId,
      kind: 'backup',
      scheduleType: 'interval',
      scheduleValue: '24',
      nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    })
    await createScheduleTask({
      id: newScheduleTaskId(),
      instanceId,
      kind: 'backup',
      scheduleType: 'interval',
      scheduleValue: '24',
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      enabled: false,
    })
    const dueTasks = await listDueScheduleTasks(new Date().toISOString())
    assert.ok(dueTasks.some(t => t.id === due.id))
    assert.ok(!dueTasks.some(t => t.id === future.id))

    const enabled = await listEnabledScheduleTasks()
    assert.ok(enabled.some(t => t.id === due.id))
    assert.ok(enabled.some(t => t.id === future.id), 'future tasks are still enabled, just not due yet')
  })

  it('updates run result and reschedules without losing other fields', async () => {
    const instanceId = await seedInstance()
    const task = await createScheduleTask({
      id: newScheduleTaskId(),
      instanceId,
      kind: 'backup',
      scheduleType: 'daily',
      scheduleValue: '04:30',
      nextRunAt: new Date().toISOString(),
    })
    const updated = await updateScheduleTask(task.id, {
      lastRunAt: '2026-09-15T20:00:00.000Z',
      lastRunStatus: 'ok',
      lastRunMessage: '备份已创建',
      nextRunAt: '2026-09-16T20:30:00.000Z',
    })
    assert.equal(updated?.lastRunStatus, 'ok')
    assert.equal(updated?.scheduleValue, '04:30')

    const disabled = await updateScheduleTask(task.id, { enabled: false })
    assert.equal(disabled?.enabled, false)
    const enabledAgain = await updateScheduleTask(task.id, { enabled: true })
    assert.equal(enabledAgain?.enabled, true)
  })

  it('deletes a task and reports missing ids', async () => {
    const instanceId = await seedInstance()
    const task = await createScheduleTask({
      id: newScheduleTaskId(),
      instanceId,
      kind: 'update_check',
      scheduleType: 'interval',
      scheduleValue: '12',
    })
    assert.equal(await deleteScheduleTask(task.id), true)
    assert.equal(await deleteScheduleTask(task.id), false)
    assert.equal(await getScheduleTaskById(task.id), undefined)
  })

  it('boot recovery reschedules missed enabled tasks as skipped (不补跑)', async () => {
    const instanceId = await seedInstance()
    const missed = await createScheduleTask({
      id: newScheduleTaskId(),
      instanceId,
      kind: 'restart',
      scheduleType: 'daily',
      scheduleValue: '03:00',
      nextRunAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    })
    const futureTask = await createScheduleTask({
      id: newScheduleTaskId(),
      instanceId,
      kind: 'backup',
      scheduleType: 'daily',
      scheduleValue: '23:00',
      nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    })

    await recoverMissedTasksOnBoot(stubApp)

    const missedAfter = await getScheduleTaskById(missed.id)
    assert.equal(missedAfter?.lastRunStatus, 'skipped')
    assert.ok(missedAfter?.lastRunAt, 'missed task should record its original due time')
    const nextAt = Date.parse(missedAfter?.nextRunAt ?? '')
    assert.ok(Number.isFinite(nextAt) && nextAt > Date.now(), 'missed task should be rescheduled into the future')

    const futureAfter = await getScheduleTaskById(futureTask.id)
    assert.equal(futureAfter?.lastRunStatus, null, 'future tasks must not be touched by recovery')
  })

  it('persists the running status while an action is executing', async () => {
    const instanceId = await seedInstance()
    const task = await createScheduleTask({
      id: newScheduleTaskId(),
      instanceId,
      kind: 'backup',
      scheduleType: 'interval',
      scheduleValue: '6',
      nextRunAt: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
    })
    const startedAt = new Date().toISOString()
    const running = await updateScheduleTask(task.id, {
      lastRunAt: startedAt,
      lastRunStatus: 'running',
      lastRunMessage: '执行中…',
    })
    assert.equal(running?.lastRunStatus, 'running', 'running must survive status normalization')
    assert.equal(running?.lastRunAt, startedAt)
    const read = await getScheduleTaskById(task.id)
    assert.equal(read?.lastRunStatus, 'running')
  })

  it('boot recovery clears the running flag left by an interrupted execution', async () => {
    const instanceId = await seedInstance()
    const startedAt = new Date(Date.now() - 5 * 60_000).toISOString()
    const interrupted = await createScheduleTask({
      id: newScheduleTaskId(),
      instanceId,
      kind: 'backup',
      scheduleType: 'interval',
      scheduleValue: '6',
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    })
    await updateScheduleTask(interrupted.id, {
      lastRunAt: startedAt,
      lastRunStatus: 'running',
      lastRunMessage: '执行中…',
    })
    // 已停用任务的残留「执行中」同样需要清理（否则列表永久停在执行中）
    const disabledInterrupted = await createScheduleTask({
      id: newScheduleTaskId(),
      instanceId,
      kind: 'restart',
      scheduleType: 'interval',
      scheduleValue: '12',
      enabled: false,
      nextRunAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    })
    await updateScheduleTask(disabledInterrupted.id, { lastRunStatus: 'running', lastRunMessage: '执行中…' })

    await recoverMissedTasksOnBoot(stubApp)

    const interruptedAfter = await getScheduleTaskById(interrupted.id)
    assert.equal(interruptedAfter?.lastRunStatus, 'failed')
    assert.equal(interruptedAfter?.lastRunAt, startedAt, 'interrupted run keeps its trigger time')
    assert.match(interruptedAfter?.lastRunMessage ?? '', /中断/)
    const nextAt = Date.parse(interruptedAfter?.nextRunAt ?? '')
    assert.ok(Number.isFinite(nextAt) && nextAt > Date.now(), 'interrupted task should be rescheduled into the future')

    const disabledAfter = await getScheduleTaskById(disabledInterrupted.id)
    assert.equal(disabledAfter?.lastRunStatus, 'failed', 'disabled tasks must not keep a stale running flag')
    assert.equal(disabledAfter?.enabled, false)
  })
})
