import type { NotificationReactive } from 'naive-ui'
import { useNotification } from 'naive-ui'
import { h, onBeforeUnmount, watch } from 'vue'
import {
  GUEST_MODE_NOTICE_CONTENT,
  GUEST_MODE_NOTICE_TITLE,
  guestModeNoticeDismissKey,
  shouldShowGuestModeNotice,
} from '@/composables/guestModeNotice'

/**
 * 游客模式提示：右上角常驻通知，**必须手动关闭**（`duration: 0`）。
 *
 * 它解释的是「为什么这个面板到处都是灰的、没有按钮」——游客角色只读，
 * 所有操作入口都按权限隐藏了。自动消失会让人刚好错过该看的那句话。
 *
 * 关掉之后按账号记住，不再每次进面板都弹；换个账号登录会重新提示。
 */
export function useGuestModeNotice(): void {
  const appAccountStore = useAppAccountStore()
  const notification = useNotification()
  let noticeRef: NotificationReactive | null = null

  function dismissKey(): string {
    return guestModeNoticeDismissKey(appAccountStore.account)
  }

  function closeNotice() {
    noticeRef?.destroy()
    noticeRef = null
    const key = dismissKey()
    if (key) {
      localStorage.setItem(key, '1')
    }
  }

  function showIfNeeded() {
    const key = dismissKey()
    const dismissed = Boolean(key) && localStorage.getItem(key) === '1'
    if (!shouldShowGuestModeNotice({
      isLogin: appAccountStore.isLogin,
      roleKind: appAccountStore.roleKind,
      dismissed,
      alreadyShown: noticeRef !== null,
    })) {
      return
    }

    noticeRef = notification.warning({
      title: GUEST_MODE_NOTICE_TITLE,
      content: GUEST_MODE_NOTICE_CONTENT,
      // 0 = 不自动消失，用户点关闭或「知道了」才收起
      duration: 0,
      closable: true,
      onClose: closeNotice,
      action: () => h(
        'a',
        {
          class: 'text-primary cursor-pointer text-sm',
          onClick: closeNotice,
        },
        '知道了',
      ),
    })
  }

  // 角色信息是进面板之后异步取回来的（getPermissions），所以要盯着它变化
  watch(
    () => [appAccountStore.isLogin, appAccountStore.roleKind, appAccountStore.account],
    showIfNeeded,
    { immediate: true },
  )

  onBeforeUnmount(() => {
    noticeRef?.destroy()
    noticeRef = null
  })
}
