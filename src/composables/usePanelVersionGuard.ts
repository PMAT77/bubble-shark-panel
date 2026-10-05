import type { NotificationReactive } from 'naive-ui'
import { useNotification } from 'naive-ui'
import { h, onBeforeUnmount, onMounted } from 'vue'
import { resolveApiBaseUrl, withTrailingSlash } from '@/api/base-url'
import {
  readBuiltPanelVersion,
  resolvePanelVersionMismatch,
} from '@/composables/panelVersionGuard'

const PANEL_VERSION_NOTICE_DISMISSED_KEY = 'bsp-panel-version-notice-dismissed'
/** 一分钟一次：/health 是同源轻量接口（不查镜像仓库、不需登录），成本可忽略 */
const PANEL_VERSION_CHECK_INTERVAL_MS = 60 * 1000

/** 取正在运行的面板版本：读 /health 的 release.version；失败返回 null（不判定） */
async function fetchRunningPanelVersion(): Promise<string | null> {
  const baseUrl = resolveApiBaseUrl({
    dev: import.meta.env.DEV,
    proxyEnabled: import.meta.env.VITE_ENABLE_PROXY,
    configured: import.meta.env.VITE_APP_API_BASEURL,
  })
  try {
    const response = await fetch(`${withTrailingSlash(baseUrl)}health`, {
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) {
      return null
    }
    const payload = await response.json() as { release?: { version?: string } }
    return payload.release?.version?.trim() || null
  }
  catch {
    return null
  }
}

/**
 * 页面版本守门：面板升级后，让还跑着旧脚本的标签页自己喊出来。
 *
 * 只提示、不自动刷新——自动刷新会打断正在填写的表单或正在进行的操作，
 * 而用户看到「当前页面还是 vX 的界面」后点一下「刷新页面」的成本极低。
 */
export function usePanelVersionGuard() {
  const notification = useNotification()
  let noticeRef: NotificationReactive | null = null

  function dismissNotice() {
    noticeRef?.destroy()
    noticeRef = null
    sessionStorage.setItem(PANEL_VERSION_NOTICE_DISMISSED_KEY, '1')
  }

  async function checkPanelVersion() {
    if (sessionStorage.getItem(PANEL_VERSION_NOTICE_DISMISSED_KEY) === '1' || noticeRef) {
      return
    }
    const runningVersion = await fetchRunningPanelVersion()
    const mismatch = resolvePanelVersionMismatch(readBuiltPanelVersion(), runningVersion)
    if (!mismatch?.stale) {
      return
    }
    noticeRef = notification.warning({
      title: '页面还是旧版本',
      content: `当前页面是 v${mismatch.builtVersion} 的界面，面板已经更新到 v${mismatch.runningVersion}。刷新页面即可加载新界面。`,
      duration: 0,
      closable: true,
      onClose: dismissNotice,
      action: () => h(
        'a',
        {
          class: 'text-primary cursor-pointer text-sm',
          onClick: () => {
            dismissNotice()
            location.reload()
          },
        },
        '刷新页面',
      ),
    })
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      void checkPanelVersion()
    }
  }

  onMounted(() => {
    // 切回标签页时立刻查一次：用户从别处升级完面板回到这个页面是最常见的场景
    void checkPanelVersion()
    const timer = window.setInterval(() => {
      void checkPanelVersion()
    }, PANEL_VERSION_CHECK_INTERVAL_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
    onBeforeUnmount(() => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      dismissNotice()
    })
  })
}
