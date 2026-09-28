import type { PermissionKey } from '../../../shared/constants/permissions'

/**
 * 权限判定。
 *
 * 参数类型是 `PermissionKey`：**权限点拼错会编译报错**，而不是静默返回 false
 * 让按钮永久消失——按钮不见时，人只会以为是自己角色没配好，很难查到是拼写问题。
 * 空串是特例，表示"这项不需要权限"。
 */
export function useAppAuth() {
  function hasPermission(permission: PermissionKey) {
    const appSettingsStore = useAppSettingsStore()
    const appAccountStore = useAppAccountStore()
    if (appSettingsStore.settings.app.account.auth) {
      return appAccountStore.permissions.includes(permission)
    }
    else {
      return true
    }
  }

  function auth(value: PermissionKey | PermissionKey[] | '') {
    let auth
    if (typeof value === 'string') {
      auth = value !== '' ? hasPermission(value) : true
    }
    else {
      auth = value.length > 0 ? value.some(item => hasPermission(item)) : true
    }
    return auth
  }

  function authAll(value: PermissionKey[]) {
    return value.length > 0 ? value.every(item => hasPermission(item)) : true
  }

  return {
    auth,
    authAll,
  }
}
