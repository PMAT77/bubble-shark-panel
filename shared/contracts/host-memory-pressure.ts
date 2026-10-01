/** 宿主机内存守卫失败时 API data 载荷 */
export interface HostMemoryPressureData {
  availableMb: number
  requiredMb: number
  totalMb: number | null
  capMb: number | null
  /**
   * 可用 swap 余量（MiB）；null = 读不到 /proc/meminfo。
   *
   * 它单独说明不了「有没有 swap」：`SwapFree` 为 0 既可能是没配，也可能是配了但被用满，
   * 两者的做法相反（一个要建、一个要扩）。要与 `swapTotalMb` 一起看。
   */
  swapFreeMb: number | null
  /**
   * swap 总量（MiB）；0 = 系统没有 swap，null = 读不到 /proc/meminfo。
   *
   * 「未配置」与「配置了但用满」必须分开：前者执行 `gsh setup-swap` 有用，
   * 后者会被它直接跳过（检测到已有 swap 就不动），照做一遍只会白跑。
   */
  swapTotalMb: number | null
  /** 供通知/安装日志展示的完整说明（不含标题行） */
  detail: string
}
