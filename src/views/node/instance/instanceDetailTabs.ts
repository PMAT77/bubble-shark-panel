import type { PermissionKey } from '../../../../shared/constants/permissions'
import type { InstanceDetailTab } from '@/navigation/game-routes'

export function availableInstanceDetailTabs(hasPermission: (permission: PermissionKey) => boolean, supportsDst: boolean): InstanceDetailTab[] {
  const tabs: InstanceDetailTab[] = ['overview']
  const commandPermissions: PermissionKey[] = ['console:command', 'world:read', 'world:rollback', 'world:reset', 'instance.console:read']
  if (commandPermissions.some(hasPermission)) tabs.push('commands')
  if (hasPermission('file:read')) tabs.push('files')
  if (supportsDst && hasPermission('instance.migration:read')) tabs.push('migration')
  return tabs
}

export function resolveInstanceDetailTab(value: unknown, available: readonly InstanceDetailTab[]): InstanceDetailTab {
  return typeof value === 'string' && available.includes(value as InstanceDetailTab) ? value as InstanceDetailTab : 'overview'
}
