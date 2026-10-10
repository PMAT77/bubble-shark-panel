import type {
  GuestLoginBody,
  LoginBody,
  LoginOptionsResponse,
  LoginResponse,
  LogoutBody,
  PasswordEditBody,
  PasswordEditResponse,
  PasswordRecoverBody,
  PasswordRecoveryStatusResponse,
  PermissionResponse,
  RefreshTokenBody,
  RefreshTokenResponse,
  SuccessResponse,
} from '../../../shared/contracts/auth'
import api from '../index'

export type {
  GuestLoginBody,
  LoginBody,
  LoginOptionsResponse,
  LoginResponse,
  LogoutBody,
  PasswordEditBody,
  PasswordEditResponse,
  PasswordRecoverBody,
  PasswordRecoveryStatusResponse,
  PermissionResponse,
  RefreshTokenBody,
  RefreshTokenResponse,
}

export default {
  routeList: () => api.get('app/route/list', { timeout: 15_000 }),
  login: (data: LoginBody) => api.post('app/account/login', data) as Promise<{ data: LoginResponse }>,
  loginOptions: () => api.get('app/account/login-options') as Promise<{ data: LoginOptionsResponse }>,
  /**
   * 游客（只读预览）免密登录。
   *
   * 注意它**没有账号与密码参数**——游客凭证根本不存在（见服务端 `shared/db/guest-account.ts`），
   * 会话由服务端直接签发。前端任何地方都不该出现游客口令。
   */
  guestLogin: (data?: GuestLoginBody) => api.post('app/account/guest-login', data ?? {}, {
    skipAuthRefresh: true,
  }) as Promise<{ data: LoginResponse }>,
  logout: (data?: LogoutBody) => api.post('app/account/logout', data ?? {}) as Promise<{ data: SuccessResponse }>,
  refreshToken: (data: RefreshTokenBody) => api.post('app/account/token/refresh', data, {
    skipAuthRefresh: true,
    timeout: 15_000,
  }) as Promise<{ data: RefreshTokenResponse }>,
  permission: () => api.get('app/account/permission', { timeout: 15_000 }) as Promise<{ data: PermissionResponse }>,
  passwordEdit: (data: PasswordEditBody) => api.post('app/account/password/edit', data) as Promise<{ data: PasswordEditResponse }>,
  passwordRecoveryStatus: () => api.get('app/account/password/recovery-status') as Promise<{
    data: PasswordRecoveryStatusResponse
  }>,
  passwordRecover: (data: PasswordRecoverBody) => api.post('app/account/password/recover', data, {
    skipAuthRefresh: true,
  }) as Promise<{ data: SuccessResponse }>,
}
