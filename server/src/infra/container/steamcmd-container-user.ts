import { readBrandEnv } from '../../../../shared/brand-env'
/** cm2network/steamcmd 镜像内 steam 用户默认 uid/gid */
export const STEAMCMD_CONTAINER_UID = 1000
export const STEAMCMD_CONTAINER_GID = 1000
export const STEAMCMD_CONTAINER_USER = `${STEAMCMD_CONTAINER_UID}:${STEAMCMD_CONTAINER_GID}`

/** 与 prepareInstallPathForSteamcmd 的 chown 一致；userns-remap 环境可设 BSP_STEAMCMD_RUN_USER=0:0 */
export function resolveSteamcmdContainerUser(): string {
  const raw = readBrandEnv('BSP_STEAMCMD_RUN_USER')?.trim()
  return raw || STEAMCMD_CONTAINER_USER
}

export function resolveSteamcmdContainerUidGid(): { uid: number, gid: number } {
  const raw = resolveSteamcmdContainerUser()
  const [uidText, gidText] = raw.split(':')
  const uid = Number(uidText)
  const gid = Number(gidText)
  if (!Number.isFinite(uid) || !Number.isFinite(gid)) {
    return { uid: STEAMCMD_CONTAINER_UID, gid: STEAMCMD_CONTAINER_GID }
  }
  return { uid, gid }
}

/** 为卷 bind 追加选项，如 RHEL SELinux 下可设 BSP_STEAMCMD_BIND_OPTS=rw,z */
export function appendSteamcmdBindMountOptions(bind: string): string {
  const opts = readBrandEnv('BSP_STEAMCMD_BIND_OPTS')?.trim()
  if (!opts || bind.split(':').length > 2) {
    return bind
  }
  return `${bind}:${opts}`
}
