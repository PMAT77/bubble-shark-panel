import type { NotificationReactive } from 'naive-ui'
import { useNotification } from 'naive-ui'
import apiSystem from '@/api/modules/system'

const PANEL_UPDATE_NOTIFY_DISMISSED_KEY = 'bsp-panel-update-dismissed'

export function usePanelUpdateNotifier() {
  const notification = useNotification()
  const route = useRoute()
  const router = useRouter()
  let notificationRef: NotificationReactive | null = null

  function dismissNotification() {
    notificationRef?.destroy()
    notificationRef = null
    sessionStorage.setItem(PANEL_UPDATE_NOTIFY_DISMISSED_KEY, '1')
  }

  function buildUpdateMessage(status: Awaited<ReturnType<typeof apiSystem.getPanelUpdateStatus>>['data']) {
    const releaseHint = status.release?.tagName ? `（${status.release.tagName}）` : ''
    return `面板有新版本${releaseHint}，请前往「系统设置」更新。`
  }

  async function pollPanelUpdateStatus() {
    if (route.path === '/login' || route.path === '/force-change-password') {
      return
    }
    if (sessionStorage.getItem(PANEL_UPDATE_NOTIFY_DISMISSED_KEY) === '1') {
      return
    }
    try {
      const res = await apiSystem.getPanelUpdateStatus()
      const status = res.data
      const hasUpdate = status.image.updateAvailable
      if (!hasUpdate) {
        dismissNotification()
        return
      }
      if (notificationRef) {
        return
      }
      notificationRef = notification.warning({
        title: 'Hub 有新版本可用',
        content: buildUpdateMessage(status),
        duration: 0,
        closable: true,
        onClose: dismissNotification,
        action: () => h(
          'a',
          {
            class: 'text-primary cursor-pointer text-sm',
            onClick: () => {
              dismissNotification()
              void router.push('/system/settings')
            },
          },
          '前往设置',
        ),
      })
    }
    catch {
      // ignore polling errors
    }
  }

  onMounted(() => {
    void pollPanelUpdateStatus()
    const timer = window.setInterval(() => {
      void pollPanelUpdateStatus()
    }, 5 * 60 * 1000)
    onBeforeUnmount(() => {
      window.clearInterval(timer)
      dismissNotification()
    })
  })
}
