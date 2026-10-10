import { randomUUID } from 'node:crypto'
import type { ZodType } from 'zod'
import { instanceResourceConfigSchema, instanceStartupSnapshotSchema } from '../../../../shared/contracts/instance-resources'
import { resolveInstanceUpdateState } from '../../../../shared/instance-update-state'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
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
  DbInstanceRuntimeFailureKind,
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

/** 归因只认这两个值；库里出现别的值一律当无结论，前端据此不显示任何引导 */
function normalizeInstanceRuntimeFailureKind(
  kind: string | null | undefined,
): DbInstanceRuntimeFailureKind | null {
  return kind === 'memory' || kind === 'not_ready' || kind === 'memory_protection' ? kind : null
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

function parseStoredJson<T>(value: string | null, schema: ZodType<T>): T | null {
  if (!value) return null
  try {
    const result = schema.safeParse(JSON.parse(value))
    return result.success ? result.data : null
  }
  catch { return null }
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
  resourceConfig: string | null
  lastStartupReport: string | null
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
  runtimeReadyAt: string | null
  runtimeFailureKind: string | null
  unexpectedExitAt: string | null
  installLogStatus: string | null
  installTaskId: string | null
  installPercent: number | null
  installLogUpdatedAt: string | null
  updateAvailable: number | null
  updateCheckError: string | null
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
    resourceConfig: parseStoredJson(row.resourceConfig, instanceResourceConfigSchema),
    lastStartupReport: parseStoredJson(row.lastStartupReport, instanceStartupSnapshotSchema),
    queryPort: row.queryPort === null ? null : Number(row.queryPort),
    gamePort: row.gamePort === null ? null : Number(row.gamePort),
    rconPort: row.rconPort === null ? null : Number(row.rconPort),
    lastExitCode: row.lastExitCode === null ? null : Number(row.lastExitCode),
    lastErrorPhase: normalizeInstanceErrorPhase(row.lastErrorPhase),
    runtimeReadyAt: row.runtimeReadyAt?.trim() || null,
    runtimeFailureKind: normalizeInstanceRuntimeFailureKind(row.runtimeFailureKind),
    installLogStatus: installLogStatus === 'running' || installLogStatus === 'success' || installLogStatus === 'failed' || installLogStatus === 'cancelled'
      ? installLogStatus
      : null,
    installPercent: row.installPercent === null ? null : Number(row.installPercent),
    installLogUpdatedAt: row.installLogUpdatedAt ?? null,
    updateAvailable: Number(row.updateAvailable ?? 0) === 1,
    localBuildId: row.localBuildId ?? null,
    remoteBuildId: row.remoteBuildId ?? null,
    updateCheckedAt: row.updateCheckedAt ?? null,
    updateCheckError: row.updateCheckError ?? null,
    updateState: resolveInstanceUpdateState({ ...row, updateAvailable: Number(row.updateAvailable ?? 0) === 1 }),
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
    resourceConfig: gameInstances.resourceConfig,
    lastStartupReport: gameInstances.lastStartupReport,
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
    runtimeReadyAt: gameInstances.runtimeReadyAt,
    runtimeFailureKind: gameInstances.runtimeFailureKind,
    unexpectedExitAt: gameInstances.unexpectedExitAt,
    installLogStatus: gameInstances.installLogStatus,
    installTaskId: gameInstances.installTaskId,
    installPercent: gameInstances.installPercent,
    installLogUpdatedAt: gameInstances.installLogUpdatedAt,
    updateAvailable: gameInstances.updateAvailable,
    updateCheckError: gameInstances.updateCheckError,
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
  runtimeRevision++
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
  contentSource: string
  installStatus: string
  installError: string | null
  downloadIntent: 'install' | 'update' | null
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
    contentSource: row.contentSource === 'local' || row.contentSource === 'migration' ? row.contentSource : 'steam',
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
      contentSource: instanceMods.contentSource,
      installStatus: instanceMods.installStatus,
      installError: instanceMods.installError,
      downloadIntent: instanceMods.downloadIntent,
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
      contentSource: instanceMods.contentSource,
      installStatus: instanceMods.installStatus,
      installError: instanceMods.installError,
      downloadIntent: instanceMods.downloadIntent,
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
  contentSource?: 'steam' | 'local' | 'migration'
  installStatus?: 'pending' | 'ready' | 'failed'
  installError?: string | null
  downloadIntent?: 'install' | 'update' | null
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
      ...(input.contentSource ? { contentSource: input.contentSource } : {}),
      installStatus,
      installError: installError ?? null,
      downloadIntent: input.downloadIntent ?? null,
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
      ...(input.contentSource ? { contentSource: input.contentSource } : {}),
        installStatus,
        ...(typeof installError !== 'undefined' ? { installError } : {}),
        ...(typeof input.downloadIntent !== 'undefined' ? { downloadIntent: input.downloadIntent } : {}),
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
    contentSource?: 'steam' | 'local' | 'migration'
    installStatus?: 'pending' | 'ready' | 'failed'
    installError?: string | null
    downloadIntent?: 'install' | 'update' | null
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
    contentSource?: 'steam' | 'local' | 'migration'
    installStatus?: 'pending' | 'ready' | 'failed'
    installError?: string | null
    downloadIntent?: 'install' | 'update' | null
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
  if (patch.contentSource) {
    payload.contentSource = patch.contentSource
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
  if (typeof patch.downloadIntent !== 'undefined') {
    payload.downloadIntent = patch.downloadIntent
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
  runtimeRevision++
  return getGameInstanceById(id)
}

export async function updateGameInstanceRuntime(
  id: string,
  input: UpdateGameInstanceRuntimeInput,
): Promise<DbGameInstance | undefined> {
  const { drizzleDb } = ensureDb()
  const setPayload: {
    resourceConfig?: string | null
    lastStartupReport?: string | null
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
    runtimeReadyAt?: string | null
    runtimeFailureKind?: DbInstanceRuntimeFailureKind | null
    unexpectedExitAt?: string | null
    installLogStatus?: DbInstallLogStatus | null
    installTaskId?: string | null
    installPercent?: number | null
    installLogUpdatedAt?: string | null
    updateAvailable?: number
    updateCheckError?: string | null
    localBuildId?: string | null
    remoteBuildId?: string | null
    updateCheckedAt?: string | null
    updatedAt: string
  } = {
    updatedAt: nowIso(),
  }
  if (input.resourceConfig !== undefined) setPayload.resourceConfig = input.resourceConfig === null ? null : JSON.stringify(instanceResourceConfigSchema.parse(input.resourceConfig))
  if (input.lastStartupReport !== undefined) setPayload.lastStartupReport = input.lastStartupReport === null ? null : JSON.stringify(instanceStartupSnapshotSchema.parse(input.lastStartupReport))
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
  if (typeof input.runtimeReadyAt !== 'undefined') {
    setPayload.runtimeReadyAt = input.runtimeReadyAt?.trim() || null
  }
  if (typeof input.runtimeFailureKind !== 'undefined') {
    setPayload.runtimeFailureKind = normalizeInstanceRuntimeFailureKind(input.runtimeFailureKind)
  }
  if (typeof input.unexpectedExitAt !== 'undefined') {
    setPayload.unexpectedExitAt = input.unexpectedExitAt?.trim() || null
  }
  if (typeof input.installLogStatus !== 'undefined') {
    setPayload.installLogStatus = input.installLogStatus
  }
  if (typeof input.installTaskId !== 'undefined') setPayload.installTaskId = input.installTaskId
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
  if (typeof input.updateCheckError !== 'undefined') {
    setPayload.updateCheckError = input.updateCheckError?.trim() || null
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
  const statusCondition = input.whereStatus
    ? and(
        eq(gameInstances.id, id),
        Array.isArray(input.whereStatus)
          ? inArray(gameInstances.status, input.whereStatus)
          : eq(gameInstances.status, input.whereStatus),
      )
    : eq(gameInstances.id, id)
  const condition = typeof input.whereInstallTaskId === 'undefined' ? statusCondition
    : and(statusCondition, input.whereInstallTaskId === null ? isNull(gameInstances.installTaskId) : eq(gameInstances.installTaskId, input.whereInstallTaskId))
  const guardedCondition = input.whereStartupTaskId === undefined ? condition
    : and(condition, sql`json_extract(${gameInstances.lastStartupReport}, '$.taskId') = ${input.whereStartupTaskId}`)
  await drizzleDb
    .update(gameInstances)
    .set(setPayload)
    .where(guardedCondition)
  runtimeRevision++
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
  runtimeRevision++
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
/** 内容事务的短数据库提交/回滚：整份 Mod 列表与端口一次提交，不跨 await。 */
export function replaceInstanceModRecords(instanceId: string, mods: DbInstanceMod[], gamePort?: number | null): void {
  const { sqliteDb, drizzleDb } = ensureDb()
  const run = (query: { toSQL(): { sql: string, params: unknown[] } }) => {
    const statement = query.toSQL()
    sqliteDb.prepare(statement.sql).run(...statement.params as Array<string | number | null>)
  }
  sqliteDb.exec('SAVEPOINT gsh_content_mods')
  try {
    run(drizzleDb.delete(instanceMods).where(eq(instanceMods.instanceId, instanceId)))
    for (const mod of mods) {
      run(drizzleDb.insert(instanceMods).values({
        ...mod, id: `${instanceId}:${mod.workshopId}`, instanceId,
        enabled: mod.enabled ? 1 : 0, loadedCopyStale: mod.loadedCopyStale ? 1 : 0,
        contentSource: mod.contentSource ?? 'steam',
      }))
    }
    if (typeof gamePort !== 'undefined') run(drizzleDb.update(gameInstances).set({ gamePort }).where(eq(gameInstances.id, instanceId)))
    sqliteDb.exec('RELEASE gsh_content_mods')
  }
  catch (error) {
    sqliteDb.exec('ROLLBACK TO gsh_content_mods; RELEASE gsh_content_mods')
    throw error
  }
}

let runtimeRevision = 0
/** 实例生命周期写入后，使应用级运行态快照失效。 */
export function getInstanceRuntimeRevision(): number { return runtimeRevision }
