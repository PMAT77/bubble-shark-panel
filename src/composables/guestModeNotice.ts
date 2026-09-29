/**
 * 「当前是游客模式」提示的文案与判定（纯逻辑，便于单测）。
 *
 * 为什么需要这条提示：游客角色是只读预览，界面上所有操作入口都被权限判断隐藏了。
 * 不解释的话，用户看到的是一个"到处都没有按钮"的面板，很容易以为坏了或者没加载完。
 *
 * 文案里那句"让管理员在「成员管理」里换一个角色"是**下一步该找谁**：只读预览常常是
 * 别人临时开给你看的，你得知道该去找谁、改什么，而不是以为面板坏了。
 */

export const GUEST_MODE_NOTICE_TITLE = '当前是游客模式'

export const GUEST_MODE_NOTICE_CONTENT = '此账号只能查看，无法执行任何操作——所有操作入口都已隐藏。需要操作权限，请让管理员在「成员管理」里换一个角色。'

/**
 * 「已经关过这个提示」的存储键。
 *
 * 按账号分开：换个账号登录（例如管理员来看效果）时该重新提示一次，
 * 而同一个账号关过一次就别再每次都弹。
 */
export function guestModeNoticeDismissKey(account: string): string {
  const trimmed = account.trim()
  return trimmed ? `gsh-guest-mode-notice-dismissed:${trimmed}` : ''
}

export interface GuestModeNoticeState {
  isLogin: boolean
  roleKind: 'user' | 'guest' | null
  /** 这个账号已经关过提示 */
  dismissed: boolean
  /** 提示当前已经在屏幕上 */
  alreadyShown: boolean
}

export function shouldShowGuestModeNotice(state: GuestModeNoticeState): boolean {
  return state.isLogin && state.roleKind === 'guest' && !state.dismissed && !state.alreadyShown
}
