import type { ModItemDto } from '@/api/modules/mod'

/** 保存完整就绪集合；不可拖动的就绪项仍须出现在后端排序参数中。 */
export function moveModLoadOrder(
  mods: ModItemDto[], fromId: string, toId: string, isPending: (id: string) => boolean,
): string[] | null {
  const from = mods.findIndex(mod => mod.workshopId === fromId)
  const to = mods.findIndex(mod => mod.workshopId === toId)
  const movable = (index: number) => index >= 0 && mods[index].installStatus === 'ready' && !isPending(mods[index].workshopId)
  if (from === to || !movable(from) || !movable(to)) return null
  const reordered = [...mods]
  const [moved] = reordered.splice(from, 1)
  reordered.splice(to, 0, moved)
  const ids = reordered.filter(mod => mod.installStatus === 'ready').map(mod => mod.workshopId)
  return ids.join(',') === mods.filter(mod => mod.installStatus === 'ready').map(mod => mod.workshopId).join(',') ? null : ids
}
