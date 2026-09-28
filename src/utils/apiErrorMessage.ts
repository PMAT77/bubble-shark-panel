/**
 * 从请求层抛出的错误里取业务消息。
 *
 * 本项目的业务错误走 **HTTP 200 + `status: 1` + 非空 `error`**（参见
 * `docs_local/module-status.md` 的接口口径），请求层会把 `error` 抛出来。
 * 页面要做的是**把后端那句话原样显示**——像「不能停用当前登录的账号」这类提示
 * 本身就是给用户看的解释，页面再包一层「操作失败」只会把它盖掉。
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const text = String((error as { message?: unknown }).message ?? '').trim()
    if (text) {
      return text
    }
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }
  return fallback
}
