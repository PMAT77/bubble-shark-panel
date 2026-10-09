import { getServerContainerConfig } from '../../shared/config/container'
import { DockerContainerRuntime } from './docker-runtime'
import { NativeSystemdRuntime } from './native-systemd-runtime'
import type { ContainerRuntime } from './types'

let runtime: ContainerRuntime | undefined

export function getContainerRuntime(): ContainerRuntime {
  if (!runtime) {
    const {
      dockerHost,
      nativeRuntimeDir,
      nativeSystemdUnitDir,
      runtimeMode,
    } = getServerContainerConfig()
    runtime = runtimeMode === 'native'
      ? new NativeSystemdRuntime({
          runtimeDir: nativeRuntimeDir,
          unitDir: nativeSystemdUnitDir,
        })
      : new DockerContainerRuntime(dockerHost)
  }
  return runtime
}

export * from './types'
export * from './naming'
export {
  runSteamcmdAppUpdateInContainer,
  runSteamcmdAppInfoInContainer,
  cancelSteamcmdInstallContainer,
  hasUnconfirmedSteamcmdJob,
  cleanupOrphanedSteamcmdInstallContainers,
  cleanupAllRunningSteamcmdInstallContainers,
  isSteamcmdJobRunning,
  isSteamcmdImagePresent,
  pullSteamcmdImage,
} from './steamcmd-runner'
export { clearSteamcmdJobCancelFlag } from './steamcmd-job'
export { clearNativeSteamcmdCancelFlag } from './native-steamcmd-runner'
export {
  assessHostMemoryForHeavyOperation,
  readHostMemoryAvailableMb,
  resolveMinHostAvailableMbForOperation,
  resolveSteamcmdPlanningMb,
} from './host-resource-guard'
export type { HeavyHostOperation, HostMemoryPressureFailure, HostMemoryPressureResult } from './host-resource-guard'
export {
  formatGameDstImageError,
  isGameDstImagePresent,
  pullGameDstImage,
} from './game-dst-image'
export { ensureSteamcmdImage } from './runtime-images'
