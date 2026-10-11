import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq } from 'drizzle-orm'
import { backups, systemSettings, users } from './schema/index'
import { ensureDb, nowIso } from './connection'
import type {
  CreateBackupInput,
  DbBackup,
  DbBackupKind,
  DbBackupStatus,
  DbSystemBackupSettings,
} from './types'

const BACKUP_KINDS: DbBackupKind[] = ['manual', 'scheduled', 'pre_update', 'pre_delete', 'pre_restore', 'pre_import', 'pre_rollback', 'pre_reset', 'database']
const BACKUP_STATUSES: DbBackupStatus[] = ['completed', 'failed', 'stale']

function normalizeKind(kind: string | null | undefined): DbBackupKind {
  return BACKUP_KINDS.includes(kind as DbBackupKind) ? kind as DbBackupKind : 'manual'
}

function normalizeStatus(status: string | null | undefined): DbBackupStatus {
  return BACKUP_STATUSES.includes(status as DbBackupStatus) ? status as DbBackupStatus : 'completed'
}

function mapDbBackup(row: {
  id: string
  instanceId: string
  filePath: string
  sizeBytes: number | null
  note: string
  kind: string | null
  status: string | null
  shards: string | null
  createdBy: string
  createdAt: string
}): DbBackup {
  return {
    id: row.id,
    instanceId: row.instanceId,
    filePath: row.filePath,
    sizeBytes: row.sizeBytes === null ? 0 : Number(row.sizeBytes),
    note: row.note,
    kind: normalizeKind(row.kind),
    status: normalizeStatus(row.status),
    shards: row.shards,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
}

export async function createBackupRecord(input: CreateBackupInput): Promise<DbBackup> {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  await drizzleDb.insert(backups).values({
    id: input.id,
    instanceId: input.instanceId,
    filePath: input.filePath,
    sizeBytes: input.sizeBytes,
    note: input.note ?? '',
    kind: input.kind ?? 'manual',
    status: input.status ?? 'completed',
    shards: input.shards ?? null,
    createdBy: input.createdBy ?? '',
    createdAt: now,
  })
  const rows = await drizzleDb.select().from(backups).where(eq(backups.id, input.id)).limit(1)
  return mapDbBackup(rows[0])
}

export async function getBackupById(id: string): Promise<DbBackup | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb.select().from(backups).where(eq(backups.id, id)).limit(1)
  return rows[0] ? mapDbBackup(rows[0]) : undefined
}

export async function listBackups(instanceId?: string): Promise<DbBackup[]> {
  const { drizzleDb } = ensureDb()
  // 兼容旧版世界维护备份写入的用户 ID，仅在列表中解析账号名。
  const base = drizzleDb.select({ backup: backups, creatorAccount: users.account }).from(backups)
    .leftJoin(users, eq(backups.createdBy, users.id))
  const rows = instanceId
    ? await base.where(eq(backups.instanceId, instanceId)).orderBy(desc(backups.createdAt))
    : await base.orderBy(desc(backups.createdAt))
  return rows.map(row => mapDbBackup({ ...row.backup, createdBy: row.creatorAccount ?? row.backup.createdBy }))
}

/** 保留策略用：按创建时间升序取某实例某来源的最旧记录 */
export async function listBackupsByKindAsc(instanceId: string, kinds: DbBackupKind[]): Promise<DbBackup[]> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select()
    .from(backups)
    .where(and(eq(backups.instanceId, instanceId), eq(backups.status, 'completed')))
    .orderBy(asc(backups.createdAt))
  return rows
    .map(mapDbBackup)
    .filter(row => kinds.includes(row.kind))
}

export async function updateBackupStatus(id: string, status: DbBackupStatus): Promise<void> {
  const { drizzleDb } = ensureDb()
  await drizzleDb.update(backups).set({ status }).where(eq(backups.id, id))
}

export async function deleteBackupRecord(id: string): Promise<boolean> {
  const { drizzleDb } = ensureDb()
  const result = await drizzleDb.delete(backups).where(eq(backups.id, id)).returning({ id: backups.id })
  return result.length > 0
}

export function newBackupId(): string {
  return randomUUID()
}

const BACKUP_SETTINGS_KEY = 'backup.settings'

function normalizeBackupSettings(raw: unknown): DbSystemBackupSettings {
  const defaults: DbSystemBackupSettings = {
    perInstanceRetention: 10,
    dbSnapshotRetention: 5,
    autoBackupBeforeUpdate: true,
    autoBackupBeforeDelete: true,
  }
  if (!raw || typeof raw !== 'object') {
    return defaults
  }
  const value = raw as Partial<DbSystemBackupSettings>
  const clampCount = (input: unknown, fallback: number) => {
    const num = Number(input)
    if (!Number.isFinite(num) || num < 0) {
      return fallback
    }
    return Math.min(200, Math.trunc(num))
  }
  return {
    perInstanceRetention: clampCount(value.perInstanceRetention, defaults.perInstanceRetention),
    dbSnapshotRetention: clampCount(value.dbSnapshotRetention, defaults.dbSnapshotRetention),
    autoBackupBeforeUpdate: typeof value.autoBackupBeforeUpdate === 'boolean'
      ? value.autoBackupBeforeUpdate
      : defaults.autoBackupBeforeUpdate,
    autoBackupBeforeDelete: typeof value.autoBackupBeforeDelete === 'boolean'
      ? value.autoBackupBeforeDelete
      : defaults.autoBackupBeforeDelete,
  }
}

export async function getSystemBackupSettings(): Promise<DbSystemBackupSettings> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, BACKUP_SETTINGS_KEY))
    .limit(1)
  if (!rows[0]?.value) {
    return normalizeBackupSettings(undefined)
  }
  return normalizeBackupSettings(JSON.parse(rows[0].value))
}

export async function saveSystemBackupSettings(settings: Partial<DbSystemBackupSettings>): Promise<DbSystemBackupSettings> {
  const { drizzleDb } = ensureDb()
  const current = await getSystemBackupSettings()
  const merged = normalizeBackupSettings({ ...current, ...settings })
  await drizzleDb
    .insert(systemSettings)
    .values({
      key: BACKUP_SETTINGS_KEY,
      value: JSON.stringify(merged),
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: JSON.stringify(merged),
        updatedAt: nowIso(),
      },
    })
  return merged
}
