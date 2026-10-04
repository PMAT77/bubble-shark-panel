export function validateModImportIds(items: Array<{ itemId: string, workshopId: string }>, reservedIds: string[]): Map<string, string> {
  const errors = new Map<string, string>()
  const owners = new Map<string, string>()
  for (const item of items) {
    const id = item.workshopId.trim()
    if (!/^[1-9]\d{0,19}$/.test(id)) errors.set(item.itemId, '请填写有效的 Workshop ID')
    else if (reservedIds.includes(id)) errors.set(item.itemId, '此 ID 为面板内置 Mod 保留 ID，不能导入')
    else if (owners.has(id)) {
      errors.set(item.itemId, '同一个 ZIP 中的 Workshop ID 不能重复')
      errors.set(owners.get(id)!, '同一个 ZIP 中的 Workshop ID 不能重复')
    }
    owners.set(id, item.itemId)
  }
  return errors
}
