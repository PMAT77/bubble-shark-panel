import { randomUUID } from 'node:crypto'
import { and, asc, eq, lte } from 'drizzle-orm'
import { scheduledTasks } from './schema/index'
import { ensureDb, nowIso } from './connection'
import type {
  CreateScheduleTaskInput,
  DbScheduleRunStatus,
  DbScheduledTask,
  DbScheduleTaskKind,
  DbScheduleTimezone,
  DbScheduleType,
  UpdateScheduleTaskInput,
} from './types'

const TASK_KINDS: DbScheduleTaskKind[] = ['restart', 'backup', 'update', 'db_snapshot']
const SCHEDULE_TYPES: DbScheduleType[] = ['interval', 'daily']
const SCHEDULE_TIMEZONES: DbScheduleTimezone[] = ['beijing', 'server']
const RUN_STATUSES: DbScheduleRunStatus[] = ['running', 'ok', 'failed', 'skipped']

function normalizeKind(kind: string | null | undefined): DbScheduleTaskKind {
  return TASK_KINDS.includes(kind as DbScheduleTaskKind) ? kind as DbScheduleTaskKind : 'backup'
}

function normalizeType(type: string | null | undefined): DbScheduleType {
  return SCHEDULE_TYPES.includes(type as DbScheduleType) ? type as DbScheduleType : 'daily'
}

function normalizeScheduleTz(tz: string | null | undefined): DbScheduleTimezone {
  return SCHEDULE_TIMEZONES.includes(tz as DbScheduleTimezone) ? tz as DbScheduleTimezone : 'beijing'
}

function normalizeRunStatus(status: string | null | undefined): DbScheduleRunStatus | null {
  return RUN_STATUSES.includes(status as DbScheduleRunStatus) ? status as DbScheduleRunStatus : null
}

function mapDbScheduledTask(row: {
  id: string
  instanceId: string
  kind: string | null
  scheduleType: string | null
  scheduleValue: string
  scheduleTz: string | null
  enabled: number | null
  lastRunAt: string | null
  lastRunStatus: string | null
  lastRunMessage: string | null
  nextRunAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}): DbScheduledTask {
  return {
    id: row.id,
    instanceId: row.instanceId,
    kind: normalizeKind(row.kind),
    scheduleType: normalizeType(row.scheduleType),
    scheduleValue: row.scheduleValue,
    scheduleTz: normalizeScheduleTz(row.scheduleTz),
    enabled: row.enabled === 1,
    lastRunAt: row.lastRunAt,
    lastRunStatus: normalizeRunStatus(row.lastRunStatus),
    lastRunMessage: row.lastRunMessage,
    nextRunAt: row.nextRunAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const TASK_COLUMNS = {
  id: scheduledTasks.id,
  instanceId: scheduledTasks.instanceId,
  kind: scheduledTasks.kind,
  scheduleType: scheduledTasks.scheduleType,
  scheduleValue: scheduledTasks.scheduleValue,
  scheduleTz: scheduledTasks.scheduleTz,
  enabled: scheduledTasks.enabled,
  lastRunAt: scheduledTasks.lastRunAt,
  lastRunStatus: scheduledTasks.lastRunStatus,
  lastRunMessage: scheduledTasks.lastRunMessage,
  nextRunAt: scheduledTasks.nextRunAt,
  createdBy: scheduledTasks.createdBy,
  createdAt: scheduledTasks.createdAt,
  updatedAt: scheduledTasks.updatedAt,
}

export function newScheduleTaskId(): string {
  return `st-${randomUUID()}`
}

export async function createScheduleTask(input: CreateScheduleTaskInput): Promise<DbScheduledTask> {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  await drizzleDb.insert(scheduledTasks).values({
    id: input.id,
    instanceId: input.instanceId,
    kind: input.kind,
    scheduleType: input.scheduleType,
    scheduleValue: input.scheduleValue,
    scheduleTz: input.scheduleTz ?? 'beijing',
    enabled: input.enabled === false ? 0 : 1,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMessage: null,
    nextRunAt: input.nextRunAt ?? null,
    createdBy: input.createdBy ?? '',
    createdAt: now,
    updatedAt: now,
  })
  const rows = await drizzleDb.select().from(scheduledTasks).where(eq(scheduledTasks.id, input.id)).limit(1)
  return mapDbScheduledTask(rows[0])
}

export async function getScheduleTaskById(id: string): Promise<DbScheduledTask | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb.select(TASK_COLUMNS).from(scheduledTasks).where(eq(scheduledTasks.id, id)).limit(1)
  return rows[0] ? mapDbScheduledTask(rows[0]) : undefined
}

export async function listScheduleTasks(instanceId?: string): Promise<DbScheduledTask[]> {
  const { drizzleDb } = ensureDb()
  const base = drizzleDb.select(TASK_COLUMNS).from(scheduledTasks)
  const rows = instanceId
    ? await base.where(eq(scheduledTasks.instanceId, instanceId)).orderBy(asc(scheduledTasks.createdAt))
    : await base.orderBy(asc(scheduledTasks.createdAt))
  return rows.map(mapDbScheduledTask)
}

export async function listEnabledScheduleTasks(): Promise<DbScheduledTask[]> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select(TASK_COLUMNS)
    .from(scheduledTasks)
    .where(eq(scheduledTasks.enabled, 1))
    .orderBy(asc(scheduledTasks.nextRunAt))
  return rows.map(mapDbScheduledTask)
}

/** 到期任务：启用且 next_run_at <= now（错过的任务也包含在内，由调度器决定补跑或跳过） */
export async function listDueScheduleTasks(now: string): Promise<DbScheduledTask[]> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select(TASK_COLUMNS)
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.enabled, 1), lte(scheduledTasks.nextRunAt, now)))
    .orderBy(asc(scheduledTasks.nextRunAt))
  return rows.map(mapDbScheduledTask)
}

export async function updateScheduleTask(id: string, input: UpdateScheduleTaskInput): Promise<DbScheduledTask | undefined> {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  await drizzleDb
    .update(scheduledTasks)
    .set({
      ...(input.scheduleType === undefined ? {} : { scheduleType: input.scheduleType }),
      ...(input.scheduleValue === undefined ? {} : { scheduleValue: input.scheduleValue }),
      ...(input.scheduleTz === undefined ? {} : { scheduleTz: input.scheduleTz }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled ? 1 : 0 }),
      ...(input.lastRunAt === undefined ? {} : { lastRunAt: input.lastRunAt }),
      ...(input.lastRunStatus === undefined ? {} : { lastRunStatus: input.lastRunStatus }),
      ...(input.lastRunMessage === undefined ? {} : { lastRunMessage: input.lastRunMessage }),
      ...(input.nextRunAt === undefined ? {} : { nextRunAt: input.nextRunAt }),
      updatedAt: now,
    })
    .where(eq(scheduledTasks.id, id))
  return getScheduleTaskById(id)
}

export async function deleteScheduleTask(id: string): Promise<boolean> {
  const { drizzleDb } = ensureDb()
  const result = await drizzleDb.delete(scheduledTasks).where(eq(scheduledTasks.id, id)).returning({ id: scheduledTasks.id })
  return result.length > 0
}

/** 全局启用中的某 kind 任务计数（db_snapshot 全库快照只允许一个启用任务） */
export async function countEnabledTasksByKind(kind: DbScheduleTaskKind): Promise<number> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({ id: scheduledTasks.id })
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.enabled, 1), eq(scheduledTasks.kind, kind)))
  return rows.length
}
