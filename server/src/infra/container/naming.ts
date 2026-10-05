import { readBrandEnv } from '../../../../shared/brand-env'
import type { ShardRole } from './types'

export function buildShardContainerName(instanceId: string, shard: ShardRole): string {
  const safeId = instanceId.replace(/[^a-zA-Z0-9_.-]/g, '-')
  return `${resolveResourcePrefix()}-${safeId}-${shard}`
}

export function buildMasterContainerName(instanceId: string): string {
  return buildShardContainerName(instanceId, 'master')
}

export function buildCavesContainerName(instanceId: string): string {
  return buildShardContainerName(instanceId, 'caves')
}

/** The persisted identity wins; a branding update must not duplicate an existing shard. */
export function shardNameCandidates(name: string): string[] {
  if (name.startsWith('bsp-')) return [name, name.replace(/^bsp-/, 'gsh-')]
  return [name]
}

export function resolveResourcePrefix(): 'bsp' | 'gsh' {
  const explicit = readBrandEnv('BSP_RESOURCE_PREFIX')
  if (explicit === 'bsp' || explicit === 'gsh') return explicit
  return readBrandEnv('BSP_PANEL_CONTAINER_NAME') === 'game-server-hub-panel'
    || process.env.DB_PATH?.includes('game-server-hub.sqlite') ? 'gsh' : 'bsp'
}
