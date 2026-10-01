/** 宿主机内存守卫失败时 API data 载荷 */
export interface HostMemoryPressureData {
  availableMb: number
  requiredMb: number
  totalMb: number | null
  capMb: number | null
  /**
   * 可用 swap（MiB）；0 = 系统没有 swap，null = 读不到 /proc/meminfo。
   *
   * 前端靠它区分「内存紧张但有 swap 兜底」和「完全没有落点」：后者才需要建议先加 swap。
   * 只用有无判断，不展示数值（数值另有 availableMb/requiredMb 两个数字，再多一个会读不清）。
   */
  swapFreeMb: number | null
  /** 供通知/安装日志展示的完整说明（不含标题行） */
  detail: string
}
