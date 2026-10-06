export interface BuildSteamcmdAppUpdateArgsOptions {
  /** @deprecated 旧配置仅保留兼容，SteamCMD 不支持该区域参数。 */
  downloadRegion?: string
}

export function buildSteamcmdCommandPrefix(): string[] {
  const prefix: string[] = [
    '+@ShutdownOnFailedCommand',
    '1',
    '+@NoPromptForPassword',
    '1',
    '+@sSteamCmdForcePlatformType',
    'linux',
  ]
  return prefix
}

/** SteamCMD 要求 +force_install_dir 必须在 +login 之前，否则会出现 before logon / Missing file permissions */
export function buildSteamcmdAppUpdateArgs(
  installPath: string,
  appId: string,
  loginArgs: string[],
  _options?: BuildSteamcmdAppUpdateArgsOptions,
) {
  return [
    ...buildSteamcmdCommandPrefix(),
    '+force_install_dir',
    installPath,
    ...loginArgs,
    '+app_update',
    appId,
    'validate',
    '+quit',
  ]
}

export function buildSteamcmdWorkshopDownloadArgs(
  installPath: string,
  workshopAppId: string,
  workshopIds: string[],
  loginArgs: string[],
  _options?: BuildSteamcmdAppUpdateArgsOptions,
) {
  const downloadArgs = workshopIds.flatMap(workshopId => [
    '+workshop_download_item',
    workshopAppId,
    workshopId,
    'validate',
  ])
  return [
    ...buildSteamcmdCommandPrefix(),
    '+force_install_dir',
    installPath,
    ...loginArgs,
    ...downloadArgs,
    '+quit',
  ]
}
