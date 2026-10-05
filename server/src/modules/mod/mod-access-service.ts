import { readBrandEnv } from '../../../../shared/brand-env'
import type { ModAccessStatusDto } from '../../../../shared/contracts/mod'
import { getSteamAccessObservations } from '../../infra/game-adapter/dst/steam-access-observation'
import { getSteamUpstreamStatus } from '../../infra/game-adapter/dst/steam-workshop'
import { loadSteamcmdRuntimeConfig } from '../../shared/config/steamcmd'
import { getServerContainerConfig } from '../../shared/config/container'

export function getModAccessStatus(instanceId: string): ModAccessStatusDto {
  const upstream = getSteamUpstreamStatus()
  const steamcmd = loadSteamcmdRuntimeConfig()
  return { ...getSteamAccessObservations(instanceId), configuration: {
    httpProxyConfigured: upstream.proxy.enabled,
    steamcmdProxyConfigured: Boolean(steamcmd.httpProxy || steamcmd.httpsProxy),
    relayListsOnly: Boolean(readBrandEnv('BSP_STEAM_RELAY_URL')?.trim()),
    webApiConfigured: Boolean(readBrandEnv('BSP_STEAM_WEBAPI_KEY')?.trim() || readBrandEnv('BSP_STEAM_WEBAPI_BASE_URL')?.trim()),
    runtime: getServerContainerConfig().runtimeMode,
    networkMode: steamcmd.networkMode,
  } }
}
