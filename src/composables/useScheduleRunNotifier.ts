import type { InstanceSummaryItem } from '@/api/modules/instance'
import type { ScheduleRunBaseline, ScheduleTriggerNotice } from '@/views/ops/schedules/scheduleRunNotification'
import { useNotification } from 'naive-ui'
import { h, onMounted, ref, watch } from 'vue'
import apiInstance from '@/api/modules/instance'
import apiSchedule from '@/api/modules/schedule'
import { collectScheduleTriggerNotices, defaultScheduleTargetName } from '@/views/ops/schedules/scheduleRunNotification'
import { FRONTEND_ROUTE_PATHS } from '../../shared/constants/frontend-routes'
import { usePollingTask } from './usePollingTask'

/** 可见标签页每 30 秒查询一次，隐藏期间暂停，返回时立即查询。 */
const POLL_INTERVAL_MS = 30_000
/** 连续失败达到该次数后停止，重新挂载或恢复权限时可重启。 */
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

async function loadInstanceNamesOnce(signal: AbortSignal): Promise<void> {
  if (instanceNamesLoaded) {
    return
  }
  /**
   * 只要 id → 名称（通知里把任务目标写成实例名），走标识接口即可：
   * 它对 `schedule:read` 也放行，所以只有计划任务权限的账号不会在这一步吃 403。
   */
  const response = await apiInstance.getInstanceOptions(undefined, { signal })
  signal.throwIfAborted()
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
  const { auth: hasPermission } = useAppAuth()

  const mounted = ref(false)
  let failures = 0

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

  const poller = usePollingTask(async (signal) => {
    try {
      const response = await apiSchedule.getScheduleList(undefined, { signal })
      signal.throwIfAborted()
      // 实例名只解析一次；失败不影响通知本身（回退显示实例 id）
      await loadInstanceNamesOnce(signal).catch(() => undefined)
      signal.throwIfAborted()
      failures = 0
      const result = collectScheduleTriggerNotices(baseline, response.data ?? [], resolveTargetName)
      baseline = result.baseline
      for (const notice of result.notices) {
        // 页面内手动触发的任务不重复弹通知（页面自己已有 toast）
        if (!suppressedTaskIds.delete(notice.taskId)) {
          showNotice(notice)
        }
      }
    }
    catch (error) {
      if (signal.aborted) return
      failures += 1
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        poller.stop()
      }
      throw error
    }
  }, { intervalMs: POLL_INTERVAL_MS, pauseWhenHidden: true })

  watch(() => mounted.value && hasPermission('schedule:read'), (allowed) => {
    failures = 0
    if (allowed) poller.start()
    else poller.stop()
  }, { flush: 'sync' })

  onMounted(() => {
    mounted.value = true
  })
}
