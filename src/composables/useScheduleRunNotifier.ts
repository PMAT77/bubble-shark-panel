import type { InstanceSummaryItem } from '@/api/modules/instance'
import type { ScheduleRunBaseline, ScheduleTriggerNotice } from '@/views/ops/schedules/scheduleRunNotification'
import { useNotification } from 'naive-ui'
import apiInstance from '@/api/modules/instance'
import apiSchedule from '@/api/modules/schedule'
import { collectScheduleTriggerNotices, defaultScheduleTargetName } from '@/views/ops/schedules/scheduleRunNotification'
import { FRONTEND_ROUTE_PATHS } from '../../shared/constants/frontend-routes'

/** 轮询间隔：触发通知的最大延迟；计划任务列表查询很轻，10s 足够及时又不打扰 */
const POLL_INTERVAL_MS = 10_000
/** 连续失败（如当前账号没有 ops:read 权限）达到该次数后停止本会话轮询 */
const MAX_CONSECUTIVE_FAILURES = 5

/** taskId → 上次已知的 lastRunAt；用「触发时刻变化」识别一次新的触发 */
let baseline: ScheduleRunBaseline = new Map()
/** 页面内手动「立即执行」登记的任务：变化时跳过通知（页面已有 toast 反馈） */
const suppressedTaskIds = new Set<string>()
/** 实例名缓存（懒加载一次，失败时回退显示实例 id） */
const instanceNames = new Map<string, string>()
let instanceNamesLoaded = false

/** 供「立即执行」调用：该任务的下一次 lastRunAt 变化不再触发右上角通知 */
export function suppressScheduleRunNotificationOnce(taskId: string): void {
  suppressedTaskIds.add(taskId)
}

function resolveTargetName(instanceId: string): string {
  return instanceNames.get(instanceId) ?? defaultScheduleTargetName(instanceId)
}

async function loadInstanceNamesOnce(): Promise<void> {
  if (instanceNamesLoaded) {
    return
  }
  /**
   * 只要 id → 名称（通知里把任务目标写成实例名），走标识接口即可：
   * 它对 `schedule:read` 也放行，所以只有计划任务权限的账号不会在这一步吃 403。
   */
  const response = await apiInstance.getInstanceOptions()
  for (const item of (response.data ?? []) as InstanceSummaryItem[]) {
    instanceNames.set(item.id, item.name)
  }
  instanceNamesLoaded = true
}

/**
 * 计划任务被触发时在面板右上角弹通知。
 * 挂在 Layout 上覆盖所有页面：轮询任务列表，某任务 lastRunAt 出现新值即视为一次触发。
 */
export function useScheduleRunNotifier(): void {
  const notification = useNotification()
  const router = useRouter()

  let timer: number | undefined
  let stopped = false
  let inFlight = false
  let failures = 0

  function stopPolling(): void {
    stopped = true
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
  }

  function showNotice(notice: ScheduleTriggerNotice): void {
    // 带上 taskId：计划任务列表据此滚动并高亮对应的那条任务
    const target = router.resolve({
      path: FRONTEND_ROUTE_PATHS.opsSchedules,
      query: { taskId: notice.taskId },
    })
    const options = {
      title: notice.title,
      content: notice.content,
      duration: notice.durationMs,
      action: () => h(
        'a',
        {
          // href 作为兜底：即使脚本事件未生效，浏览器原生跳转也能到达计划任务页
          href: target.href,
          class: 'text-primary cursor-pointer text-sm',
          onClick: (event: MouseEvent) => {
            event.preventDefault()
            void router.push(target)
          },
        },
        '查看任务',
      ),
    }
    switch (notice.level) {
      case 'error':
        notification.error(options)
        break
      case 'warning':
        notification.warning(options)
        break
      case 'info':
        notification.info(options)
        break
      default:
        notification.success(options)
    }
  }

  async function poll(): Promise<void> {
    if (inFlight || stopped) {
      return
    }
    inFlight = true
    try {
      const response = await apiSchedule.getScheduleList()
      failures = 0
      // 实例名只解析一次；失败不影响通知本身（回退显示实例 id）
      await loadInstanceNamesOnce().catch(() => undefined)
      const result = collectScheduleTriggerNotices(baseline, response.data ?? [], resolveTargetName)
      baseline = result.baseline
      for (const notice of result.notices) {
        // 页面内手动触发的任务不重复弹通知（页面自己已有 toast）
        if (!suppressedTaskIds.delete(notice.taskId)) {
          showNotice(notice)
        }
      }
    }
    catch {
      failures += 1
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        stopPolling()
      }
    }
    finally {
      inFlight = false
      if (!stopped) {
        timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS)
      }
    }
  }

  onMounted(() => {
    void poll()
  })

  onBeforeUnmount(() => {
    stopPolling()
  })
}
