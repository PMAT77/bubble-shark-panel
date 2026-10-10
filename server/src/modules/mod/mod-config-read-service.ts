import type { ModConfigDto } from '../../../../shared/contracts/mod'
import { parseModOverridesConfigurations, parseStoredModConfig } from '../../infra/game-adapter/dst/mod-config'
import { readModInfoConfigurations } from '../../infra/game-adapter/dst/modinfo-reader'

export async function readModConfig(instanceId: string, installPath: string, workshopId: string, storedConfig: string | null): Promise<ModConfigDto> {
  return {
    instanceId,
    workshopId,
    options: parseStoredModConfig(storedConfig) ?? parseModOverridesConfigurations(installPath).get(workshopId) ?? {},
    ...await readModInfoConfigurations(installPath, workshopId),
  }
}
