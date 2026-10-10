import api from '../index'
import type { WorldMaintenanceOperation, WorldMaintenancePayload } from '../../../shared/contracts/world-maintenance'
export type { WorldMaintenanceOperation, WorldMaintenancePayload } from '../../../shared/contracts/world-maintenance'
export default {
  begin: (payload: WorldMaintenancePayload) => api.post('app/instance/world-maintenance', payload) as Promise<{ data: WorldMaintenanceOperation }>,
  status: (instanceId: string, operationId?: string) => api.get('app/instance/world-maintenance', { params: { instanceId, operationId } }) as Promise<{ data: WorldMaintenanceOperation | null }>,
  continue: (instanceId: string, operationId: string, withoutBackup: boolean) => api.post('app/instance/world-maintenance/continue', { instanceId, operationId, withoutBackup }) as Promise<{ data: WorldMaintenanceOperation }>,
  verify: (instanceId: string, operationId: string) => api.post('app/instance/world-maintenance/verify', { instanceId, operationId }) as Promise<{ data: WorldMaintenanceOperation }>,
}
