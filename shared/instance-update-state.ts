export type InstanceUpdateState = 'unchecked' | 'current' | 'available' | 'unknown'

export function resolveInstanceUpdateState(instance: {
  updateCheckedAt: string | null
  localBuildId: string | null
  remoteBuildId: string | null
  updateAvailable: boolean
  updateCheckError?: string | null
}): InstanceUpdateState {
  if (!instance.updateCheckedAt) return 'unchecked'
  if (instance.updateCheckError || !instance.localBuildId || !instance.remoteBuildId) return 'unknown'
  return instance.updateAvailable || instance.localBuildId !== instance.remoteBuildId ? 'available' : 'current'
}
