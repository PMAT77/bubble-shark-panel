import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { eq } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import { migrate } from 'drizzle-orm/sqlite-proxy/migrator'
import type { AdminCredentialOutcome } from '../config/credentials-file'
import { ALL_PERMISSIONS } from '../../../../shared/constants/permissions'
import { OPS_MANAGE_PERMISSION, OPS_READ_PERMISSION, SYSTEM_MANAGE_PERMISSION, SYSTEM_READ_PERMISSION } from '../menu-routes'
import type { RbacMigrationOutcome } from './rbac-migration'
import {
  systemSettings,
  userPermissions,
  users,
} from './schema/index'

interface InitDatabaseOptions {
  forcePasswordChange?: boolean
  adminUsername?: string
  adminPassword?: string
  /** 为 true 时，每次启动用 env 中的 ADMIN_PASSWORD 覆盖已有管理员密码（用于 panel.env 找回） */
  syncAdminPasswordFromEnv?: boolean
  /** 开发/测试环境种子账号（superadmin/test）；生产环境应关闭 */
  seedDevelopmentUsers?: boolean
  /** 管理员凭证落库结果回调；调用方据此决定是否落盘初始凭据文件 */
  onAdminCredentialOutcome?: (outcome: AdminCredentialOutcome) => void
  /** RBAC 迁移结果回调；只在真的跑过迁移时触发（第二次启动起不再触发） */
  onRbacMigrationOutcome?: (outcome: RbacMigrationOutcome) => void
}

interface AuthForcePasswordChangeState {
  pending: boolean
  completed: boolean
}

interface DbDefaultUserSeed {
  account: string
  password: string
  email: string
  avatar: string
  permissions: string[]
}

const AUTH_FORCE_PASSWORD_CHANGE_KEY = 'auth.force_password_change'
const ADMIN_DEFAULT_PERMISSIONS = [
  'pages.general:browse',
  'pages.form:browse',
  'pages.list:browse',
  'pages.shop:browse',
  'pages.node.instance:manage',
  SYSTEM_READ_PERMISSION,
  SYSTEM_MANAGE_PERMISSION,
  OPS_READ_PERMISSION,
  OPS_MANAGE_PERMISSION,
]
const defaultUserSeeds: DbDefaultUserSeed[] = [
  {
    account: 'superadmin',
    password: '123456',
    email: 'superadmin@game.com',
    avatar: 'https://api.dicebear.com/9.x/bottts-neutral/svg?seed=superadmin',
    permissions: [
      'pages.general:browse',
      'pages.form:browse',
      'pages.list:browse',
      'pages.shop:browse',
      'pages.node.instance:manage',
      SYSTEM_READ_PERMISSION,
      SYSTEM_MANAGE_PERMISSION,
      OPS_READ_PERMISSION,
      OPS_MANAGE_PERMISSION,
    ],
  },
  {
    account: 'test',
    password: '123456',
    email: 'test@game.com',
    avatar: 'https://api.dicebear.com/9.x/bottts-neutral/svg?seed=test',
    permissions: ['pages.general:browse'],
  },
]

let sqliteDb: DatabaseSync | undefined
let drizzleDb: ReturnType<typeof drizzle> | undefined

export function nowIso() {
  return new Date().toISOString()
}

export function hashPassword(password: string, salt = randomUUID()) {
  const derivedKey = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${derivedKey}`
}

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function generateSessionToken(prefix: 'atk' | 'rtk') {
  return `${prefix}_${randomBytes(32).toString('hex')}`
}

export function toIsoFromMs(valueMs: number) {
  return new Date(valueMs).toISOString()
}

export function isExpiredAt(iso: string | null | undefined, nowMs = Date.now()) {
  if (!iso) {
    return false
  }
  const expiresMs = Date.parse(iso)
  if (Number.isNaN(expiresMs)) {
    return false
  }
  return expiresMs <= nowMs
}

export function verifyPassword(password: string, storedHash: string) {
  const [salt, hashed] = storedHash.split(':')
  if (!salt || !hashed) {
    return false
  }
  const passwordBuffer = scryptSync(password, salt, 64)
  const hashBuffer = Buffer.from(hashed, 'hex')
  if (passwordBuffer.length !== hashBuffer.length) {
    return false
  }
  return timingSafeEqual(passwordBuffer, hashBuffer)
}

export function ensureDb() {
  if (!sqliteDb || !drizzleDb) {
    throw new Error('SQLite database is not initialized')
  }
  return {
    sqliteDb,
    drizzleDb,
  }
}

function tableHasColumn(database: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return rows.some(row => row.name === columnName)
}

function ensureColumn(database: DatabaseSync, tableName: string, columnName: string, columnDefinition: string) {
  if (tableHasColumn(database, tableName, columnName)) {
    return
  }
  database.exec(`ALTER TABLE ${tableName} ADD ${columnName} ${columnDefinition}`)
}

function ensureSchemaCompatibility(database: DatabaseSync) {
  const usersTableExists = database.prepare(`
    SELECT 1 AS ok
    FROM sqlite_master
    WHERE type = 'table' AND name = 'users'
    LIMIT 1
  `).get() as { ok: number } | undefined
  if (!usersTableExists) {
    return
  }

  ensureColumn(database, 'users', 'must_change_password', 'integer DEFAULT 0 NOT NULL')

  const authSessionsTableExists = database.prepare(`
    SELECT 1 AS ok
    FROM sqlite_master
    WHERE type = 'table' AND name = 'auth_sessions'
    LIMIT 1
  `).get() as { ok: number } | undefined
  if (authSessionsTableExists) {
    ensureColumn(database, 'auth_sessions', 'token_hash', 'text')
    ensureColumn(database, 'auth_sessions', 'refresh_token_hash', 'text')
    ensureColumn(database, 'auth_sessions', 'expires_at', 'text')
    ensureColumn(database, 'auth_sessions', 'refresh_expires_at', 'text')
    ensureColumn(database, 'auth_sessions', 'rotated_at', 'text')
    ensureColumn(database, 'auth_sessions', 'last_seen_ip', 'text')
    ensureColumn(database, 'auth_sessions', 'user_agent', 'text')
    database.exec('CREATE INDEX IF NOT EXISTS auth_sessions_token_hash_idx ON auth_sessions(token_hash)')
    database.exec('CREATE INDEX IF NOT EXISTS auth_sessions_refresh_token_hash_idx ON auth_sessions(refresh_token_hash)')
  }

  const gameInstancesTableExists = database.prepare(`
    SELECT 1 AS ok
    FROM sqlite_master
    WHERE type = 'table' AND name = 'game_instances'
    LIMIT 1
  `).get() as { ok: number } | undefined
  if (!gameInstancesTableExists) {
    return
  }

  ensureColumn(database, 'game_instances', 'runtime_pid', 'integer')
  ensureColumn(database, 'game_instances', 'runtime_started_at', 'text')
  ensureColumn(database, 'game_instances', 'last_command', 'text')
  ensureColumn(database, 'game_instances', 'last_exit_code', 'integer')
  ensureColumn(database, 'game_instances', 'last_error', 'text')
  ensureColumn(database, 'game_instances', 'runtime_warning', 'text')
  // install_log_* 由 drizzle 0003 迁移维护，勿在此 ensureColumn，避免与未入账的 0003 SQL 重复 ADD
}

function isDuplicateColumnSqliteError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const withCode = error as Error & { code?: string, errcode?: number }
  if (withCode.code === 'ERR_SQLITE_ERROR' && withCode.errcode === 1) {
    return /duplicate column name/i.test(error.message)
  }
  return /duplicate column name/i.test(error.message)
}

function execMigrationQuery(database: DatabaseSync, query: string) {
  try {
    database.exec(query)
  }
  catch (error) {
    if (isDuplicateColumnSqliteError(error)) {
      return
    }
    throw error
  }
}

async function applyMigrations(migrationsFolder: string) {
  const { sqliteDb, drizzleDb } = ensureDb()
  sqliteDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `)
  bootstrapLegacyMigrationBaseline(sqliteDb, migrationsFolder)
  await migrate(
    drizzleDb,
    async (queries) => {
      for (const query of queries) {
        execMigrationQuery(sqliteDb, query)
      }
    },
    { migrationsFolder },
  )
  ensureSchemaCompatibility(sqliteDb)
  // 旧库若曾通过历史 ensureColumn 写入 install_log_* 但 0003 未入账，补列后仍保证三列存在
  ensureColumn(sqliteDb, 'game_instances', 'install_log_status', 'text')
  ensureColumn(sqliteDb, 'game_instances', 'install_percent', 'integer')
  ensureColumn(sqliteDb, 'game_instances', 'install_log_updated_at', 'text')
  ensureColumn(sqliteDb, 'game_instances', 'update_available', 'integer DEFAULT 0 NOT NULL')
  ensureColumn(sqliteDb, 'game_instances', 'local_build_id', 'text')
  ensureColumn(sqliteDb, 'game_instances', 'remote_build_id', 'text')
  ensureColumn(sqliteDb, 'game_instances', 'update_checked_at', 'text')
  // instance_mods 建表在 0000 迁移；旧库若从未建过该表则跳过补列，避免 ALTER 崩初始化
  const instanceModsTableExists = sqliteDb.prepare(`
    SELECT 1 AS ok
    FROM sqlite_master
    WHERE type = 'table' AND name = 'instance_mods'
    LIMIT 1
  `).get() as { ok: number } | undefined
  if (instanceModsTableExists) {
    ensureColumn(sqliteDb, 'instance_mods', 'config', 'text')
  }
  await runPostMigration0008ModFileSync()
}

const MIGRATION_0008_MOD_FILES_SYNCED_KEY = 'migration.0008_mod_files_synced'

/**
 * 跑一次 RBAC 迁移（老权限点 → 细粒度 RBAC）。
 *
 * 用动态 import：`rbac-migration.ts` 顶部静态依赖本模块的 `ensureDb`/`nowIso`，
 * 在本模块加载期间静态引用它会形成循环导入。
 */
async function runRbacMigration(): Promise<RbacMigrationOutcome> {
  const { migrateRbacFromLegacy } = await import('./rbac-migration')
  return migrateRbacFromLegacy({ allPermissions: ALL_PERMISSIONS })
}

async function runPostMigration0008ModFileSync() {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({
      value: systemSettings.value,
    })
    .from(systemSettings)
    .where(eq(systemSettings.key, MIGRATION_0008_MOD_FILES_SYNCED_KEY))
    .limit(1)
  if (rows[0]?.value === '1') {
    return
  }
  const { syncAllLocalDstInstanceModFilesFromDb } = await import('../../modules/mod/mod-file-sync-service.ts')
  await syncAllLocalDstInstanceModFilesFromDb()
  const now = nowIso()
  await drizzleDb
    .insert(systemSettings)
    .values({
      key: MIGRATION_0008_MOD_FILES_SYNCED_KEY,
      value: '1',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: '1',
        updatedAt: now,
      },
    })
}

function bootstrapLegacyMigrationBaseline(database: DatabaseSync, migrationsFolder: string) {
  const migrationsTable = '__drizzle_migrations'
  const usersTableExists = database.prepare(`
    SELECT 1 AS ok
    FROM sqlite_master
    WHERE type = 'table' AND name = 'users'
    LIMIT 1
  `).get() as { ok: number } | undefined

  if (!usersTableExists) {
    return
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS ${migrationsTable} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    );
  `)
  const migrationExists = database.prepare(`
    SELECT 1 AS ok
    FROM ${migrationsTable}
    LIMIT 1
  `).get() as { ok: number } | undefined

  if (migrationExists) {
    return
  }

  const migrations = readMigrationFiles({ migrationsFolder })
  const baselineMigration = migrations[0]
  if (!baselineMigration) {
    return
  }
  // 仅标记首条迁移为已应用，避免旧库跳过 0001/0002 等后续增量 SQL。
  database.prepare(`
    INSERT INTO ${migrationsTable} (hash, created_at)
    VALUES (?, ?)
  `).run(baselineMigration.hash, baselineMigration.folderMillis)
}

async function seedDefaultUsers() {
  const { drizzleDb } = ensureDb()
  const now = nowIso()

  for (const user of defaultUserSeeds) {
    const existing = await drizzleDb
      .select({ id: users.id })
      .from(users)
      .where(eq(users.account, user.account))
      .limit(1)
    const existingUser = existing[0]
    const userId = existingUser?.id ?? randomUUID()
    if (!existingUser) {
      await drizzleDb.insert(users).values({
        id: userId,
        account: user.account,
        passwordHash: hashPassword(user.password),
        email: user.email,
        avatar: user.avatar,
        status: 1,
        mustChangePassword: 0,
        createdAt: now,
        updatedAt: now,
      })
    }
    for (const permission of user.permissions) {
      await drizzleDb
        .insert(userPermissions)
        .values({
          userId,
          permission,
          createdAt: now,
        })
        .onConflictDoNothing()
    }
  }
}

function parseAuthForcePasswordChangeState(raw: string | undefined): AuthForcePasswordChangeState | undefined {
  if (!raw) {
    return undefined
  }
  try {
    const value = JSON.parse(raw) as Partial<AuthForcePasswordChangeState>
    if (typeof value.pending !== 'boolean' || typeof value.completed !== 'boolean') {
      return undefined
    }
    return {
      pending: value.pending,
      completed: value.completed,
    }
  }
  catch {
    return undefined
  }
}

export async function getAuthForcePasswordChangeState(): Promise<AuthForcePasswordChangeState | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({
      value: systemSettings.value,
    })
    .from(systemSettings)
    .where(eq(systemSettings.key, AUTH_FORCE_PASSWORD_CHANGE_KEY))
    .limit(1)
  return parseAuthForcePasswordChangeState(rows[0]?.value)
}

export async function saveAuthForcePasswordChangeState(state: AuthForcePasswordChangeState) {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  await drizzleDb
    .insert(systemSettings)
    .values({
      key: AUTH_FORCE_PASSWORD_CHANGE_KEY,
      value: JSON.stringify(state),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: JSON.stringify(state),
        updatedAt: now,
      },
    })
}

async function setMustChangePasswordForAccount(account: string, mustChange: boolean) {
  const { drizzleDb } = ensureDb()
  await drizzleDb
    .update(users)
    .set({
      mustChangePassword: mustChange ? 1 : 0,
      updatedAt: nowIso(),
    })
    .where(eq(users.account, account))
}

async function seedAdminUserFromEnv(options: InitDatabaseOptions) {
  const adminUsername = options.adminUsername?.trim() ?? ''
  const adminPassword = options.adminPassword ?? ''
  if (!adminUsername || !adminPassword) {
    options.onAdminCredentialOutcome?.('absent')
    return
  }

  const { drizzleDb } = ensureDb()
  const now = nowIso()
  const existing = await drizzleDb
    .select({ id: users.id })
    .from(users)
    .where(eq(users.account, adminUsername))
    .limit(1)
  const userId = existing[0]?.id ?? randomUUID()
  const mustChangePassword = options.forcePasswordChange ? 1 : 0

  if (!existing[0]) {
    await drizzleDb.insert(users).values({
      id: userId,
      account: adminUsername,
      passwordHash: hashPassword(adminPassword),
      email: `${adminUsername}@local`,
      avatar: `https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${adminUsername}`,
      status: 1,
      mustChangePassword,
      createdAt: now,
      updatedAt: now,
    })
    options.onAdminCredentialOutcome?.('created')
  }
  else if (options.syncAdminPasswordFromEnv) {
    await drizzleDb
      .update(users)
      .set({
        passwordHash: hashPassword(adminPassword),
        mustChangePassword,
        updatedAt: now,
      })
      .where(eq(users.id, userId))
    options.onAdminCredentialOutcome?.('updated')
  }
  else {
    options.onAdminCredentialOutcome?.('skipped')
  }

  for (const permission of ADMIN_DEFAULT_PERMISSIONS) {
    await drizzleDb
      .insert(userPermissions)
      .values({
        userId,
        permission,
        createdAt: now,
      })
      .onConflictDoNothing()
  }
}

async function applyForcePasswordChangePolicy(options: InitDatabaseOptions) {
  if (!options.forcePasswordChange) {
    return
  }

  const adminAccount = options.adminUsername?.trim() || 'superadmin'
  const state = await getAuthForcePasswordChangeState()
  if (state?.completed) {
    return
  }

  await setMustChangePasswordForAccount(adminAccount, true)
  await saveAuthForcePasswordChangeState({
    pending: true,
    completed: false,
  })
}

export function closeDatabase() {
  if (sqliteDb) {
    sqliteDb.close()
    sqliteDb = undefined
    drizzleDb = undefined
  }
}

export async function initDatabase(
  dbPath: string,
  migrationsFolder: string,
  options: InitDatabaseOptions = {},
) {
  closeDatabase()
  const absolutePath = path.resolve(dbPath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  sqliteDb = new DatabaseSync(absolutePath)
  drizzleDb = drizzle(async (query, params, method) => {
    if (!sqliteDb) {
      throw new Error('SQLite database is not initialized')
    }
    const stmt = sqliteDb.prepare(query)

    switch (method) {
      case 'run':
        stmt.run(...params)
        return { rows: [] }
      case 'get': {
        stmt.setReturnArrays(true)
        const row = stmt.get(...params)
        return { rows: row ? row as unknown as unknown[] : [] }
      }
      case 'values':
        stmt.setReturnArrays(true)
        return { rows: stmt.all(...params) as unknown[] }
      case 'all':
      default:
        stmt.setReturnArrays(true)
        return { rows: stmt.all(...params) as unknown[] }
    }
  })
  await applyMigrations(path.resolve(migrationsFolder))
  if (options.seedDevelopmentUsers !== false) {
    await seedDefaultUsers()
  }
  await seedAdminUserFromEnv(options)
  await applyForcePasswordChangePolicy(options)
  // 必须排在用户播种之后：新装环境的管理员还没建出来时迁移会空转，而且没有第二次机会
  const rbacOutcome = await runRbacMigration()
  if (rbacOutcome.ran) {
    options.onRbacMigrationOutcome?.(rbacOutcome)
  }
  return absolutePath
}
