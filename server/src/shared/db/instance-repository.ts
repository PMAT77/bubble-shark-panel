import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import {
  gameInstances,
  instanceMods,
  instanceMaintenanceDrafts,
  instanceMaintenancePushLogs,
} from './schema/index'
import { ensureDb, nowIso } from './connection'
import type {
  CreateGameInstanceInput,
  DbGameInstance,
  DbGameInstanceStatus,
  DbInstanceErrorPhase,
  DbInstanceMod,
  DbInstallLogStatus,
  DbMaintenanceDraft,
  DbMaintenancePushLog,
  DbMaintenancePushStatus,
  InsertMaintenancePushLogInput,
  UpdateGameInstanceRuntimeInput,
} from './types'

/** 失败环节只认这两个值；库里出现别的值（手改、旧版本）一律当未知，展示层按 runtime 兜底 */
function normalizeInstanceErrorPhase(phase: string | null | undefined): DbInstanceErrorPhase | null {
  return phase === 'install' || phase === 'runtime' ? phase : null
}

function normalizeInstanceStatus(status: string | undefined): DbGameInstanceStatus {
  if (status === 'pending_install' || status === 'running' || status === 'stopped' || status === 'installing' || status === 'error') {
    return status
  }
  return 'stopped'
}

function normalizeOptionalPort(value: number | null | undefined): number | null {
  if (value === null || typeof value === 'undefined') {
    return null
  }
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    return null
  }
  return value
}

function mapDbGameInstance(row: {
  id: string
  nodeId: string
  name: string
  gameCode: string
  status: string
  containerId: string | null
  runtimePid: number | null
  runtimeStartedAt: string | null
  installPath: string | null
  configPath: string | null
  queryPort: number | null
  gamePort: number | null
  rconPort: number | null
  lastCommand: string | null
  lastExitCode: number | null
  lastError: string | null
  lastErrorPhase: string | null
  runtimeWarning: string | null
  unexpectedExitAt: string | null
  installLogStatus: string | null
  installPercent: number | null
  installLogUpdatedAt: string | null
  updateAvailable: number | null
  localBuildId: string | null
  remoteBuildId: string | null
  updateCheckedAt: string | null
  createdAt: string
  updatedAt: string
}): DbGameInstance {
  const installLogStatus = row.installLogStatus?.trim()
  return {
    ...row,
    status: normalizeInstanceStatus(row.status),
    runtimePid: row.runtimePid === null ? null : Number(row.runtimePid),
    runtimeStartedAt: row.runtimeStartedAt?.trim() || null,
    queryPort: row.queryPort === null ? null : Number(row.queryPort),
    gamePort: row.gamePort === null ? null : Number(row.gamePort),
    rconPort: row.rconPort === null ? null : Number(row.rconPort),
    lastExitCode: row.lastExitCode === null ? null : Number(row.lastExitCode),
    lastErrorPhase: normalizeInstanceErrorPhase(row.lastErrorPhase),
    installLogStatus: installLogStatus === 'running' || installLogStatus === 'success' || installLogStatus === 'failed'
      ? installLogStatus
      : null,
    installPercent: row.installPercent === null ? null : Number(row.installPercent),
    installLogUpdatedAt: row.installLogUpdatedAt ?? null,
    updateAvailable: Number(row.updateAvailable ?? 0) === 1,
    localBuildId: row.localBuildId ?? null,
    remoteBuildId: row.remoteBuildId ?? null,
    updateCheckedAt: row.updateCheckedAt ?? null,
  }
}

function gameInstanceSelectFields() {
  return {
    id: gameInstances.id,
    nodeId: gameInstances.nodeId,
    name: gameInstances.name,
    gameCode: gameInstances.gameCode,
    status: gameInstances.status,
    containerId: gameInstances.containerId,
    runtimePid: gameInstances.runtimePid,
    runtimeStartedAt: gameInstances.runtimeStartedAt,
    installPath: gameInstances.installPath,
    configPath: gameInstances.configPath,
    queryPort: gameInstances.queryPort,
    gamePort: gameInstances.gamePort,
    rconPort: gameInstances.rconPort,
    lastCommand: gameInstances.lastCommand,
    lastExitCode: gameInstances.lastExitCode,
    lastError: gameInstances.lastError,
    lastErrorPhase: gameInstances.lastErrorPhase,
    runtimeWarning: gameInstances.runtimeWarning,
    unexpectedExitAt: gameInstances.unexpectedExitAt,
    installLogStatus: gameInstances.installLogStatus,
    installPercent: gameInstances.installPercent,
    installLogUpdatedAt: gameInstances.installLogUpdatedAt,
    updateAvailable: gameInstances.updateAvailable,
    localBuildId: gameInstances.localBuildId,
    remoteBuildId: gameInstances.remoteBuildId,
    updateCheckedAt: gameInstances.updateCheckedAt,
    createdAt: gameInstances.createdAt,
    updatedAt: gameInstances.updatedAt,
  }
}

export async function createGameInstance(input: CreateGameInstanceInput): Promise<DbGameInstance> {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  const id = input.id?.trim() || randomUUID()
  await drizzleDb
    .insert(gameInstances)
    .values({
      id,
      nodeId: input.nodeId,
      name: input.name,
      gameCode: input.gameCode,
      status: input.status ?? 'stopped',
      containerId: input.containerId ?? null,
      runtimePid: input.runtimePid ?? null,
      installPath: input.installPath ?? null,
      configPath: input.configPath ?? null,
      queryPort: normalizeOptionalPort(input.queryPort),
      gamePort: normalizeOptionalPort(input.gamePort),
      rconPort: normalizeOptionalPort(input.rconPort),
      lastCommand: input.lastCommand ?? null,
      lastExitCode: input.lastExitCode ?? null,
      lastError: input.lastError ?? null,
      lastErrorPhase: normalizeInstanceErrorPhase(input.lastErrorPhase),
      runtimeWarning: input.runtimeWarning ?? null,
      createdAt: now,
      updatedAt: now,
    })
  const created = await getGameInstanceById(id)
  if (!created) {
    throw new Error(`create game instance failed: ${id}`)
  }
  return created
}

export async function getGameInstanceById(id: string): Promise<DbGameInstance | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select(gameInstanceSelectFields())
    .from(gameInstances)
    .where(eq(gameInstances.id, id))
    .limit(1)
  const row = rows[0]
  if (!row) {
    return undefined
  }
  return mapDbGameInstance(row)
}

export async function listGameInstances(filters?: {
  nodeId?: string
  status?: DbGameInstanceStatus
  keyword?: string
}): Promise<DbGameInstance[]> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select(gameInstanceSelectFields())
    .from(gameInstances)
    .orderBy(asc(gameInstances.createdAt))

  const keyword = filters?.keyword?.trim().toLowerCase() ?? ''
  return rows
    .map(mapDbGameInstance)
    .filter((item) => {
      if (filters?.nodeId && item.nodeId !== filters.nodeId) {
        return false
      }
      if (filters?.status && item.status !== filters.status) {
        return false
      }
      if (!keyword) {
        return true
      }
      return item.name.toLowerCase().includes(keyword)
        || item.gameCode.toLowerCase().includes(keyword)
    })
}

function mapDbInstanceMod(row: {
  id: string
  instanceId: string
  workshopId: string
  name: string
  previewImage: string | null
  enabled: number
  loadOrder: number
  version: string | null
  installStatus: string
  installError: string | null
  localUpdatedAt: string | null
  remoteUpdatedAt: string | null
  updateCheckedAt: string | null
  loadedCopyStale: number
  config: string | null
  retryCount: number
  nextRetryAt: string | null
  createdAt: string
  updatedAt: string
}): DbInstanceMod {
  const installStatus = row.installStatus === 'pending' || row.installStatus === 'failed'
    ? row.installStatus
    : 'ready'
  return {
    ...row,
    enabled: Number(row.enabled) === 1,
    loadOrder: Number(row.loadOrder),
    installStatus,
    installError: row.installError?.trim() || null,
    loadedCopyStale: Number(row.loadedCopyStale) === 1,
    retryCount: Math.max(0, Math.trunc(Number(row.retryCount) || 0)),
    nextRetryAt: row.nextRetryAt?.trim() || null,
  }
}

export async function listReadyInstanceMods(instanceId: string): Promise<DbInstanceMod[]> {
  const mods = await listInstanceMods(instanceId)
  return mods.filter(mod => mod.installStatus === 'ready')
}

export async function listInstanceMods(instanceId: string): Promise<DbInstanceMod[]> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({
      id: instanceMods.id,
      instanceId: instanceMods.instanceId,
      workshopId: instanceMods.workshopId,
      name: instanceMods.name,
      previewImage: instanceMods.previewImage,
      enabled: instanceMods.enabled,
      loadOrder: instanceMods.loadOrder,
      version: instanceMods.version,
      installStatus: instanceMods.installStatus,
      installError: instanceMods.installError,
      localUpdatedAt: instanceMods.localUpdatedAt,
      remoteUpdatedAt: instanceMods.remoteUpdatedAt,
      updateCheckedAt: instanceMods.updateCheckedAt,
      loadedCopyStale: instanceMods.loadedCopyStale,
      config: instanceMods.config,
      retryCount: instanceMods.retryCount,
      nextRetryAt: instanceMods.nextRetryAt,
      createdAt: instanceMods.createdAt,
      updatedAt: instanceMods.updatedAt,
    })
    .from(instanceMods)
    .where(eq(instanceMods.instanceId, instanceId))
    .orderBy(asc(instanceMods.loadOrder), asc(instanceMods.createdAt))
  return rows.map(mapDbInstanceMod)
}

export async function getInstanceModByWorkshopId(instanceId: string, workshopId: string): Promise<DbInstanceMod | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({
      id: instanceMods.id,
      instanceId: instanceMods.instanceId,
      workshopId: instanceMods.workshopId,
      name: instanceMods.name,
      previewImage: instanceMods.previewImage,
      enabled: instanceMods.enabled,
      loadOrder: instanceMods.loadOrder,
      version: instanceMods.version,
      installStatus: instanceMods.installStatus,
      installError: instanceMods.installError,
      localUpdatedAt: instanceMods.localUpdatedAt,
      remoteUpdatedAt: instanceMods.remoteUpdatedAt,
      updateCheckedAt: instanceMods.updateCheckedAt,
      loadedCopyStale: instanceMods.loadedCopyStale,
      config: instanceMods.config,
      retryCount: instanceMods.retryCount,
      nextRetryAt: instanceMods.nextRetryAt,
      createdAt: instanceMods.createdAt,
      updatedAt: instanceMods.updatedAt,
    })
    .from(instanceMods)
    .where(and(
      eq(instanceMods.instanceId, instanceId),
      eq(instanceMods.workshopId, workshopId),
    ))
    .limit(1)
  const row = rows[0]
  return row ? mapDbInstanceMod(row) : undefined
}

export async function upsertInstanceMod(input: {
  instanceId: string
  workshopId: string
  name: string
  previewImage?: string | null
  enabled: boolean
  loadOrder: number
  version?: string | null
  installStatus?: 'pending' | 'ready' | 'failed'
  installError?: string | null
  localUpdatedAt?: string | null
  remoteUpdatedAt?: string | null
  updateCheckedAt?: string | null
  loadedCopyStale?: boolean
  config?: string | null
  retryCount?: number
  nextRetryAt?: string | null
}): Promise<DbInstanceMod> {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  const id = `${input.instanceId}:${input.workshopId}`
  const previewImage = typeof input.previewImage === 'undefined'
    ? undefined
    : (input.previewImage?.trim() || null)
  const installStatus = input.installStatus ?? 'ready'
  const installError = typeof input.installError === 'undefined'
    ? undefined
    : (input.installError?.trim() || null)
  const config = typeof input.config === 'undefined'
    ? undefined
    : (input.config?.trim() || null)
  // 版本时间：undefined = 保留库中原值（订阅/补齐不覆盖检查结果），显式 null = 清空
  const localUpdatedAt = typeof input.localUpdatedAt === 'undefined'
    ? undefined
    : (input.localUpdatedAt?.trim() || null)
  const remoteUpdatedAt = typeof input.remoteUpdatedAt === 'undefined'
    ? undefined
    : (input.remoteUpdatedAt?.trim() || null)
  const updateCheckedAt = typeof input.updateCheckedAt === 'undefined'
    ? undefined
    : (input.updateCheckedAt?.trim() || null)
  // 游戏加载的副本是否陈旧：undefined = 保留库中原值，其余写入 0/1
  const loadedCopyStale = typeof input.loadedCopyStale === 'undefined'
    ? undefined
    : (input.loadedCopyStale ? 1 : 0)
  const retryCount = typeof input.retryCount === 'undefined'
    ? undefined
    : Math.max(0, Math.trunc(input.retryCount))
  const nextRetryAt = typeof input.nextRetryAt === 'undefined'
    ? undefined
    : (input.nextRetryAt?.trim() || null)
  await drizzleDb
    .insert(instanceMods)
    .values({
      id,
      instanceId: input.instanceId,
      workshopId: input.workshopId,
      name: input.name,
      previewImage: previewImage ?? null,
      enabled: input.enabled ? 1 : 0,
      loadOrder: Math.max(0, Math.trunc(input.loadOrder)),
      version: input.version?.trim() || null,
      installStatus,
      installError: installError ?? null,
      localUpdatedAt: localUpdatedAt ?? null,
      remoteUpdatedAt: remoteUpdatedAt ?? null,
      updateCheckedAt: updateCheckedAt ?? null,
      loadedCopyStale: loadedCopyStale ?? 0,
      config: config ?? null,
      retryCount: retryCount ?? 0,
      nextRetryAt: nextRetryAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: instanceMods.id,
      set: {
        name: input.name,
        ...(typeof previewImage !== 'undefined' ? { previewImage } : {}),
        enabled: input.enabled ? 1 : 0,
        loadOrder: Math.max(0, Math.trunc(input.loadOrder)),
        version: input.version?.trim() || null,
        installStatus,
        ...(typeof installError !== 'undefined' ? { installError } : {}),
        ...(typeof localUpdatedAt !== 'undefined' ? { localUpdatedAt } : {}),
        ...(typeof remoteUpdatedAt !== 'undefined' ? { remoteUpdatedAt } : {}),
        ...(typeof updateCheckedAt !== 'undefined' ? { updateCheckedAt } : {}),
        ...(typeof loadedCopyStale !== 'undefined' ? { loadedCopyStale } : {}),
        ...(typeof config !== 'undefined' ? { config } : {}),
        ...(typeof retryCount !== 'undefined' ? { retryCount } : {}),
        ...(typeof nextRetryAt !== 'undefined' ? { nextRetryAt } : {}),
        updatedAt: now,
      },
    })
  const mod = await getInstanceModByWorkshopId(input.instanceId, input.workshopId)
  if (!mod) {
    throw new Error(`mod upsert failed: ${input.instanceId}:${input.workshopId}`)
  }
  return mod
}

export async function updateInstanceModByWorkshopId(
  instanceId: string,
  workshopId: string,
  patch: {
    name?: string
    previewImage?: string | null
    enabled?: boolean
    loadOrder?: number
    version?: string | null
    installStatus?: 'pending' | 'ready' | 'failed'
    installError?: string | null
    localUpdatedAt?: string | null
    remoteUpdatedAt?: string | null
    updateCheckedAt?: string | null
    loadedCopyStale?: boolean
    config?: string | null
    retryCount?: number
    nextRetryAt?: string | null
  },
): Promise<DbInstanceMod | undefined> {
  const { drizzleDb } = ensureDb()
  const payload: {
    name?: string
    previewImage?: string | null
    enabled?: number
    loadOrder?: number
    version?: string | null
    installStatus?: 'pending' | 'ready' | 'failed'
    installError?: string | null
    localUpdatedAt?: string | null
    remoteUpdatedAt?: string | null
    updateCheckedAt?: string | null
    loadedCopyStale?: number
    config?: string | null
    retryCount?: number
    nextRetryAt?: string | null
    updatedAt: string
  } = {
    updatedAt: nowIso(),
  }
  if (typeof patch.name !== 'undefined') {
    payload.name = patch.name
  }
  if (typeof patch.previewImage !== 'undefined') {
    payload.previewImage = patch.previewImage?.trim() || null
  }
  if (typeof patch.enabled !== 'undefined') {
    payload.enabled = patch.enabled ? 1 : 0
  }
  if (typeof patch.loadOrder !== 'undefined') {
    payload.loadOrder = Math.max(0, Math.trunc(patch.loadOrder))
  }
  if (typeof patch.version !== 'undefined') {
    payload.version = patch.version?.trim() || null
  }
  if (typeof patch.installStatus !== 'undefined') {
    payload.installStatus = patch.installStatus
  }
  if (typeof patch.installError !== 'undefined') {
    payload.installError = patch.installError?.trim() || null
  }
  if (typeof patch.localUpdatedAt !== 'undefined') {
    payload.localUpdatedAt = patch.localUpdatedAt?.trim() || null
  }
  if (typeof patch.remoteUpdatedAt !== 'undefined') {
    payload.remoteUpdatedAt = patch.remoteUpdatedAt?.trim() || null
  }
  if (typeof patch.updateCheckedAt !== 'undefined') {
    payload.updateCheckedAt = patch.updateCheckedAt?.trim() || null
  }
  if (typeof patch.loadedCopyStale !== 'undefined') {
    payload.loadedCopyStale = patch.loadedCopyStale ? 1 : 0
  }
  if (typeof patch.config !== 'undefined') {
    payload.config = patch.config?.trim() || null
  }
  if (typeof patch.retryCount !== 'undefined') {
    payload.retryCount = Math.max(0, Math.trunc(patch.retryCount))
  }
  if (typeof patch.nextRetryAt !== 'undefined') {
    payload.nextRetryAt = patch.nextRetryAt?.trim() || null
  }
  await drizzleDb
    .update(instanceMods)
    .set(payload)
    .where(and(
      eq(instanceMods.instanceId, instanceId),
      eq(instanceMods.workshopId, workshopId),
    ))
  return getInstanceModByWorkshopId(instanceId, workshopId)
}

export async function deleteInstanceModByWorkshopId(instanceId: string, workshopId: string): Promise<boolean> {
  const { drizzleDb } = ensureDb()
  const existing = await getInstanceModByWorkshopId(instanceId, workshopId)
  if (!existing) {
    return false
  }
  await drizzleDb
    .delete(instanceMods)
    .where(and(
      eq(instanceMods.instanceId, instanceId),
      eq(instanceMods.workshopId, workshopId),
    ))
  return true
}

/** 清空实例的全部 Mod 记录（存档导入时以源档 modoverrides 为准重建），返回删除条数 */
export async function deleteInstanceModsByInstanceId(instanceId: string): Promise<number> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({ id: instanceMods.id })
    .from(instanceMods)
    .where(eq(instanceMods.instanceId, instanceId))
  await drizzleDb
    .delete(instanceMods)
    .where(eq(instanceMods.instanceId, instanceId))
  return rows.length
}

export async function updateGameInstanceStatus(id: string, status: DbGameInstanceStatus): Promise<DbGameInstance | undefined> {
  const { drizzleDb } = ensureDb()
  await drizzleDb
    .update(gameInstances)
    .set({
      status,
      updatedAt: nowIso(),
    })
    .where(eq(gameInstances.id, id))
  return getGameInstanceById(id)
}

export async function updateGameInstanceRuntime(
  id: string,
  input: UpdateGameInstanceRuntimeInput,
): Promise<DbGameInstance | undefined> {
  const { drizzleDb } = ensureDb()
  const setPayload: {
    status?: DbGameInstanceStatus
    containerId?: string | null
    runtimePid?: number | null
    runtimeStartedAt?: string | null
    gamePort?: number | null
    lastCommand?: string | null
    lastExitCode?: number | null
    lastError?: string | null
    lastErrorPhase?: DbInstanceErrorPhase | null
    runtimeWarning?: string | null
    unexpectedExitAt?: string | null
    installLogStatus?: DbInstallLogStatus | null
    installPercent?: number | null
    installLogUpdatedAt?: string | null
    updateAvailable?: number
    localBuildId?: string | null
    remoteBuildId?: string | null
    updateCheckedAt?: string | null
    updatedAt: string
  } = {
    updatedAt: nowIso(),
  }
  if (typeof input.status !== 'undefined') {
    setPayload.status = input.status
  }
  if (typeof input.containerId !== 'undefined') {
    setPayload.containerId = input.containerId
  }
  if (typeof input.runtimePid !== 'undefined') {
    setPayload.runtimePid = Number.isInteger(input.runtimePid) ? input.runtimePid : null
  }
  if (typeof input.runtimeStartedAt !== 'undefined') {
    setPayload.runtimeStartedAt = input.runtimeStartedAt?.trim() || null
  }
  if (typeof input.gamePort !== 'undefined') {
    setPayload.gamePort = normalizeOptionalPort(input.gamePort)
  }
  if (typeof input.lastCommand !== 'undefined') {
    setPayload.lastCommand = input.lastCommand?.trim() || null
  }
  if (typeof input.lastExitCode !== 'undefined') {
    setPayload.lastExitCode = Number.isInteger(input.lastExitCode) ? input.lastExitCode : null
  }
  if (typeof input.lastError !== 'undefined') {
    const error = input.lastError?.trim() || null
    setPayload.lastError = error
    // 环节与错误同生命周期：错误被清空（启动成功 / 停止实例 / 状态对账）时一并清空，
    // 否则下一次失败若忘了带环节，就会继承上一次的环节。
    if (!error) {
      setPayload.lastErrorPhase = null
    }
  }
  if (typeof input.lastErrorPhase !== 'undefined') {
    setPayload.lastErrorPhase = normalizeInstanceErrorPhase(input.lastErrorPhase)
  }
  if (typeof input.runtimeWarning !== 'undefined') {
    setPayload.runtimeWarning = input.runtimeWarning?.trim() || null
  }
  if (typeof input.unexpectedExitAt !== 'undefined') {
    setPayload.unexpectedExitAt = input.unexpectedExitAt?.trim() || null
  }
  if (typeof input.installLogStatus !== 'undefined') {
    setPayload.installLogStatus = input.installLogStatus
  }
  if (typeof input.installPercent !== 'undefined') {
    const percent = input.installPercent
    setPayload.installPercent = percent === null
      ? null
      : Number.isInteger(percent)
        ? Math.max(0, Math.min(100, percent))
        : null
  }
  if (typeof input.installLogUpdatedAt !== 'undefined') {
    setPayload.installLogUpdatedAt = input.installLogUpdatedAt?.trim() || null
  }
  if (typeof input.updateAvailable !== 'undefined') {
    setPayload.updateAvailable = input.updateAvailable ? 1 : 0
  }
  if (typeof input.localBuildId !== 'undefined') {
    setPayload.localBuildId = input.localBuildId?.trim() || null
  }
  if (typeof input.remoteBuildId !== 'undefined') {
    setPayload.remoteBuildId = input.remoteBuildId?.trim() || null
  }
  if (typeof input.updateCheckedAt !== 'undefined') {
    setPayload.updateCheckedAt = input.updateCheckedAt?.trim() || null
  }
  const condition = input.whereStatus
    ? and(
        eq(gameInstances.id, id),
        Array.isArray(input.whereStatus)
          ? inArray(gameInstances.status, input.whereStatus)
          : eq(gameInstances.status, input.whereStatus),
      )
    : eq(gameInstances.id, id)
  await drizzleDb
    .update(gameInstances)
    .set(setPayload)
    .where(condition)
  return getGameInstanceById(id)
}

export async function deleteGameInstanceById(id: string): Promise<boolean> {
  const { drizzleDb } = ensureDb()
  const exists = await getGameInstanceById(id)
  if (!exists) {
    return false
  }
  await drizzleDb
    .delete(gameInstances)
    .where(eq(gameInstances.id, id))
  return true
}

const DEFAULT_MAINTENANCE_PUSH_LOG_LIMIT = 20

export async function getMaintenanceDraft(instanceId: string): Promise<DbMaintenanceDraft | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({
      instanceId: instanceMaintenanceDrafts.instanceId,
      message: instanceMaintenanceDrafts.message,
      updatedAt: instanceMaintenanceDrafts.updatedAt,
    })
    .from(instanceMaintenanceDrafts)
    .where(eq(instanceMaintenanceDrafts.instanceId, instanceId))
    .limit(1)
  return rows[0]
}

export async function upsertMaintenanceDraft(instanceId: string, message: string): Promise<DbMaintenanceDraft> {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  const existing = await getMaintenanceDraft(instanceId)
  if (existing) {
    await drizzleDb
      .update(instanceMaintenanceDrafts)
      .set({
        message,
        updatedAt: now,
      })
      .where(eq(instanceMaintenanceDrafts.instanceId, instanceId))
  }
  else {
    await drizzleDb.insert(instanceMaintenanceDrafts).values({
      instanceId,
      message,
      updatedAt: now,
    })
  }
  return {
    instanceId,
    message,
    updatedAt: now,
  }
}

export async function listMaintenancePushLogs(
  instanceId: string,
  limit = DEFAULT_MAINTENANCE_PUSH_LOG_LIMIT,
): Promise<DbMaintenancePushLog[]> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({
      id: instanceMaintenancePushLogs.id,
      instanceId: instanceMaintenancePushLogs.instanceId,
      message: instanceMaintenancePushLogs.message,
      operatorAccount: instanceMaintenancePushLogs.operatorAccount,
      status: instanceMaintenancePushLogs.status,
      errorMessage: instanceMaintenancePushLogs.errorMessage,
      pushedAt: instanceMaintenancePushLogs.pushedAt,
    })
    .from(instanceMaintenancePushLogs)
    .where(eq(instanceMaintenancePushLogs.instanceId, instanceId))
    .orderBy(desc(instanceMaintenancePushLogs.pushedAt))
    .limit(limit)
  return rows.map(row => ({
    ...row,
    status: row.status as DbMaintenancePushStatus,
  }))
}

export async function insertMaintenancePushLog(input: InsertMaintenancePushLogInput): Promise<DbMaintenancePushLog> {
  const { drizzleDb } = ensureDb()
  const row: DbMaintenancePushLog = {
    id: randomUUID(),
    instanceId: input.instanceId,
    message: input.message,
    operatorAccount: input.operatorAccount,
    status: input.status,
    errorMessage: input.errorMessage ?? null,
    pushedAt: nowIso(),
  }
  await drizzleDb.insert(instanceMaintenancePushLogs).values({
    id: row.id,
    instanceId: row.instanceId,
    message: row.message,
    operatorAccount: row.operatorAccount,
    status: row.status,
    errorMessage: row.errorMessage,
    pushedAt: row.pushedAt,
  })
  return row
}