import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, afterEach, before, beforeEach, it, mock } from 'node:test'
import Fastify from 'fastify'
import { abortableDelay } from '../../shared/abort'
import { addUserInstanceGrants, closeDatabase, createGameInstance, createScheduleTask, findUserByAccount, getGameInstanceById, getScheduleTaskById, initDatabase, updateGameInstanceRuntime, updateScheduleTask } from '../../shared/db'
import { withInstanceContentActivity, withInstanceContentOperation } from '../../shared/instance-content/operation'
import { subscribePanelEvent, type PanelEvent } from '../notify/events'
import { registerAuthModule } from '../auth'
import { registerScheduleModule } from '../schedule'
import { startScheduleTask } from '../schedule/task-runner'
import { recoverMissedTasksOnBoot } from '../schedule/scheduler'
import { registerInstanceScheduledOps } from './scheduled-entry'
import { cancelScheduledUpdate, cleanupInterruptedScheduledUpdate, isScheduledUpdateActive, runScheduledUpdate, scheduledUpdateOperations } from './scheduled-update'
import { changeStartupPhase, createStartupTask, enqueueStartupTask, persistStartupTask, releaseStartupTask, waitForStartupTask } from './startup-state'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-scheduled-update-'))
const app = Fastify()
const previousRetry = process.env.BSP_STEAMCMD_INSTALL_RETRY_DELAYS_MS
let id = ''
let token = ''
let attempts = 0
let starts = 0
let stops = 0
let successOn = 1
let messages: string[] = []
let delays: number[] = []
let events: PanelEvent[] = []
let unsubscribe = () => {}

function startup(status: 'success' | 'failed' = 'success') {
  const task = createStartupTask(id)
  task.snapshot.status = status
  task.snapshot.phase = status === 'success' ? 'ready' : 'failed'
  task.snapshot.master.state = status === 'success' ? 'ready' : 'failed'
  task.snapshot.caves.state = 'disabled'
  if (status === 'failed') task.snapshot.diagnosis = { code: 'timeout', message: '加载超时' }
  releaseStartupTask(task)
  return task.snapshot
}
const start = async () => { starts++; return { ok: true, taskId: 'startup-current' } }
const run = () => runScheduledUpdate(app, id, start, async message => { messages.push(message) })

async function until(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 200; n++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('等待任务阶段超时')
}

before(async () => {
  await initDatabase(path.join(root, 'test.sqlite'), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle'), {
    seedDevelopmentUsers: false, adminUsername: 'schedule-test', adminPassword: '123456',
  })
  registerAuthModule(app)
  registerScheduleModule(app)
  await app.ready()
  const login = await app.inject({ method: 'POST', url: '/app/account/login', payload: { account: 'schedule-test', password: '123456' } })
  token = login.json().data.token
})

beforeEach(async () => {
  delete process.env.BSP_STEAMCMD_INSTALL_RETRY_DELAYS_MS
  id = (await createGameInstance({ nodeId: 'local-node', name: '定时更新测试', gameCode: '343050', status: 'running', installPath: root })).id
  await addUserInstanceGrants((await findUserByAccount('schedule-test'))!.id, [id], null)
  attempts = 0; starts = 0; stops = 0; successOn = 1; messages = []; delays = []; events = []
  unsubscribe = subscribePanelEvent(event => { events.push(event) })
  mock.method(scheduledUpdateOperations, 'stop', async (instanceId: string) => {
    stops++
    await updateGameInstanceRuntime(instanceId, { status: 'stopped', containerId: null })
  })
  mock.method(scheduledUpdateOperations, 'cancelInstall', async () => {})
  mock.method(scheduledUpdateOperations, 'install', async () => {
    attempts++
    assert.equal((await getGameInstanceById(id))?.status, 'stopped')
    return { ok: attempts === successOn, cancelled: false, cleanupPending: false, message: '下载失败' }
  })
  mock.method(scheduledUpdateOperations, 'retryDelay', async (ms: number) => { delays.push(ms) })
  mock.method(scheduledUpdateOperations, 'waitForStartup', async () => startup())
  registerInstanceScheduledOps({
    restart: async () => ({ ok: true }),
    update: (currentApp, instanceId, progress) => runScheduledUpdate(currentApp, instanceId, start, progress),
    recoverUpdate: cleanupInterruptedScheduledUpdate,
  })
})

afterEach(() => { unsubscribe(); mock.restoreAll(); registerInstanceScheduledOps(null) })
after(async () => {
  await app.close()
  closeDatabase()
  fs.rmSync(root, { recursive: true, force: true })
  if (previousRetry === undefined) delete process.env.BSP_STEAMCMD_INSTALL_RETRY_DELAYS_MS
  else process.env.BSP_STEAMCMD_INSTALL_RETRY_DELAYS_MS = previousRetry
})

for (const attempt of [1, 2, 3]) {
  it(`第 ${attempt} 次更新成功后只启动一次，复用默认退避间隔`, async () => {
    successOn = attempt
    const result = await run()
    assert.equal(result.status, 'ok')
    assert.equal(attempts, attempt)
    assert.equal(starts, 1)
    assert.equal(stops, 1)
    assert.deepEqual(delays, [5000, 10000].slice(0, attempt - 1))
    assert.ok(messages.some(message => message.includes(`第 ${attempt}/3 次`)))
  })
}

it('原本停止且版本最新的实例仍执行文件更新并启动', async () => {
  await updateGameInstanceRuntime(id, { status: 'stopped', updateAvailable: false, localBuildId: '123', remoteBuildId: '123' })
  assert.equal((await run()).status, 'ok')
  assert.equal(attempts, 1)
  assert.equal(starts, 1)
})

it('三次失败后停用任务、持久化停机原因并仅发布一次失败事件', async () => {
  successOn = 99
  const task = await createScheduleTask({ id: `task-${id}`, instanceId: id, kind: 'update', scheduleType: 'interval', scheduleValue: '1' })
  const execution = await startScheduleTask(app, task)
  assert.ok(execution.completion)
  const result = await execution.completion
  assert.equal(result.status, 'failed')
  assert.match(result.message, /3\/3.*实例已停止.*任务已停用/)
  assert.equal(attempts, 3)
  assert.equal(starts, 0)
  const saved = await getScheduleTaskById(task.id)
  assert.equal(saved?.enabled, false)
  assert.equal(saved?.nextRunAt, null)
  assert.equal(saved?.lastRunStatus, 'failed')
  assert.equal((await getGameInstanceById(id))?.status, 'stopped')
  assert.equal((await getGameInstanceById(id))?.lastError, '下载失败')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'scheduled_update_failed')
  assert.equal(events[0].occurrenceKey, `${task.id}:${saved?.lastRunAt}`)
  assert.ok((await startScheduleTask(app, task)).error)
  await recoverMissedTasksOnBoot(app)
  assert.equal((await getScheduleTaskById(task.id))?.lastRunMessage, saved?.lastRunMessage)
  assert.equal(events.length, 1)
})

it('备份失败不启动，仍受三次预算限制；显式重试间隔配置生效', async () => {
  process.env.BSP_STEAMCMD_INSTALL_RETRY_DELAYS_MS = '17,29'
  mock.method(scheduledUpdateOperations, 'install', async () => { attempts++; throw new Error('更新前备份失败，已停止更新') })
  const result = await run()
  assert.equal(result.status, 'failed')
  assert.equal(attempts, 3)
  assert.equal(starts, 0)
  assert.deepEqual(delays, [17, 29])
})

it('停服失败不开始更新，通知不能声称已经停机', async () => {
  mock.method(scheduledUpdateOperations, 'stop', async () => { throw new Error('运行时不可达') })
  const result = await run()
  assert.equal(result.status, 'failed')
  assert.match(result.message, /未能确认实例停止/)
  assert.equal(attempts, 0)
  assert.equal(starts, 0)
})

it('安装清理未完成时立即中止，不能开始第二次更新或启动', async () => {
  mock.method(scheduledUpdateOperations, 'install', async () => { attempts++; return { ok: false, cancelled: false, cleanupPending: true, message: 'SteamCMD 尚未停止' } })
  const result = await run()
  assert.equal(result.status, 'failed')
  assert.match(result.message, /清理未完成/)
  assert.equal(attempts, 1)
  assert.equal(starts, 0)
})

it('更新后启动失败清理分片，不重新更新', async () => {
  mock.method(scheduledUpdateOperations, 'waitForStartup', async () => startup('failed'))
  const result = await run()
  assert.equal(result.status, 'failed')
  assert.match(result.message, /更新完成，启动失败.*加载超时.*实例已停止/)
  assert.equal(result.disableTask, true)
  assert.equal(attempts, 1)
  assert.equal(starts, 1)
  assert.equal(stops, 2)
})

it('手动停止能取消退避等待，不再更新或启动', async () => {
  successOn = 99
  mock.method(scheduledUpdateOperations, 'retryDelay', async (ms: number, signal: AbortSignal) => {
    delays.push(ms)
    await abortableDelay(10000, signal)
  })
  const completion = run()
  await until(() => delays.length === 1)
  await cancelScheduledUpdate(id)
  const result = await completion
  assert.equal(result.status, 'skipped')
  assert.equal(result.disableTask, true)
  assert.match(result.message, /用户手动停止.*实例已停止/)
  assert.equal(attempts, 1)
  assert.equal(starts, 0)
  assert.equal(isScheduledUpdateActive(id), false)
})

it('安装阶段取消会等待安装退出，不能留下晚到的启动', async () => {
  mock.method(scheduledUpdateOperations, 'install', async (_app: unknown, _id: string, signal: AbortSignal) => {
    attempts++
    await new Promise<void>(resolve => signal.addEventListener('abort', () => { resolve() }, { once: true }))
    return { ok: false, cancelled: true, cleanupPending: false, message: '已取消' }
  })
  const completion = run()
  await until(() => attempts === 1)
  await cancelScheduledUpdate(id)
  assert.equal((await completion).status, 'skipped')
  assert.equal(starts, 0)
  assert.equal(stops, 2)
})

it('等待启动就绪期间保持互斥，同实例冲突任务跳过', async () => {
  let finish = () => {}
  mock.method(scheduledUpdateOperations, 'waitForStartup', async () => {
    await new Promise<void>(resolve => { finish = resolve })
    return startup()
  })
  let finished = false
  const completion = run().then(result => { finished = true; return result })
  await until(() => starts === 1)
  assert.equal(finished, false)
  await assert.rejects(withInstanceContentActivity(id, async () => {}), /正在执行/)
  assert.equal((await run()).status, 'skipped')
  finish()
  assert.equal((await completion).status, 'ok')
  await withInstanceContentActivity(id, async () => {})
})

it('安装中或内存保护实例跳过，不停机也不自动启动', async () => {
  await updateGameInstanceRuntime(id, { status: 'installing' })
  assert.equal((await run()).status, 'skipped')
  await updateGameInstanceRuntime(id, { status: 'stopped', runtimeFailureKind: 'memory_protection' })
  assert.equal((await run()).status, 'skipped')
  assert.equal(stops, 0)
  assert.equal(attempts, 0)
})

it('立即执行先返回受理、拒绝重复触发，终态由共享执行器写回', async () => {
  let finish = () => {}
  mock.method(scheduledUpdateOperations, 'waitForStartup', async () => {
    await new Promise<void>(resolve => { finish = resolve })
    return startup()
  })
  const task = await createScheduleTask({ id: `task-${id}`, instanceId: id, kind: 'update', scheduleType: 'daily', scheduleValue: '04:30' })
  const post = () => app.inject({ method: 'POST', url: '/app/schedule/run-now', headers: { token }, payload: { taskId: task.id } })
  const accepted = await post()
  assert.equal(accepted.json().data.triggered, true)
  assert.equal((await getScheduleTaskById(task.id))?.lastRunStatus, 'running')
  const duplicate = await post()
  assert.match(duplicate.json().error, /正在执行/)
  await until(() => starts === 1)
  finish()
  await until(() => !isScheduledUpdateActive(id))
  await until(async () => (await getScheduleTaskById(task.id))?.lastRunStatus === 'ok')
  assert.equal((await getScheduleTaskById(task.id))?.lastRunStatus, 'ok')
  assert.equal(events.length, 0)
})

it('重启恢复清理分片并停用中断任务，重复恢复不覆盖原因或重复告警', async () => {
  const task = await createScheduleTask({ id: `task-${id}`, instanceId: id, kind: 'update', scheduleType: 'daily', scheduleValue: '04:30' })
  await updateScheduleTask(task.id, { lastRunAt: new Date().toISOString(), lastRunStatus: 'running' })
  await recoverMissedTasksOnBoot(app)
  const failed = await getScheduleTaskById(task.id)
  assert.equal(failed?.enabled, false)
  assert.equal(failed?.lastRunStatus, 'failed')
  assert.match(failed?.lastRunMessage ?? '', /中断.*实例已停止.*任务已停用/)
  assert.equal(stops, 1)
  assert.equal(events.length, 1)
  await recoverMissedTasksOnBoot(app)
  assert.equal(events.length, 1)
  assert.equal((await getScheduleTaskById(task.id))?.lastRunMessage, failed?.lastRunMessage)
})

it('跨实例启动队列保留互斥上下文，等待指定任务真正就绪', async () => {
  const first = createStartupTask(`other-${id}`)
  let release = () => {}
  let firstStarted = false
  enqueueStartupTask(first, async () => {
    firstStarted = true
    await new Promise<void>(resolve => { release = resolve })
  })
  await until(() => firstStarted)
  let entered = false
  await withInstanceContentOperation(id, async () => {
    const task = createStartupTask(id)
    enqueueStartupTask(task, async () => {
      await withInstanceContentActivity(id, async () => { entered = true; await changeStartupPhase(task, 'ready') })
    })
    assert.equal(entered, false)
    release()
    const ready = await waitForStartupTask(id, task.snapshot.taskId, AbortSignal.timeout(3000))
    assert.equal(ready.status, 'success')
    assert.equal(ready.phase, 'ready')
    assert.equal(entered, true)
    releaseStartupTask(task)
  })
  releaseStartupTask(first)
})

it('启动恢复清理失败也要撤销持久化的启动检查点，防止自动恢复旧启动', async () => {
  const startupTask = createStartupTask(id)
  await persistStartupTask(startupTask)
  releaseStartupTask(startupTask)
  mock.method(scheduledUpdateOperations, 'cancelInstall', async () => { throw new Error('运行时不可达') })
  assert.match(await cleanupInterruptedScheduledUpdate(id), /未能确认实例停止/)
  assert.equal((await getGameInstanceById(id))?.lastStartupReport?.status, 'cancelled')
  assert.equal(starts, 0)
})
