import { InstanceContentBusyError, withInstanceContentOperation } from '../../shared/instance-content/operation'
export { InstanceContentBusyError as InstanceArchiveBusyError }
export const withInstanceArchiveOperationLock = withInstanceContentOperation
