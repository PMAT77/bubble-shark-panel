import { readBrandEnv } from '../../../../shared/brand-env'
import type { FastifyInstance } from 'fastify'
import type {
  InstanceCheckUpdatesPayload,
  InstanceUpdateCheckJobPayload,
  InstanceUpdateStatusItem,
} from '../../../../shared/contracts/instance'
import fs from 'node:fs'
import process from 'node:process'
import type { InstallSeedDonor } from './install-seed'
import type { PublicAppInfo } from '../../shared/steam-update/app-info'
import { maybeEmitUpdateAvailableEvent } from './update-notify'
import type { DbGameInstance } from '../../shared/db/index'
import {
  getGameInstanceById,
  getSystemPanelSettings,
  getSystemSteamcmdConfig,
  listGameInstances,
  updateGameInstanceRuntime,
} from '../../shared/db/index'
import { getDefaultPanelSettings } from '../system/defaults'
import { resolveRuntimeStatus } from '../../infra/runtime'
import {
  checkGameUpdateAvailable,
  clearRemoteBuildCache,
  fetchRemoteAppInfo,
} from '../../shared/steam-update/build-id'

export const UPDATE_CHECK_STALE_MS = 60 * 60 * 1000
const PERIODIC_UPDATE_CHECK_MS = 6 * 60 * 60 * 1000
const LOCAL_NODE_ID = 'local-node'

let backgroundCheckRunning = false

export type InstanceCheckUpdatesResponse = InstanceCheckUpdatesPayload
export type InstanceUpdateCheckJobStatus = InstanceUpdateCheckJobPayload

let updateCheckJobStatus: InstanceUpdateCheckJobStatus = {
  checking: false,
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
}

let updateCheckJobInFlight: Promise<void> | null = null

function cloneUpdateCheckJobStatus(): InstanceUpdateCheckJobStatus {
  return {
    ...updateCheckJobStatus,
    result: updateCheckJobStatus.result
      ? {
          ...updateCheckJobStatus.result,
          items: [...updateCheckJobStatus.result.items],
        }
      : null,
  }
}

export function getInstanceUpdateCheckJobStatus(): InstanceUpdateCheckJobStatus {
  return cloneUpdateCheckJobStatus()
}

export function enqueueInstanceUpdateCheck(input: {
  steamcmdCommand: string
  instanceIds?: string[]
  force?: boolean
  validateRuntime?: () => Promise<{ ok: boolean, message?: string }>
}): InstanceUpdateCheckJobStatus {
  if (updateCheckJobStatus.checking && updateCheckJobInFlight) {
    return getInstanceUpdateCheckJobStatus()
  }

  updateCheckJobStatus = {
    checking: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
  }

  updateCheckJobInFlight = (async () => {
    try {
      if (input.validateRuntime) {
        const runtimeReady = await input.validateRuntime()
        if (!runtimeReady.ok) {
          updateCheckJobStatus.error = runtimeReady.message ?? '游戏运行时未就绪，无法检查更新'
          return
        }
      }
      const result = await checkInstancesForUpdates({
        steamcmdCommand: input.steamcmdCommand,
        instanceIds: input.instanceIds,
        force: input.force ?? false,
      })
      updateCheckJobStatus.result = result
    }
    catch (error) {
      updateCheckJobStatus.error = error instanceof Error ? error.message : String(error)
    }
    finally {
      updateCheckJobStatus.checking = false
      updateCheckJobStatus.finishedAt = new Date().toISOString()
      updateCheckJobInFlight = null
    }
  })()

  return getInstanceUpdateCheckJobStatus()
}

export function isUpdateCheckStale(instance: Pick<DbGameInstance, 'updateCheckedAt'>): boolean {
  if (!instance.updateCheckedAt) {
    return true
  }
  const checkedAt = Date.parse(instance.updateCheckedAt)
  if (!Number.isFinite(checkedAt)) {
    return true
  }
  return Date.now() - checkedAt > UPDATE_CHECK_STALE_MS
}

export function canCheckInstanceUpdate(instance: Pick<DbGameInstance, 'status' | 'nodeId'>): boolean {
  if (instance.nodeId !== LOCAL_NODE_ID) {
    return false
  }
  if (instance.status === 'pending_install' || instance.status === 'installing') {
    return false
  }
  return true
}

export async function resolveSteamcmdCommandForUpdateCheck(): Promise<string> {
  const steamcmdConfig = await getSystemSteamcmdConfig()
  return steamcmdConfig?.steamcmdPath?.trim() || (process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd')
}

export async function refreshInstanceUpdateStatus(
  instance: DbGameInstance,
  input: {
    steamcmdCommand: string
    forceRemote?: boolean
  },
): Promise<DbGameInstance> {
  if (!canCheckInstanceUpdate(instance)) {
    return instance
  }
  const installPath = instance.installPath?.trim()
  if (!installPath || !fs.existsSync(installPath)) {
    await updateGameInstanceRuntime(instance.id, {
      updateAvailable: false,
      localBuildId: null,
      remoteBuildId: null,
      updateCheckedAt: new Date().toISOString(),
    })
    return (await getGameInstanceById(instance.id)) ?? instance
  }
  if (input.forceRemote) {
    clearRemoteBuildCache(instance.gameCode)
  }
  const previousAvailable = instance.updateAvailable === true
  const result = await checkGameUpdateAvailable({
    installPath,
    appId: instance.gameCode,
    steamcmdCommand: input.steamcmdCommand,
    forceRemote: input.forceRemote,
  })
  await updateGameInstanceRuntime(instance.id, {
    updateAvailable: result.updateAvailable,
    localBuildId: result.localBuildId,
    remoteBuildId: result.remoteBuildId,
    updateCheckedAt: result.checkedAt,
  })
  const updated = await getGameInstanceById(instance.id)
  // 仅在「无更新 → 有更新」跃迁时发布事件，重复检查不会反复推送（通知侧冷却窗口兜底）
  maybeEmitUpdateAvailableEvent(
    { ...instance, updateAvailable: previousAvailable },
    result,
    updated,
  )
  return updated ?? instance
}

function toStatusItem(instance: DbGameInstance, message?: string): InstanceUpdateStatusItem {
  return {
    id: instance.id,
    name: instance.name,
    updateAvailable: instance.updateAvailable,
    localBuildId: instance.localBuildId,
    remoteBuildId: instance.remoteBuildId,
    updateCheckedAt: instance.updateCheckedAt,
    message,
  }
}

export async function checkInstancesForUpdates(input: {
  steamcmdCommand: string
  instanceIds?: string[]
  force?: boolean
}): Promise<InstanceCheckUpdatesResponse> {
  const all = await listGameInstances()
  const idSet = input.instanceIds?.length
    ? new Set(input.instanceIds.map(id => id.trim()).filter(Boolean))
    : null
  const targets = all.filter((item) => {
    if (!canCheckInstanceUpdate(item)) {
      return false
    }
    if (idSet && !idSet.has(item.id)) {
      return false
    }
    return true
  })
  const items: InstanceUpdateStatusItem[] = []
  const uniqueAppIds = [...new Set(targets.map(item => item.gameCode.trim()).filter(Boolean))]
  const forceRemote = input.force ?? false
  if (forceRemote) {
    for (const appId of uniqueAppIds) {
      clearRemoteBuildCache(appId)
    }
  }
  const remoteInfoByAppId = new Map<string, PublicAppInfo | null>()
  for (const appId of uniqueAppIds) {
    remoteInfoByAppId.set(
      appId,
      await fetchRemoteAppInfo(input.steamcmdCommand, appId, { force: forceRemote }),
    )
  }
  for (const instance of targets) {
    const installPath = instance.installPath?.trim()
    if (!installPath || !fs.existsSync(installPath)) {
      await updateGameInstanceRuntime(instance.id, {
        updateAvailable: false,
        localBuildId: null,
        remoteBuildId: null,
        updateCheckedAt: new Date().toISOString(),
      })
      const updated = await getGameInstanceById(instance.id)
      items.push(toStatusItem(updated ?? instance, '实例安装目录不存在，无法判断版本'))
      continue
    }
    const result = await checkGameUpdateAvailable({
      installPath,
      appId: instance.gameCode,
      steamcmdCommand: input.steamcmdCommand,
      remoteInfo: remoteInfoByAppId.get(instance.gameCode.trim()) ?? null,
    })
    await updateGameInstanceRuntime(instance.id, {
      updateAvailable: result.updateAvailable,
      localBuildId: result.localBuildId,
      remoteBuildId: result.remoteBuildId,
      updateCheckedAt: result.checkedAt,
    })
    const updated = await getGameInstanceById(instance.id)
    // 批量检查（定时任务/6 小时周期）同样走「无更新 → 有更新」跃迁推送
    maybeEmitUpdateAvailableEvent(
      instance,
      result,
      updated,
    )
    items.push(toStatusItem(updated ?? instance, result.message))
  }
  return {
    items,
    updateAvailableCount: items.filter(item => item.updateAvailable).length,
  }
}

export async function refreshStaleInstanceUpdateChecks(
  app: FastifyInstance,
  instances: DbGameInstance[],
  steamcmdCommand: string,
) {
  if (backgroundCheckRunning) {
    return
  }
  const stale = instances.filter(item => canCheckInstanceUpdate(item) && isUpdateCheckStale(item))
  if (stale.length === 0) {
    return
  }
  backgroundCheckRunning = true
  try {
    for (const instance of stale.slice(0, 8)) {
      try {
        await refreshInstanceUpdateStatus(instance, { steamcmdCommand })
      }
      catch (error) {
        app.log.warn({
          instanceId: instance.id,
          err: error,
        }, '后台检查实例更新失败')
      }
    }
  }
  finally {
    backgroundCheckRunning = false
  }
}

export function scheduleInstanceUpdateChecks(app: FastifyInstance) {
  if (readBrandEnv('BSP_UNIT_TEST') === '1') {
    return
  }
  const run = async () => {
    try {
      if ((await resolveRuntimeStatus()) !== 'running') {
        app.log.debug('游戏运行时未运行，跳过定时游戏服务端更新检查')
        return
      }
      const steamcmdCommand = await resolveSteamcmdCommandForUpdateCheck()
      const instances = await listGameInstances()
      await checkInstancesForUpdates({
        steamcmdCommand,
        force: false,
      })
      app.log.debug({
        checked: instances.length,
      }, '定时检查游戏服务端更新完成')
    }
    catch (error) {
      app.log.warn({ err: error }, '定时检查游戏服务端更新失败')
    }
  }
  setTimeout(() => void run(), 30_000)
  setInterval(() => void run(), PERIODIC_UPDATE_CHECK_MS)
}

export async function refreshInstanceUpdateStatusAfterSeed(
  instanceId: string,
  installPath: string,
  appId: string,
  _donor: InstallSeedDonor,
) {
  const result = await checkGameUpdateAvailable({ installPath, appId, steamcmdCommand: '' })
  await updateGameInstanceRuntime(instanceId, {
    updateAvailable: result.updateAvailable,
    localBuildId: result.localBuildId,
    remoteBuildId: result.remoteBuildId,
    updateCheckedAt: result.checkedAt,
  })
}

export async function refreshInstanceUpdateStatusAfterInstall(
  instanceId: string,
  installPath: string,
  appId: string,
  steamcmdCommand: string,
) {
  clearRemoteBuildCache(appId)
  const result = await checkGameUpdateAvailable({ installPath, appId, steamcmdCommand, forceRemote: true })
  await updateGameInstanceRuntime(instanceId, {
    updateAvailable: result.updateAvailable,
    localBuildId: result.localBuildId,
    remoteBuildId: result.remoteBuildId,
    updateCheckedAt: result.checkedAt,
  })
}

export async function resolveCheckUpdateBeforeStartEnabled(): Promise<boolean> {
  const settings = await getSystemPanelSettings()
  return settings?.checkUpdateBeforeStart
    ?? getDefaultPanelSettings().checkUpdateBeforeStart
}

/**
 * 启动前向 Steam 拉取远端 Build ID；若开启系统设置且存在更新则返回拦截文案。
 */
export async function resolveStartBlockedByPendingUpdate(
  instance: DbGameInstance,
): Promise<string | undefined> {
  if (!await resolveCheckUpdateBeforeStartEnabled()) {
    return undefined
  }
  if (!canCheckInstanceUpdate(instance)) {
    return undefined
  }
  const installPath = instance.installPath?.trim()
  if (!installPath || !fs.existsSync(installPath)) {
    return undefined
  }
  const steamcmdCommand = await resolveSteamcmdCommandForUpdateCheck()
  const updated = await refreshInstanceUpdateStatus(instance, {
    steamcmdCommand,
    forceRemote: true,
  })
  if (!updated.updateAvailable) {
    return undefined
  }
  const local = updated.localBuildId ?? '未知'
  const remote = updated.remoteBuildId ?? '未知'
  return `服务端版本或游戏文件需要更新（本地 Build ${local}，正式分支 Build ${remote}），请先在实例页点击「更新服务端」后再启动`
}
