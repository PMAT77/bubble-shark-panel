import { readBrandEnv } from '../../../../shared/brand-env'
import path from 'node:path'
import type Docker from 'dockerode'

export type SteamcmdInstallBindMode = 'direct' | 'instances-volume' | 'instances-bind'

export interface SteamcmdInstallBindPlan {
  hostBinds: string[]
  containerInstallPath: string
  mode: SteamcmdInstallBindMode
  error?: string
}

export interface InstanceContainerBindPlan {
  hostBinds: string[]
  containerGameRoot: string
  mode: SteamcmdInstallBindMode
  error?: string
}

function normalizeDir(dir: string): string {
  const resolved = path.resolve(dir)
  if (resolved === path.parse(resolved).root) {
    return resolved
  }
  return resolved.replace(/[\\/]+$/, '')
}

export function isPosixAbsolutePath(value: string): boolean {
  return value.startsWith('/')
}

export function isInstallPathUnderInstancesRoot(installPath: string, instancesRoot: string): boolean {
  const root = normalizeDir(instancesRoot)
  const resolved = path.resolve(installPath)
  return resolved === root || resolved.startsWith(`${root}${path.sep}`)
}

/** Windows 等宿主机路径必须直 bind；不得复用 panel 容器内的命名卷挂载 */
export function shouldUseDirectHostBind(installPath: string, instancesRoot: string): boolean {
  if (!isInstallPathUnderInstancesRoot(installPath, instancesRoot)) {
    return true
  }
  if (isPosixAbsolutePath(installPath) && isPosixAbsolutePath(instancesRoot)) {
    return false
  }
  return true
}

/** panel 在容器内且 instances 为 POSIX 路径时，卷解析失败不得 fallback 到无效 direct bind */
export function shouldRejectDirectBindFallback(installPath: string, instancesRoot: string): boolean {
  return isPosixAbsolutePath(installPath)
    && isPosixAbsolutePath(instancesRoot)
    && isInstallPathUnderInstancesRoot(installPath, instancesRoot)
}

export const PANEL_VOLUME_BIND_RESOLUTION_ERROR = '无法解析 instances 卷挂载。请确认 panel 容器已设置 BSP_PANEL_CONTAINER_NAME，且 instances 目录为 Docker 卷挂载；dev:compose 与 dev:server 请勿同时运行。'

async function resolveInstancesRootMountBind(
  docker: Docker,
  instancesRoot: string,
): Promise<{ bind: string, mode: SteamcmdInstallBindMode } | null> {
  const containerRef = process.env.HOSTNAME?.trim()
    || readBrandEnv('BSP_PANEL_CONTAINER_NAME')?.trim()
  if (!containerRef) {
    return null
  }
  try {
    const inspect = await docker.getContainer(containerRef).inspect()
    const normalizedRoot = normalizeDir(instancesRoot)
    const mount = inspect.Mounts?.find((item) => normalizeDir(item.Destination) === normalizedRoot)
    if (!mount) {
      return null
    }
    if (mount.Type === 'volume' && mount.Name) {
      return { bind: `${mount.Name}:${normalizedRoot}`, mode: 'instances-volume' as const }
    }
    if (mount.Type === 'bind' && mount.Source) {
      return { bind: `${mount.Source}:${normalizedRoot}`, mode: 'instances-bind' as const }
    }
  }
  catch {
    return null
  }
  return null
}

interface InstancesRootBindPlan {
  hostBinds: string[]
  containerPath: string
  mode: SteamcmdInstallBindMode
  error?: string
}

export const STEAMCMD_CONTAINER_INSTALL_MOUNT = '/game'

function buildDirectBindPlan(installPath: string): InstancesRootBindPlan {
  const resolvedInstallPath = path.resolve(installPath)
  return {
    hostBinds: [`${resolvedInstallPath}:${STEAMCMD_CONTAINER_INSTALL_MOUNT}`],
    containerPath: STEAMCMD_CONTAINER_INSTALL_MOUNT,
    mode: 'direct',
  }
}

/** 实例子目录相对 instances 根的路径（用于解析卷 mountpoint 下的宿主机目录） */
export function resolveRelativeInstanceDir(installPath: string, instancesRoot: string): string | null {
  const normalizedRoot = normalizeDir(instancesRoot)
  const resolvedInstallPath = path.resolve(installPath)
  const relative = path.relative(normalizedRoot, resolvedInstallPath)
  if (!relative || relative === '.' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null
  }
  return relative
}

export function resolveHostInstanceDirFromMountSource(
  mountSource: string,
  relativeInstanceDir: string,
): string {
  return path.join(mountSource, relativeInstanceDir)
}

/**
 * panel 在容器内通过 docker.sock 创建子容器时，不能把「仅存在于 panel 挂载命名空间」的路径
 * 当作 bind 源（Docker 会在宿主机自动 mkdir，得到空目录且 uid=0，导致 Missing file permissions）。
 */
async function resolveInstancesRootBindPlan(
  docker: Docker,
  installPath: string,
  instancesRoot: string,
): Promise<InstancesRootBindPlan> {
  const resolvedInstallPath = path.resolve(installPath)
  const normalizedRoot = normalizeDir(instancesRoot)

  if (shouldUseDirectHostBind(resolvedInstallPath, normalizedRoot)) {
    return buildDirectBindPlan(resolvedInstallPath)
  }

  const rootMount = await resolveInstancesRootMountBind(docker, normalizedRoot)
  if (rootMount) {
    return {
      hostBinds: [rootMount.bind],
      containerPath: resolvedInstallPath,
      mode: rootMount.mode,
    }
  }

  if (shouldRejectDirectBindFallback(resolvedInstallPath, normalizedRoot)) {
    return {
      hostBinds: [],
      containerPath: resolvedInstallPath,
      mode: 'direct',
      error: PANEL_VOLUME_BIND_RESOLUTION_ERROR,
    }
  }

  return buildDirectBindPlan(resolvedInstallPath)
}

/**
 * SteamCMD 始终将「单个实例安装目录」直 bind 到 /game，避免整卷挂载 + 嵌套 force_install_dir
 * 在并发/重试时出现 Missing configuration（日志：同配置下有时成功有时秒失败）。
 */
export async function resolveSteamcmdInstallBind(
  docker: Docker,
  installPath: string,
  instancesRoot: string,
): Promise<SteamcmdInstallBindPlan> {
  const resolvedInstallPath = path.resolve(installPath)
  const normalizedRoot = normalizeDir(instancesRoot)

  if (shouldUseDirectHostBind(resolvedInstallPath, normalizedRoot)) {
    const direct = buildDirectBindPlan(resolvedInstallPath)
    const result: SteamcmdInstallBindPlan = {
      hostBinds: direct.hostBinds,
      containerInstallPath: direct.containerPath,
      mode: direct.mode,
      error: direct.error,
    }
    return result
  }

  const relativeInstanceDir = resolveRelativeInstanceDir(resolvedInstallPath, normalizedRoot)
  const rootMount = await resolveInstancesRootMountBind(docker, normalizedRoot)
  if (!rootMount || !relativeInstanceDir) {
    if (shouldRejectDirectBindFallback(resolvedInstallPath, normalizedRoot)) {
      const result: SteamcmdInstallBindPlan = {
        hostBinds: [],
        containerInstallPath: STEAMCMD_CONTAINER_INSTALL_MOUNT,
        mode: 'direct',
        error: PANEL_VOLUME_BIND_RESOLUTION_ERROR,
      }
      return result
    }
    const direct = buildDirectBindPlan(resolvedInstallPath)
    const result: SteamcmdInstallBindPlan = {
      hostBinds: direct.hostBinds,
      containerInstallPath: direct.containerPath,
      mode: direct.mode,
      error: direct.error,
    }
    return result
  }

  const mountSource = rootMount.bind.split(':')[0]?.trim() ?? ''
  let hostInstanceDir: string
  if (rootMount.mode === 'instances-bind') {
    hostInstanceDir = resolveHostInstanceDirFromMountSource(mountSource, relativeInstanceDir)
  }
  else {
    try {
      const volume = await docker.getVolume(mountSource).inspect()
      hostInstanceDir = resolveHostInstanceDirFromMountSource(volume.Mountpoint, relativeInstanceDir)
    }
    catch {
      const result: SteamcmdInstallBindPlan = {
        hostBinds: [],
        containerInstallPath: STEAMCMD_CONTAINER_INSTALL_MOUNT,
        mode: rootMount.mode,
        error: `无法解析 Docker 卷 ${mountSource} 的宿主机路径，SteamCMD 安装已取消`,
      }
      return result
    }
  }

  const result: SteamcmdInstallBindPlan = {
    hostBinds: [`${hostInstanceDir}:${STEAMCMD_CONTAINER_INSTALL_MOUNT}`],
    containerInstallPath: STEAMCMD_CONTAINER_INSTALL_MOUNT,
    mode: rootMount.mode,
  }
  return result
}

export async function resolveInstanceContainerBind(
  docker: Docker,
  installPath: string,
  instancesRoot: string,
): Promise<InstanceContainerBindPlan> {
  const plan = await resolveInstancesRootBindPlan(docker, installPath, instancesRoot)
  return {
    hostBinds: plan.hostBinds,
    containerGameRoot: plan.containerPath,
    mode: plan.mode,
    error: plan.error,
  }
}
