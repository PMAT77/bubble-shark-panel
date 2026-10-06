export function createInstanceActionScope(getInstanceId: () => string) {
  let generation = 0
  return {
    invalidate() { generation++ },
    capture() {
      const instanceId = getInstanceId()
      const version = generation
      return { instanceId, isCurrent: () => version === generation && instanceId === getInstanceId() }
    },
  }
}

/** 捕获目标状态，响应只属于发起操作时的实例与代次。 */
export async function updateModSubscription<T>(
  action: ReturnType<ReturnType<typeof createInstanceActionScope>['capture']>,
  item: { workshopId: string, enabled: boolean },
  update: (instanceId: string, workshopId: string, data: { enabled: boolean }) => Promise<T>,
) {
  const enabled = !item.enabled
  const response = await update(action.instanceId, item.workshopId, { enabled })
  return action.isCurrent() ? { response, enabled } : null
}
