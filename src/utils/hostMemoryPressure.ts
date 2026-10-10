import type { HostMemoryPressureData } from '../../shared/contracts/host-memory-pressure'
import type { NotificationApi } from 'naive-ui'
import { h } from 'vue'
import { FRONTEND_ROUTE_PATHS } from '../../shared/constants/frontend-routes'

/** 与 shared/constants/error-code.ts 中 HOST_MEMORY_PRESSURE 保持一致 */
export const HOST_MEMORY_PRESSURE_CODE = 'HOST_MEMORY_PRESSURE'

export const HOST_MEMORY_PRESSURE_TITLE = '⚠ 主机可用内存不足'
export const HOST_MEMORY_PRESSURE_NO_SWAP_HINT = '系统未配置缓存区，建议先执行：'
export const HOST_MEMORY_PRESSURE_SETUP_SWAP_COMMAND = 'sudo bsp setup-swap'
/** 保留旧引用；增加独立swap文件，原有swap继续使用。 */
export const HOST_MEMORY_PRESSURE_EXPAND_SWAP_COMMAND
  = 'sudo env BSP_SWAP_FILE=/swapfile-bsp-extra-2g BSP_SWAP_SIZE=2G bsp setup-swap'
export const HOST_MEMORY_PRESSURE_SWAP_READY_HINT = '当前内存与 swap 余量满足预估，请检查分片内存上限及其他启动错误。'
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

export type SwapPressureState = 'unknown' | 'none' | 'low' | 'exhausted' | 'ready'

/**
 * 读取失败保持未知；即使swap还有余量，也要与本次启动预算比较。
 */
export function resolveSwapState(
  data: Pick<HostMemoryPressureData, 'swapFreeMb'> & Partial<Pick<HostMemoryPressureData, 'swapTotalMb' | 'availableMb' | 'requiredMb'>>,
): SwapPressureState {
  const total = data.swapTotalMb ?? null
  if (total === 0) return 'none'
  if (data.swapFreeMb == null) return 'unknown'
  if (data.swapFreeMb === 0) return total === null ? 'unknown' : 'exhausted'
  if (data.requiredMb !== undefined) {
    if (data.availableMb == null) return 'unknown'
    if (data.availableMb + data.swapFreeMb < data.requiredMb) return 'low'
  }
  return 'ready'
}

export function buildSwapPressureAdvice(data: HostMemoryPressureData) {
  const state = resolveSwapState(data)
  const sizeGiB = Math.max(2, Math.ceil(Math.max(0, data.requiredMb - ((data.availableMb ?? 0) + (data.swapFreeMb ?? 0))) / 1024))
  if (state === 'unknown') return { state, message: '无法读取 swap 状态，请先在服务器确认当前配置。', command: 'sudo swapon --show' }
  if (state === 'ready') return { state, message: HOST_MEMORY_PRESSURE_SWAP_READY_HINT, command: null }
  if (state === 'none') return { state, message: HOST_MEMORY_PRESSURE_NO_SWAP_HINT, command: `sudo env BSP_SWAP_SIZE=${sizeGiB}G bsp setup-swap` }
  return {
    state,
    message: state === 'low' ? `swap 尚有余量，但内存与 swap 合计不足本次启动预估，建议新增 ${sizeGiB} GiB swap。`
      : `缓存区已用满（共 ${data.swapTotalMb} MiB），建议新增 ${sizeGiB} GiB swap。`,
    command: `sudo env BSP_SWAP_FILE=/swapfile-bsp-extra-${sizeGiB}g BSP_SWAP_SIZE=${sizeGiB}G bsp setup-swap`,
  }
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

/** 命令只展示，原有swap文件不被停用或删除。 */
function renderSwapSections(data: HostMemoryPressureData) {
  const advice = buildSwapPressureAdvice(data)
  return [h('div', null, advice.message), ...(advice.command ? [
    h('div', null, advice.state === 'unknown' ? '在服务器上以 root 执行：' : '停止实例后，在服务器上以 root 执行：'),
    h('div', { class: 'font-medium break-all' }, advice.command),
  ] : [])]
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
