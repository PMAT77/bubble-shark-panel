import path from 'node:path'
import type { DbGameInstance } from '../../shared/db/index'
import { getGameInstanceById, listGameInstances } from '../../shared/db/index'
import { isInstallSeedEnabled } from '../../shared/config/install'
import { diagnoseDstInstallReadiness } from '../../infra/game-adapter/dst/install-readiness'
import { copyGameDepotFromDonorAsync, installPathsOverlap } from '../../infra/game-adapter/dst/depot-copy'
import { checkGameUpdateAvailable, fetchRemoteAppInfo, readLocalBuildId } from '../../shared/steam-update/build-id'
import { isSteamcmdJobRunning } from '../../infra/container'
import { InstanceContentBusyError, withInstanceContentOperation } from '../../shared/instance-content/operation'
import { abortable } from '../../shared/abort'
import { prepareInstallPathForSteamcmd } from './install-path'

const LOCAL_NODE_ID = 'local-node'

export interface InstallSeedDonor {
  instanceId: string
  instanceName: string
  installPath: string
  localBuildId: string | null
  remoteBuildId: string | null
  updateAvailable: boolean
}

export type InstallSeedAttemptResult =
  | { ok: true, donor: InstallSeedDonor }
  | { ok: false, reason: string, failed?: boolean }

function normalizeInstallPath(value: string): string {
  return path.resolve(value.trim())
}

function isEligibleDonorStatus(status: string): boolean {
  return status === 'stopped'
}

function scoreDonor(instance: DbGameInstance, localBuildId: string | null): number {
  const buildNumeric = localBuildId ? Number(localBuildId) : 0
  const checkedAt = instance.updateCheckedAt ? Date.parse(instance.updateCheckedAt) : 0
  return (Number.isFinite(buildNumeric) ? buildNumeric : 0) * 1_000_000_000_000 + (Number.isFinite(checkedAt) ? checkedAt : 0)
}

export async function findInstallSeedDonor(input: {
  signal?: AbortSignal
  recipientId: string
  recipientPath: string
  appId: string
}): Promise<InstallSeedDonor | null> {
  if (!isInstallSeedEnabled()) {
    return null
  }
  const recipientPath = normalizeInstallPath(input.recipientPath)
  const appId = input.appId.trim()
  const instances = (await listGameInstances({ nodeId: LOCAL_NODE_ID })).filter(instance =>
    instance.id !== input.recipientId && instance.gameCode.trim() === appId
    && isEligibleDonorStatus(instance.status) && instance.installPath
    && !installPathsOverlap(instance.installPath, recipientPath)
    && diagnoseDstInstallReadiness(instance.installPath).ready,
  )
  if (!instances.length) return null
  const remoteInfo = await abortable(fetchRemoteAppInfo('', appId, { force: true }), input.signal)
  if (!remoteInfo) {
    return null
  }
  const remoteBuildId = remoteInfo.buildId
  const candidates: Array<{ instance: DbGameInstance, localBuildId: string | null, score: number }> = []

  for (const instance of instances) {
    if (instance.id === input.recipientId) {
      continue
    }
    if (instance.gameCode.trim() !== appId) {
      continue
    }
    if (!isEligibleDonorStatus(instance.status)) {
      continue
    }
    if (instance.status === 'installing' || instance.status === 'pending_install') {
      continue
    }
    if (await isSteamcmdJobRunning(instance.id)) {
      continue
    }
    const donorPath = instance.installPath?.trim()
    if (!donorPath) {
      continue
    }
    const normalizedDonorPath = normalizeInstallPath(donorPath)
    if (normalizedDonorPath === recipientPath) {
      continue
    }
    const readiness = diagnoseDstInstallReadiness(normalizedDonorPath)
    if (!readiness.ready) {
      continue
    }
    const check = await checkGameUpdateAvailable({ installPath: normalizedDonorPath, appId, steamcmdCommand: '', remoteInfo })
    const localBuildId = check.localBuildId
    if (!localBuildId || localBuildId !== remoteBuildId || check.updateAvailable || check.message) {
      continue
    }
    if (instance.updateAvailable) {
      continue
    }
    if (instance.remoteBuildId && localBuildId !== instance.remoteBuildId) {
      continue
    }
    candidates.push({
      instance,
      localBuildId,
      score: scoreDonor(instance, localBuildId),
    })
  }

  if (candidates.length === 0) {
    return null
  }
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  return {
    instanceId: best.instance.id,
    instanceName: best.instance.name,
    installPath: normalizeInstallPath(best.instance.installPath!.trim()),
    localBuildId: best.localBuildId,
    remoteBuildId,
    updateAvailable: Boolean(best.instance.updateAvailable),
  }
}

export async function tryInstallGameDepotFromSeed(input: {
  signal?: AbortSignal
  onProgress?: (copiedBytes: number, totalBytes: number) => void
  recipientId: string
  recipientPath: string
  appId: string
}): Promise<InstallSeedAttemptResult> {
  const donor = await findInstallSeedDonor(input)
  if (!donor) {
    return { ok: false, reason: '未找到可用的供体实例（需已停止、游戏文件完整且版本最新）' }
  }
  input.signal?.throwIfAborted()
  return withInstanceContentOperation(donor.instanceId, async (): Promise<InstallSeedAttemptResult> => {
  const current = await getGameInstanceById(donor.instanceId)
  if (current?.status !== 'stopped' || !current.installPath || normalizeInstallPath(current.installPath) !== donor.installPath
    || !diagnoseDstInstallReadiness(donor.installPath).ready
    || readLocalBuildId(donor.installPath, input.appId) !== donor.localBuildId) {
    return { ok: false, reason: '复制源状态已变化，使用 SteamCMD 安装' }
  }
  const copyResult = await copyGameDepotFromDonorAsync(donor.installPath, input.recipientPath, input)
  if (!copyResult.ok) {
    return { ok: false, reason: copyResult.error, failed: true }
  }
  const pathError = prepareInstallPathForSteamcmd(input.recipientPath)
  if (pathError) {
    return { ok: false, reason: pathError, failed: true }
  }
  const readiness = diagnoseDstInstallReadiness(input.recipientPath)
  if (!readiness.ready) {
    return { ok: false, reason: `复制后校验失败: ${readiness.message}`, failed: true }
  }
  const localBuildId = readLocalBuildId(input.recipientPath, input.appId)
  if (donor.localBuildId && localBuildId !== donor.localBuildId) {
    return { ok: false, reason: '复制后 buildid 与供体不一致', failed: true }
  }
  return { ok: true, donor }
  }).catch(error => {
    if (error instanceof InstanceContentBusyError) return { ok: false, reason: '复制源正在执行文件操作，使用 SteamCMD 安装' }
    throw error
  })
}
