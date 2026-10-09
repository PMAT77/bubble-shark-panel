import type { InstanceItem, InstanceUpdateStatusItem } from '../../../../shared/contracts/instance'
import { formatDateTime } from './utils'
import { resolveInstanceUpdateState } from '../../../../shared/instance-update-state'
export { resolveInstanceUpdateState } from '../../../../shared/instance-update-state'

export function isInstanceUpToDate(instance: Pick<InstanceItem, 'updateCheckedAt' | 'localBuildId' | 'remoteBuildId' | 'updateAvailable' | 'updateCheckError'>) {
  return resolveInstanceUpdateState(instance) === 'current'
}

export function canRetryInstanceInstall(instance: InstanceItem) {
  return (instance.lastErrorPhase === 'install' || instance.installLogStatus === 'failed' || instance.installLogStatus === 'cancelled')
    || (instance.status === 'stopped' && !instance.installLogStatus && !instance.localBuildId && !instance.updateCheckedAt)
}

export function canUpdateInstance(instance: InstanceItem) {
  return canForceUpdateInstance(instance)
    && (canRetryInstanceInstall(instance) || resolveInstanceUpdateState(instance) === 'available')
}

export function canForceUpdateInstance(instance: Pick<InstanceItem, 'status'> & Partial<Pick<InstanceItem, 'installTask'>>) {
  return !instance.installTask?.cleanupPending && (instance.status === 'stopped' || instance.status === 'error')
}

export function buildInstanceUpdateCheckNotice(items: InstanceUpdateStatusItem[]): {
  tone: 'success' | 'info' | 'warning'
  message: string
} {
  if (!items.length) {
    return { tone: 'info', message: '没有可检查更新的实例' }
  }
  const checkedAt = items.map(item => item.updateCheckedAt).filter((value): value is string => Boolean(value)).sort()[0]
  const checkedTime = checkedAt ? `；版本查询时间：${formatDateTime(checkedAt)}` : ''
  const unknown = items.filter(item => resolveInstanceUpdateState(item) === 'unknown' || resolveInstanceUpdateState(item) === 'unchecked').length
  const available = items.filter(item => resolveInstanceUpdateState(item) === 'available').length
  if (unknown) {
    const reasons = items.filter(item => resolveInstanceUpdateState(item) !== 'current' && resolveInstanceUpdateState(item) !== 'available')
      .map(item => `${item.name}：${item.updateCheckError ?? item.message ?? '尚未检查版本'}`)
    return { tone: 'warning', message: `有 ${available} 个实例可更新，${unknown} 个实例无法判断版本${reasons.length ? `；${reasons.join('；')}` : ''}${checkedTime}` }
  }
  return available
    ? { tone: 'info', message: `有 ${available} 个实例可更新${checkedTime}` }
    : { tone: 'success', message: `已全部是最新版本${checkedTime}` }
}
