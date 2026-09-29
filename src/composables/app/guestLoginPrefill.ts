/**
 * 「游客登录」按钮的自动填充逻辑（纯函数，便于单测）。
 *
 * ## 为什么要有这个文件
 *
 * 需求原话是"点击游客登录后自动填充账号密码"。**密码那一半是做不到的，也不该做**：
 * 游客账号的口令是服务端启动时生成的随机值，从不落盘、从不返回，前端手里根本没有它。
 * 任何"把口令交给前端"的做法（写进前端常量、写进仓库、由接口下发）都等于把口令公开——
 * `dist/` 是公开静态资源，拿到之后绕开按钮直接调 `/app/account/login` 就能反复使用。
 *
 * 所以这里的做法是：**自动填充只填账号，密码恒为空**，会话由服务端在
 * `POST /app/account/guest-login` 里直接签发。用户看到的仍然是"点一下就进去了"，
 * 而前端自始至终没有拿到任何可以拿去登录的凭据。
 *
 * 把它抽成纯函数是为了把"密码永远是空串"这条钉在测试里——这是本文件存在的全部意义，
 * 写成内联逻辑的话，将来有人"顺手把密码也填上"不会有任何东西拦住他。
 */

export interface GuestLoginPrefill {
  /** 要填进账号输入框的账号名（服务端返回，仅用于展示与表单回显） */
  account: string
  /** 密码输入框的值：**永远是空串** */
  password: ''
}

export interface GuestLoginResultLike {
  account?: string | null
}

/**
 * 由服务端返回的游客登录结果算出要回填到表单的内容。
 *
 * @param result 服务端返回体（只用到 `account`）
 * @param fallbackAccount 服务端没回账号名时的兜底展示名（配置里的游客账号名）
 */
export function resolveGuestLoginPrefill(
  result: GuestLoginResultLike | undefined,
  fallbackAccount = '',
): GuestLoginPrefill {
  const account = (result?.account ?? '').trim() || fallbackAccount.trim()
  return {
    account,
    // 别改这一行：见文件头注释
    password: '',
  }
}
