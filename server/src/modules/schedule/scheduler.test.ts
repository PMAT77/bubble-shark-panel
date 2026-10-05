import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  closeDatabase,
  createScheduleTask,
  getScheduleTaskById,
  initDatabase,
  updateScheduleTask,
} from '../../shared/db/index'
import { recoverMissedTasksOnBoot } from './scheduler'

/**
 * 计划任务的启动恢复行为。
 *
 * 「错过不补跑只顺延」直接决定「凌晨的定时重启会不会在面板重启后突然补跑」，
 * 而中断中的任务若不处理就会永久停在「执行中」；这两条此前只有 `computeNextRunAt`
 * 的纯函数测试，恢复逻辑本身没有覆盖。
 */

const dbFilePath = path.join(os.tmpdir(), `bsp-schedule-boot-test-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

interface LogEntry {
  payload: unknown
  message: string
}

function createStubApp(): { app: never, warns: LogEntry[], infos: LogEntry[] } {
  const warns: LogEntry[] = []
  const infos: LogEntry[] = []
  const app = {
    log: {
      warn: (payload: unknown, message: string) => { warns.push({ payload, message }) },
      info: (payload: unknown, message: string) => { infos.push({ payload, message }) },
      error: () => {},
      debug: () => {},
    },
  } as never
  return { app, warns, infos }
}

type ScheduleTaskInput = Parameters<typeof createScheduleTask>[0]

function baseTaskInput(overrides: Partial<ScheduleTaskInput> = {}): ScheduleTaskInput {
  return {
    id: `st-${randomUUID()}`,
    instanceId: 'inst-test',
    kind: 'restart',
    scheduleType: 'interval',
    scheduleValue: '6',
    ...overrides,
  }
}

describe('schedule boot recovery', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
  })

  after(() => {
    closeDatabase()
  })

  it('离线期间错过的任务顺延到下一周期，不补跑', async () => {
    const { app } = createStubApp()
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    const task = await createScheduleTask(baseTaskInput({ nextRunAt: past }))

    await recoverMissedTasksOnBoot(app)

    const updated = await getScheduleTaskById(task.id)
    assert.equal(updated?.lastRunStatus, 'skipped')
    assert.match(updated?.lastRunMessage ?? '', /顺延/)
    assert.ok(
      updated?.nextRunAt && Date.parse(updated.nextRunAt) > Date.now(),
      '顺延后的时间必须落在未来，否则下一轮 tick 会立刻补跑',
    )
  })

  it('上次执行被中断的任务标记为失败，不静默停在执行中', async () => {
    const { app } = createStubApp()
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const task = await createScheduleTask(baseTaskInput({ nextRunAt: future }))
    await updateScheduleTask(task.id, { lastRunStatus: 'running', lastRunMessage: '执行中…' })

    await recoverMissedTasksOnBoot(app)

    const updated = await getScheduleTaskById(task.id)
    assert.equal(updated?.lastRunStatus, 'failed')
    assert.match(updated?.lastRunMessage ?? '', /中断/)
  })

  it('未到期的任务保持原样', async () => {
    const { app } = createStubApp()
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    const task = await createScheduleTask(baseTaskInput({ nextRunAt: future }))

    await recoverMissedTasksOnBoot(app)

    const updated = await getScheduleTaskById(task.id)
    assert.equal(updated?.lastRunStatus, null)
    assert.equal(updated?.nextRunAt, future)
  })

  it('scheduleValue 非法的过期任务只告警，不改动记录', async () => {
    const { app, warns } = createStubApp()
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const task = await createScheduleTask(baseTaskInput({
      scheduleType: 'daily',
      scheduleValue: '25:99',
      nextRunAt: past,
    }))

    await recoverMissedTasksOnBoot(app)

    const updated = await getScheduleTaskById(task.id)
    assert.equal(updated?.lastRunStatus, null)
    assert.equal(updated?.nextRunAt, past)
    assert.ok(
      warns.some(entry => /scheduleValue 非法/.test(entry.message)),
      '非法 scheduleValue 必须留下告警，否则任务会静默停止调度',
    )
  })
})
