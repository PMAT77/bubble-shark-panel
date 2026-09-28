import { randomUUID } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { and, asc, eq, isNull, or } from 'drizzle-orm'
import {
  authSessions,
  serverNodes,
  systemSettings,
  userPermissions,
  users,
} from './schema/index'
import {
  ensureDb,
  nowIso,
  hashPassword,
  hashSessionToken,
  generateSessionToken,
  toIsoFromMs,
  isExpiredAt,
  getAuthForcePasswordChangeState,
  saveAuthForcePasswordChangeState,
} from './connection'
import type {
  DbServerNode,
  DbSystemNetworkConfig,
  DbSystemPanelSettings,
  DbSystemSteamcmdConfig,
  SaveServerNodeInput,
  SessionTokenBundle,
} from './types'

export * from './types'
export { closeDatabase, initDatabase, verifyPassword } from './connection'
export * from './instance-repository'
export * from './rbac-repository'
export * from './backup-repository'
export * from './schedule-repository'
export * from './notify-repository'
export * from './player-profile-repository'

interface DbUserRow {
  id: string
  account: string
  password_hash: string
  email: string
  avatar: string
  status: number
  must_change_password: number
  updated_at: string
}

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000
const REFRESH_TOKEN_REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000


export function userMustChangePassword(user: Pick<DbUserRow, 'must_change_password'>): boolean {
  return user.must_change_password === 1
}

/** 清除强制改密标记，并结束安装阶段的 FORCE_PASSWORD_CHANGE 待办（改密成功时由 updateUserPassword 处理） */
export async function consumeFirstLoginPasswordChangePrompt(userId: string) {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  await drizzleDb
    .update(users)
    .set({
      mustChangePassword: 0,
      updatedAt: now,
    })
    .where(
      and(
        eq(users.id, userId),
        eq(users.mustChangePassword, 1),
      ),
    )

  const state = await getAuthForcePasswordChangeState()
  if (state?.pending) {
    await saveAuthForcePasswordChangeState({
      pending: false,
      completed: true,
    })
  }
}

export async function findUserByAccount(account: string): Promise<DbUserRow | undefined> {
  const { drizzleDb } = ensureDb()
  const result = await drizzleDb
    .select({
      id: users.id,
      account: users.account,
      password_hash: users.passwordHash,
      email: users.email,
      avatar: users.avatar,
      status: users.status,
      must_change_password: users.mustChangePassword,
      updated_at: users.updatedAt,
    })
    .from(users)
    .where(
      and(
        eq(users.account, account),
        eq(users.status, 1),
      ),
    )
    .limit(1)
  return result[0]
}

export async function createSession(token: string, userId: string) {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  await drizzleDb.insert(authSessions).values({
    token,
    tokenHash: null,
    refreshTokenHash: null,
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: null,
    refreshExpiresAt: null,
    rotatedAt: null,
    lastSeenIp: null,
    userAgent: null,
    revokedAt: null,
  })
}

export async function createSessionTokens(
  userId: string,
  options: {
    remember?: boolean
    ip?: string
    userAgent?: string
  } = {},
): Promise<SessionTokenBundle> {
  const { drizzleDb } = ensureDb()
  const nowMs = Date.now()
  const now = toIsoFromMs(nowMs)
  const accessExpiresInMs = ACCESS_TOKEN_TTL_MS
  const refreshExpiresInMs = options.remember ? REFRESH_TOKEN_REMEMBER_TTL_MS : REFRESH_TOKEN_TTL_MS
  const accessExpiresAt = toIsoFromMs(nowMs + accessExpiresInMs)
  const refreshExpiresAt = toIsoFromMs(nowMs + refreshExpiresInMs)
  const accessToken = generateSessionToken('atk')
  const refreshToken = generateSessionToken('rtk')

  await drizzleDb.insert(authSessions).values({
    token: randomUUID(),
    tokenHash: hashSessionToken(accessToken),
    refreshTokenHash: hashSessionToken(refreshToken),
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: accessExpiresAt,
    refreshExpiresAt,
    rotatedAt: null,
    lastSeenIp: options.ip ?? null,
    userAgent: options.userAgent ?? null,
    revokedAt: null,
  })

  return {
    accessToken,
    refreshToken,
    accessExpiresAt,
    refreshExpiresAt,
    accessExpiresInSec: Math.floor(accessExpiresInMs / 1000),
    refreshExpiresInSec: Math.floor(refreshExpiresInMs / 1000),
  }
}

export async function revokeSession(token: string) {
  const { drizzleDb } = ensureDb()
  const tokenHash = hashSessionToken(token)
  await drizzleDb
    .update(authSessions)
    .set({
      revokedAt: nowIso(),
    })
    .where(
      and(
        or(
          eq(authSessions.token, token),
          eq(authSessions.tokenHash, tokenHash),
          eq(authSessions.refreshTokenHash, tokenHash),
        ),
        isNull(authSessions.revokedAt),
      ),
    )
}

export async function revokeSessionsByUserId(userId: string) {
  const { drizzleDb } = ensureDb()
  await drizzleDb
    .update(authSessions)
    .set({
      revokedAt: nowIso(),
    })
    .where(
      and(
        eq(authSessions.userId, userId),
        isNull(authSessions.revokedAt),
      ),
    )
}

export async function findUserByToken(token: string): Promise<DbUserRow | undefined> {
  const { drizzleDb } = ensureDb()
  const tokenHash = hashSessionToken(token)
  const now = nowIso()
  const result = await drizzleDb
    .select({
      sessionToken: authSessions.token,
      expiresAt: authSessions.expiresAt,
      id: users.id,
      account: users.account,
      password_hash: users.passwordHash,
      email: users.email,
      avatar: users.avatar,
      status: users.status,
      must_change_password: users.mustChangePassword,
      updated_at: users.updatedAt,
    })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(
      and(
        or(
          eq(authSessions.tokenHash, tokenHash),
          eq(authSessions.token, token),
        ),
        isNull(authSessions.revokedAt),
        eq(users.status, 1),
      ),
    )
    .limit(1)
  const row = result[0]
  if (!row) {
    return undefined
  }
  if (isExpiredAt(row.expiresAt)) {
    // access token 过期后应允许客户端使用 refresh token 续期，
    // 这里不能直接撤销整条会话记录（否则会连带使 refresh token 失效）。
    return undefined
  }
  await drizzleDb
    .update(authSessions)
    .set({
      lastSeenAt: now,
    })
    .where(eq(authSessions.token, row.sessionToken))
  return {
    id: row.id,
    account: row.account,
    password_hash: row.password_hash,
    email: row.email,
    avatar: row.avatar,
    status: row.status,
    must_change_password: row.must_change_password,
    updated_at: row.updated_at,
  }
}

export async function rotateSessionByRefreshToken(
  refreshToken: string,
  options: {
    ip?: string
    userAgent?: string
  } = {},
): Promise<{ user: Pick<DbUserRow, 'id' | 'account' | 'email' | 'avatar' | 'must_change_password'>, tokens: SessionTokenBundle } | undefined> {
  const { drizzleDb } = ensureDb()
  const nowMs = Date.now()
  const now = toIsoFromMs(nowMs)
  const refreshTokenHash = hashSessionToken(refreshToken)
  const row = (await drizzleDb
    .select({
      sessionToken: authSessions.token,
      refreshExpiresAt: authSessions.refreshExpiresAt,
      createdAt: authSessions.createdAt,
      userId: users.id,
      account: users.account,
      email: users.email,
      avatar: users.avatar,
      mustChangePassword: users.mustChangePassword,
    })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(
      and(
        eq(authSessions.refreshTokenHash, refreshTokenHash),
        isNull(authSessions.revokedAt),
        eq(users.status, 1),
      ),
    )
    .limit(1))[0]

  if (!row) {
    return undefined
  }
  if (isExpiredAt(row.refreshExpiresAt, nowMs)) {
    await revokeSession(refreshToken)
    return undefined
  }

  await drizzleDb
    .update(authSessions)
    .set({
      revokedAt: now,
      rotatedAt: now,
    })
    .where(eq(authSessions.token, row.sessionToken))

  const createdAtMs = Date.parse(row.createdAt)
  const refreshExpiresAtMs = row.refreshExpiresAt ? Date.parse(row.refreshExpiresAt) : Number.NaN
  const remember = !Number.isNaN(createdAtMs)
    && !Number.isNaN(refreshExpiresAtMs)
    && refreshExpiresAtMs - createdAtMs > REFRESH_TOKEN_TTL_MS

  const tokens = await createSessionTokens(row.userId, {
    remember,
    ip: options.ip,
    userAgent: options.userAgent,
  })

  return {
    user: {
      id: row.userId,
      account: row.account,
      email: row.email,
      avatar: row.avatar,
      must_change_password: row.mustChangePassword,
    },
    tokens,
  }
}

export async function findPermissionsByUserId(userId: string): Promise<string[]> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({
      permission: userPermissions.permission,
    })
    .from(userPermissions)
    .where(eq(userPermissions.userId, userId))
    .orderBy(asc(userPermissions.permission))
  return rows.map(row => row.permission)
}

export async function updateUserPassword(
  userId: string,
  newPassword: string,
  options: { keepSessions?: boolean } = {},
) {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  await drizzleDb
    .update(users)
    .set({
      passwordHash: hashPassword(newPassword),
      mustChangePassword: 0,
      updatedAt: now,
    })
    .where(eq(users.id, userId))

  if (!options.keepSessions) {
    await revokeSessionsByUserId(userId)
  }

  const state = await getAuthForcePasswordChangeState()
  if (state?.pending) {
    await saveAuthForcePasswordChangeState({
      pending: false,
      completed: true,
    })
  }
}

export async function getSystemNetworkConfig(): Promise<DbSystemNetworkConfig | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({
      value: systemSettings.value,
    })
    .from(systemSettings)
    .where(eq(systemSettings.key, 'network.config'))
    .limit(1)

  const row = rows[0]
  if (!row?.value) {
    return undefined
  }
  return JSON.parse(row.value) as DbSystemNetworkConfig
}

export async function saveSystemNetworkConfig(config: DbSystemNetworkConfig) {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  await drizzleDb
    .insert(systemSettings)
    .values({
      key: 'network.config',
      value: JSON.stringify(config),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: JSON.stringify(config),
        updatedAt: now,
      },
    })
}

/** 面板端口出厂默认；与 server/src/modules/system/defaults.ts 保持一致（生产 compose 发布端口默认 9527） */
const DEFAULT_PANEL_PORT = 9527

function normalizePanelSettings(raw: unknown): DbSystemPanelSettings {
  if (!raw || typeof raw !== 'object') {
    return {
      panelPort: DEFAULT_PANEL_PORT,
      theme: 'system',
      autoUpdate: true,
      checkUpdateBeforeStart: false,
      updateCheckIntervalHours: 3,
      updateSource: 'auto',
    }
  }
  const value = raw as Partial<DbSystemPanelSettings>
  const panelPort = Number.isInteger(value.panelPort) ? value.panelPort as number : DEFAULT_PANEL_PORT
  const theme = value.theme === 'light' || value.theme === 'dark' || value.theme === 'system'
    ? value.theme
    : 'system'
  return {
    panelPort: panelPort > 0 && panelPort <= 65535 ? panelPort : DEFAULT_PANEL_PORT,
    theme,
    autoUpdate: typeof value.autoUpdate === 'boolean' ? value.autoUpdate : true,
    checkUpdateBeforeStart: typeof value.checkUpdateBeforeStart === 'boolean'
      ? value.checkUpdateBeforeStart
      : false,
    updateCheckIntervalHours: Number.isFinite(value.updateCheckIntervalHours)
      && (value.updateCheckIntervalHours as number) > 0
      ? Math.min(168, Math.max(1, Math.trunc(value.updateCheckIntervalHours as number)))
      : 1,
    updateSource: value.updateSource === 'offline' || value.updateSource === 'pull'
      ? value.updateSource
      : 'auto',
  }
}

function normalizeSteamcmdConfig(raw: unknown): DbSystemSteamcmdConfig {
  const defaultConfig: DbSystemSteamcmdConfig = {
    steamcmdPath: process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd',
    installRoot: process.platform === 'win32'
      ? path.resolve(process.cwd(), 'data', 'instances')
      : '/var/lib/game-server-hub/instances',
  }
  if (!raw || typeof raw !== 'object') {
    return defaultConfig
  }
  const value = raw as Partial<DbSystemSteamcmdConfig>
  const steamcmdPath = value.steamcmdPath?.trim() || defaultConfig.steamcmdPath
  const installRoot = value.installRoot?.trim() || defaultConfig.installRoot
  return {
    steamcmdPath,
    installRoot,
  }
}

export async function getSystemPanelSettings(): Promise<DbSystemPanelSettings | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({
      value: systemSettings.value,
    })
    .from(systemSettings)
    .where(eq(systemSettings.key, 'panel.settings'))
    .limit(1)

  const row = rows[0]
  if (!row?.value) {
    return undefined
  }
  return normalizePanelSettings(JSON.parse(row.value))
}

export async function saveSystemPanelSettings(settings: DbSystemPanelSettings) {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  await drizzleDb
    .insert(systemSettings)
    .values({
      key: 'panel.settings',
      value: JSON.stringify(settings),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: JSON.stringify(settings),
        updatedAt: now,
      },
    })
}

export async function getSystemSteamcmdConfig(): Promise<DbSystemSteamcmdConfig | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({
      value: systemSettings.value,
    })
    .from(systemSettings)
    .where(eq(systemSettings.key, 'steamcmd.config'))
    .limit(1)
  const row = rows[0]
  if (!row?.value) {
    return undefined
  }
  return normalizeSteamcmdConfig(JSON.parse(row.value))
}

export async function saveSystemSteamcmdConfig(config: DbSystemSteamcmdConfig) {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  const normalized = normalizeSteamcmdConfig(config)
  await drizzleDb
    .insert(systemSettings)
    .values({
      key: 'steamcmd.config',
      value: JSON.stringify(normalized),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: JSON.stringify(normalized),
        updatedAt: now,
      },
    })
}

function normalizeNodeUsage(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(100, Number(value.toFixed(2))))
}

export async function saveServerNode(input: SaveServerNodeInput): Promise<DbServerNode> {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  const payload: DbServerNode = {
    id: input.id,
    name: input.name,
    host: input.host,
    sshPort: Number.isInteger(input.sshPort) ? input.sshPort as number : 22,
    status: input.status ?? 'offline',
    cpuUsage: normalizeNodeUsage(input.cpuUsage),
    memoryUsage: normalizeNodeUsage(input.memoryUsage),
    diskUsage: normalizeNodeUsage(input.diskUsage),
    lastHeartbeatAt: input.lastHeartbeatAt ?? null,
    createdAt: now,
    updatedAt: now,
  }
  await drizzleDb
    .insert(serverNodes)
    .values(payload)
    .onConflictDoUpdate({
      target: serverNodes.id,
      set: {
        name: payload.name,
        host: payload.host,
        sshPort: payload.sshPort,
        status: payload.status,
        cpuUsage: payload.cpuUsage,
        memoryUsage: payload.memoryUsage,
        diskUsage: payload.diskUsage,
        lastHeartbeatAt: payload.lastHeartbeatAt,
        updatedAt: now,
      },
    })
  const current = await getServerNodeById(input.id)
  if (!current) {
    throw new Error(`server node upsert failed: ${input.id}`)
  }
  return current
}

export async function getServerNodeById(id: string): Promise<DbServerNode | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({
      id: serverNodes.id,
      name: serverNodes.name,
      host: serverNodes.host,
      sshPort: serverNodes.sshPort,
      status: serverNodes.status,
      cpuUsage: serverNodes.cpuUsage,
      memoryUsage: serverNodes.memoryUsage,
      diskUsage: serverNodes.diskUsage,
      lastHeartbeatAt: serverNodes.lastHeartbeatAt,
      createdAt: serverNodes.createdAt,
      updatedAt: serverNodes.updatedAt,
    })
    .from(serverNodes)
    .where(eq(serverNodes.id, id))
    .limit(1)
  const row = rows[0]
  if (!row) {
    return undefined
  }
  return {
    ...row,
    status: row.status === 'online' ? 'online' : 'offline',
    cpuUsage: Number(row.cpuUsage),
    memoryUsage: Number(row.memoryUsage),
    diskUsage: Number(row.diskUsage),
  }
}

export async function listServerNodes(): Promise<DbServerNode[]> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({
      id: serverNodes.id,
      name: serverNodes.name,
      host: serverNodes.host,
      sshPort: serverNodes.sshPort,
      status: serverNodes.status,
      cpuUsage: serverNodes.cpuUsage,
      memoryUsage: serverNodes.memoryUsage,
      diskUsage: serverNodes.diskUsage,
      lastHeartbeatAt: serverNodes.lastHeartbeatAt,
      createdAt: serverNodes.createdAt,
      updatedAt: serverNodes.updatedAt,
    })
    .from(serverNodes)
    .orderBy(asc(serverNodes.createdAt))
  return rows.map(row => ({
    ...row,
    status: row.status === 'online' ? 'online' : 'offline',
    cpuUsage: Number(row.cpuUsage),
    memoryUsage: Number(row.memoryUsage),
    diskUsage: Number(row.diskUsage),
  }))
}
