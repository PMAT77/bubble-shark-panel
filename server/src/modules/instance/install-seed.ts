import path from 'node:path'
import type { DbGameInstance } from '../../shared/db/index'
import { listGameInstances } from '../../shared/db/index'
import { isInstallSeedEnabled } from '../../shared/config/install'
import { diagnoseDstInstallReadiness } from '../../infra/game-adapter/dst/install-readiness'
import { copyGameDepotFromDonor } from '../../infra/game-adapter/dst/depot-copy'
import { fetchRemoteBuildId, readLocalBuildId } from '../../shared/steam-update/build-id'
import { isSteamcmdJobRunning } from '../../infra/container/steamcmd-job'
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
  | { ok: false, reason: string }

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
  recipientId: string
  recipientPath: string
  appId: string
}): Promise<InstallSeedDonor | null> {
  if (!isInstallSeedEnabled()) {
    return null
  }
  const recipientPath = normalizeInstallPath(input.recipientPath)
  const appId = input.appId.trim()
  const remoteBuildId = await fetchRemoteBuildId('', appId, { force: true })
  if (!remoteBuildId) {
    return null
  }
  const candidates: Array<{ instance: DbGameInstance, localBuildId: string | null, score: number }> = []

  const instances = await listGameInstances({ nodeId: LOCAL_NODE_ID })
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
    const localBuildId = readLocalBuildId(normalizedDonorPath, appId)
    if (!localBuildId || localBuildId !== remoteBuildId) {
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
  recipientId: string
  recipientPath: string
  appId: string
}): Promise<InstallSeedAttemptResult> {
  const donor = await findInstallSeedDonor(input)
  if (!donor) {
    return { ok: false, reason: '未找到可用的供体实例（需已停止、游戏文件完整且版本最新）' }
  }
  const copyResult = copyGameDepotFromDonor(donor.installPath, input.recipientPath)
  if (!copyResult.ok) {
    return { ok: false, reason: copyResult.error }
  }
  const pathError = prepareInstallPathForSteamcmd(input.recipientPath)
  if (pathError) {
    return { ok: false, reason: pathError }
  }
  const readiness = diagnoseDstInstallReadiness(input.recipientPath)
  if (!readiness.ready) {
    return { ok: false, reason: `复制后校验失败: ${readiness.message}` }
  }
  const localBuildId = readLocalBuildId(input.recipientPath, input.appId)
  if (donor.localBuildId && localBuildId !== donor.localBuildId) {
    return { ok: false, reason: '复制后 buildid 与供体不一致' }
  }
  return { ok: true, donor }
}
