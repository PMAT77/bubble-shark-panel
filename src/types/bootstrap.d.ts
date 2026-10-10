interface Window {
  /** 入口内联脚本提供的首屏生命周期；模块加载失败时也能显示恢复入口。 */
  __BSP_BOOTSTRAP__?: {
    readonly state: 'pending' | 'ready' | 'failed'
    readonly message: string
    fail: (message: string) => void
    ready: () => boolean
  }
}
