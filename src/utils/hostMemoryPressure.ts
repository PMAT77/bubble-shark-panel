import type { HostMemoryPressureData } from '../../shared/contracts/host-memory-pressure'
import type { NotificationApi } from 'naive-ui'
import { h } from 'vue'
import { FRONTEND_ROUTE_PATHS } from '../../shared/constants/frontend-routes'

/** 与 shared/constants/error-code.ts 中 HOST_MEMORY_PRESSURE 保持一致 */
export const HOST_MEMORY_PRESSURE_CODE = 'HOST_MEMORY_PRESSURE'

export const HOST_MEMORY_PRESSURE_TITLE = '⚠ 主机可用内存不足'
export const HOST_MEMORY_PRESSURE_NO_SWAP_HINT = '系统未配置缓存区，建议先执行：'
export const HOST_MEMORY_PRESSURE_SETUP_SWAP_COMMAND = 'sudo bsp setup-swap'
/** swap 已配置但被用满：此时 setup-swap 会直接返回，必须换一条能真正生效的命令 */
export const HOST_MEMORY_PRESSURE_EXPAND_SWAP_COMMAND
  = 'sudo swapoff /swapfile-bsp && sudo rm -f /swapfile-bsp && sudo sed -i \'\\#^/swapfile-bsp #d\' /etc/fstab && sudo BSP_SWAP_SIZE=4G bsp setup-swap'
export const HOST_MEMORY_PRESSURE_SWAP_READY_HINT = '系统已配置缓存区，启动继续。'
export const HOST_MEMORY_PRESSURE_FOOTER = '如启动后仍出现内存不足，请关闭其他服务或增加内存。'

export interface HostMemoryPressureErrorPayload {
  status?: number
  error?: string
  code?: string
  data?: HostMemoryPressureData
}

/** 跳转监控台的动作：拿不到 router 时也要能靠 href 跳过去，所以交给调用方注入 */
export type MonitorNavigator = () => Promise<unknown> | unknown

export function isHostMemoryPressureError(payload: unknown): payload is HostMemoryPressureErrorPayload & {
  code: typeof HOST_MEMORY_PRESSURE_CODE
  error: string
  data: HostMemoryPressureData
} {
  if (!payload || typeof payload !== 'object') {
    return false
  }
  const item = payload as HostMemoryPressureErrorPayload
  return item.code === HOST_MEMORY_PRESSURE_CODE
    && typeof item.error === 'string'
    && typeof item.data?.detail === 'string'
}

export type SwapPressureState = 'none' | 'exhausted' | 'ready'

/**
 * swap 落点状态；与 server 侧 `resolveSwapState` 同一口径。
 *
 * 只看 `swapFreeMb` 会把「配了但被用满」当成「没配」：前者执行 `bsp setup-swap` 会被直接跳过
 * （脚本检测到已有 swap 就不动），照着提示跑一遍什么都不会变。
 * 缺 `swapTotalMb`（旧载荷）时退回按余量判断，方向与从前一致。
 */
export function resolveSwapState(
  data: Pick<HostMemoryPressureData, 'swapFreeMb'> & { swapTotalMb?: number | null },
): SwapPressureState {
  const total = data.swapTotalMb ?? null
  if (total === null) {
    return (data.swapFreeMb ?? 0) > 0 ? 'ready' : 'none'
  }
  if (total === 0) {
    return 'none'
  }
  return (data.swapFreeMb ?? 0) > 0 ? 'ready' : 'exhausted'
}

/**
 * 当前地址。非浏览器环境、或 `location` 由宿主注入却没有 `href` 时返回空串。
 *
 * 这个函数在通知的渲染路径上被调用：拿不到地址只该退化成「没有 hash 的普通链接」，
 * 不能抛错——一旦抛错，整条通知（含那个浏览器原生兜底的 `<a href>`）都渲染不出来。
 */
function readCurrentHref(): string {
  const raw = (globalThis as { location?: { href?: unknown } }).location?.href
  return typeof raw === 'string' ? raw : ''
}

/**
 * 监控台的 `<a href>`。
 *
 * hash 模式（默认）下 `#/…` 本身就是可用的地址，vue-router 也会接住这次 hashchange；
 * 这里刻意不读 router 也不读应用设置，就是为了让兜底不受任何模块加载顺序影响。
 */
export function buildMonitorHref(
  currentHref = readCurrentHref(),
  baseUrl = '/',
): string {
  const path = FRONTEND_ROUTE_PATHS.consoleMonitor
  const base = baseUrl && baseUrl !== '/' ? baseUrl.replace(/\/$/, '') : ''
  if (currentHref.includes('#/') || currentHref.endsWith('#')) {
    return `#${path}`
  }
  return `${base}${path}`
}

/** 第一段的两个数字，取自守卫的同一套读数 */
export function buildHostMemoryPressureSummaryLines(
  data: Pick<HostMemoryPressureData, 'availableMb' | 'requiredMb'>,
): string[] {
  return [
    `当前可用内存：${data.availableMb} MiB`,
    `本次启动预计需要：${data.requiredMb} MiB`,
  ]
}

/**
 * 通知里的动作按钮：跳转监控台。
 *
 * 用 `<a href>` 而不是 `<button>`，并用注入的 navigate 而不是点击时才 `await import('@/router')`：
 * - `href` 是浏览器原生兜底，即使回调中途出错，点击也照样能跳过去；
 * - 点击时再异步加载模块，一旦加载失败整个回调会静默中止，表现就是「点了没反应」。
 * 点击时还要先销毁通知，否则人已经换页了通知还挂着，看起来也像按钮没生效。
 */
export function renderMonitorAction(
  notice: { destroy: () => void },
  navigate?: MonitorNavigator,
) {
  const href = buildMonitorHref()
  return h(
    'a',
    {
      class: 'text-primary cursor-pointer text-sm',
      href,
      onClick: async (event: MouseEvent) => {
        event.preventDefault()
        notice.destroy()
        if (!navigate) {
          location.assign(href)
          return
        }
        try {
          await navigate()
        }
        catch (error) {
          // 走到这里说明命名路由跳转没成功。href 已经在手上，直接交给浏览器，别让这次点击白点。
          console.error('[host-memory-pressure] 跳转监控台失败，改用浏览器跳转兜底：', error)
          location.assign(href)
        }
      },
    },
    '查看内存占用',
  )
}

/** swap 提示：命令单独成行，方便直接照着敲；「没配」与「配了但用满」给的是两条不同的命令 */
function renderSwapSections(data: HostMemoryPressureData) {
  const state = resolveSwapState(data)
  if (state === 'ready') {
    return [h('div', null, HOST_MEMORY_PRESSURE_SWAP_READY_HINT)]
  }
  if (state === 'exhausted') {
    return [
      h('div', null, `缓存区已用满（共 ${data.swapTotalMb} MiB），加载尖峰没有落点，建议扩到 4 GiB：`),
      h('div', { class: 'font-medium break-all' }, HOST_MEMORY_PRESSURE_EXPAND_SWAP_COMMAND),
    ]
  }
  return [
    h('div', null, HOST_MEMORY_PRESSURE_NO_SWAP_HINT),
    h('div', { class: 'font-medium' }, HOST_MEMORY_PRESSURE_SETUP_SWAP_COMMAND),
  ]
}

export function showHostMemoryPressureNotification(
  notification: NotificationApi,
  payload: HostMemoryPressureErrorPayload & { data: HostMemoryPressureData },
  navigate?: MonitorNavigator,
) {
  const notice = notification.warning({
    title: HOST_MEMORY_PRESSURE_TITLE,
    content: () => h('div', { class: 'space-y-2 max-w-md' }, [
      ...buildHostMemoryPressureSummaryLines(payload.data).map(line => h('div', null, line)),
      ...renderSwapSections(payload.data),
      h('div', null, HOST_MEMORY_PRESSURE_FOOTER),
    ]),
    duration: 0,
    closable: true,
    action: () => renderMonitorAction(notice, navigate),
  })
}

export function tryNotifyHostMemoryPressure(
  notification: NotificationApi,
  error: unknown,
  navigate?: MonitorNavigator,
): boolean {
  if (!isHostMemoryPressureError(error)) {
    return false
  }
  showHostMemoryPressureNotification(notification, error, navigate)
  return true
}
