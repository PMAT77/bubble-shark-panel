import type { InstanceItem, InstanceUpdateStatusItem } from '../../../../shared/contracts/instance'

export function isInstanceUpToDate(instance: Pick<InstanceItem, 'updateCheckedAt' | 'localBuildId' | 'remoteBuildId' | 'updateAvailable'>) {
  return Boolean(instance.updateCheckedAt && instance.localBuildId && instance.remoteBuildId
    && instance.localBuildId === instance.remoteBuildId && !instance.updateAvailable)
}

export function canRepairInstance(instance: Pick<InstanceItem, 'status'>) {
  return instance.status === 'stopped' || instance.status === 'error'
}

export function buildInstanceUpdateCheckNotice(items: InstanceUpdateStatusItem[]): {
  tone: 'success' | 'info' | 'warning'
  message: string
} {
  if (!items.length) {
    return { tone: 'info', message: '没有可检查更新的实例' }
  }
  const unknown = items.filter(item => !item.localBuildId || !item.remoteBuildId).length
  const available = items.filter(item => item.localBuildId && item.remoteBuildId
    && item.localBuildId !== item.remoteBuildId).length
  if (unknown) {
    return { tone: 'warning', message: `有 ${available} 个实例可更新，${unknown} 个实例无法判断版本` }
  }
  return available
    ? { tone: 'info', message: `有 ${available} 个实例可更新` }
    : { tone: 'success', message: '已全部是最新版本' }
}
