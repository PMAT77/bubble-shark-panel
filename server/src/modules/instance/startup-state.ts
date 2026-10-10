import { randomUUID } from 'node:crypto'
import type { InstanceStartupSnapshot } from '../../../../shared/contracts/instance-resources'
import { updateGameInstanceRuntime } from '../../shared/db'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'

export interface StartupTask {
  instanceId: string
  controller: AbortController
  snapshot: InstanceStartupSnapshot
}

const tasks = new Map<string, StartupTask>()
const writes = new Map<string, Promise<void>>()
const progressCursors = new WeakMap<StartupTask, { lastId: number, seen: Set<string> }>()

export function refreshStartupProgress(task: StartupTask): void {
  let cursor = progressCursors.get(task)
  if (!cursor) { cursor = { lastId: 0, seen: new Set() }; progressCursors.set(task, cursor) }
  for (const line of instanceConsoleLogStore.listLogs(task.instanceId, cursor.lastId, 2000)) {
    cursor.lastId = Math.max(cursor.lastId, line.id)
    if (line.stream !== 'stdout' || Date.parse(line.at) < Date.parse(task.snapshot.startedAt)
      || /SteamNetworkingSockets|IsP2PPacketAvailable|IPC function call|BSPSTART:|RemoteCommandInput/.test(line.text)) continue
    // 去除时间前缀，重复 IPC / 查询或同样的加载行不算新进展。
    const text = line.text.replace(/^\[\d+:\d+:\d+\]:\s*/, '')
    if (cursor.seen.has(text)) continue
    cursor.seen.add(text)
    if (cursor.seen.size > 4000) cursor.seen.delete(cursor.seen.values().next().value!)
    task.snapshot.lastProgressAt = line.at
  }
}
const queue: Array<{ task: StartupTask, run: () => Promise<void> }> = []
let draining = false

export function startupIsActive(snapshot: InstanceStartupSnapshot | null | undefined): boolean {
  return snapshot?.status === 'queued' || snapshot?.status === 'running'
}

export function currentStartupTask(instanceId: string): StartupTask | undefined {
  return tasks.get(instanceId)
}

export function releaseStartupTask(task: StartupTask): void {
  if (tasks.get(task.instanceId) === task) tasks.delete(task.instanceId)
}

/** 面板退出只中断监控，保留检查点供下次恢复原期限。 */
export async function suspendStartupTasks(): Promise<void> {
  await Promise.all([...tasks.values()].map(async (task) => {
    task.controller.abort()
    if (startupIsActive(task.snapshot)) await persistStartupTask(task).catch(() => {})
    releaseStartupTask(task)
  }))
}

export function isCurrentStartupTask(task: StartupTask): boolean {
  return tasks.get(task.instanceId) === task && !task.controller.signal.aborted
}

export function startupSummary(snapshot: InstanceStartupSnapshot, now = Date.now()): InstanceStartupSnapshot {
  const at = startupIsActive(snapshot) ? now : Date.parse(snapshot.updatedAt)
  return {
    ...snapshot,
    elapsedSeconds: Math.max(0, Math.floor((at - Date.parse(snapshot.startedAt)) / 1000)),
    remainingSeconds: startupIsActive(snapshot) && snapshot.phaseDeadlineAt
      ? Math.max(0, Math.ceil((Date.parse(snapshot.phaseDeadlineAt) - now) / 1000))
      : null,
  }
}

export function getStartupSnapshot(instanceId: string, fallback?: InstanceStartupSnapshot | null): InstanceStartupSnapshot | null {
  const snapshot = tasks.get(instanceId)?.snapshot ?? fallback
  return snapshot ? startupSummary(snapshot) : null
}

/** 同实例的检查点按顺序写入；旧任务的迟到写入不能覆盖新启动。 */
export async function persistStartupTask(task: StartupTask): Promise<void> {
  const snapshot = structuredClone(startupSummary(task.snapshot))
  const previous = writes.get(task.instanceId) ?? Promise.resolve()
  const write = previous.catch(() => {}).then(async () => {
    if (tasks.get(task.instanceId) !== task) return
    await updateGameInstanceRuntime(task.instanceId, { lastStartupReport: snapshot })
  })
  writes.set(task.instanceId, write)
  try { await write }
  finally { if (writes.get(task.instanceId) === write) writes.delete(task.instanceId) }
}

export function createStartupTask(instanceId: string, previous?: InstanceStartupSnapshot): StartupTask {
  const at = new Date().toISOString()
  const task: StartupTask = {
    instanceId,
    controller: new AbortController(),
    snapshot: previous ? structuredClone(previous) : {
      taskId: randomUUID(), status: 'queued', phase: 'queued',
      startedAt: at, phaseStartedAt: at, phaseDeadlineAt: null, updatedAt: at,
      elapsedSeconds: 0, remainingSeconds: null, lastProgressAt: at,
      master: { state: 'pending', memoryPeakMb: null },
      caves: { state: 'pending', memoryPeakMb: null }, diagnosis: null,
    },
  }
  tasks.set(instanceId, task)
  return task
}

export async function changeStartupPhase(
  task: StartupTask,
  phase: InstanceStartupSnapshot['phase'],
  deadlineAt: string | null = null,
): Promise<void> {
  if (!isCurrentStartupTask(task)) return
  const at = new Date().toISOString()
  task.snapshot = { ...task.snapshot, phase, phaseStartedAt: at, phaseDeadlineAt: deadlineAt, updatedAt: at,
    status: phase === 'ready' ? 'success' : phase === 'failed' ? 'failed' : phase === 'cancelled' ? 'cancelled' : 'running' }
  await persistStartupTask(task)
}

export function cancelStartupTask(instanceId: string): void {
  const task = tasks.get(instanceId)
  if (!task) return
  task.controller.abort()
  if (!startupIsActive(task.snapshot)) return
  task.snapshot = { ...task.snapshot, status: 'cancelled', phase: 'cancelled',
    phaseDeadlineAt: null, updatedAt: new Date().toISOString(), diagnosis: null }
  // 生命周期调用方会继续执行停机，不让检查点写入阻塞取消信号。
  void persistStartupTask(task).catch(() => {})
}

/** 本地节点同一时间只加载一个实例；排队阶段没有分片 deadline。 */
export function enqueueStartupTask(task: StartupTask, run: () => Promise<void>): void {
  queue.push({ task, run })
  if (draining) return
  draining = true
  setImmediate(() => { void drainQueue() })
}

async function drainQueue(): Promise<void> {
  try {
    while (queue.length) {
      const job = queue.shift()!
      if (!isCurrentStartupTask(job.task)) continue
      try { await job.run() }
      catch (error) {
        if (!isCurrentStartupTask(job.task)) continue
        job.task.snapshot.diagnosis = { code: 'startup_internal_error', message: '启动任务发生异常，请查看控制台' }
        await changeStartupPhase(job.task, 'failed').catch(() => {})
        // run 的调用方负责运行时清理与错误记录。
        if (process.env.BSP_UNIT_TEST !== '1') process.stderr.write(`启动任务异常：${String(error)}\n`)
      }
      finally { job.task.controller.abort() }
    }
  }
  finally { draining = false }
}
