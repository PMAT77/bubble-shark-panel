import { z } from 'zod'

const accountSchema = z.string().trim().min(1).max(128)
const secretSchema = z.string().min(1).max(256)
const tokenSchema = z.string().trim().min(1).max(4096)

export const loginBodySchema = z.object({
  account: accountSchema,
  password: secretSchema,
  remember: z.boolean().optional(),
  challengeToken: z.string().trim().min(1).max(256).optional(),
  challengeAnswer: z.string().trim().min(1).max(256).optional(),
})
export type LoginBody = z.infer<typeof loginBodySchema>

export const logoutBodySchema = z.object({
  refreshToken: z.string().trim().max(4096).optional(),
})
export type LogoutBody = z.infer<typeof logoutBodySchema>

export const refreshTokenBodySchema = z.object({
  refreshToken: tokenSchema,
})
export type RefreshTokenBody = z.infer<typeof refreshTokenBodySchema>

export const passwordEditBodySchema = z.object({
  password: secretSchema,
  newPassword: secretSchema,
})
export type PasswordEditBody = z.infer<typeof passwordEditBodySchema>

export const passwordRecoverBodySchema = z.object({
  account: accountSchema,
  recoveryToken: tokenSchema,
  newPassword: secretSchema,
})
export type PasswordRecoverBody = z.infer<typeof passwordRecoverBodySchema>

/**
 * 游客（只读预览）免密登录的请求体。
 *
 * 没有账号与密码字段——这是刻意的：**游客凭证不存在**。
 * 面板启动时按 `BSP_GUEST_LOGIN_ACCOUNT` 预置一个口令为随机值且不落盘的账号，
 * 登录页的「游客登录」按钮只是让服务端为它签发一个会话。
 *
 * 仍然接受验证码字段：游客入口是匿名的，被刷时也要能升级到验证码（与普通登录同口径）。
 */
export const guestLoginBodySchema = z.object({
  challengeToken: z.string().trim().min(1).max(256).optional(),
  challengeAnswer: z.string().trim().min(1).max(256).optional(),
})
export type GuestLoginBody = z.infer<typeof guestLoginBodySchema>

const authSessionSchema = z.object({
  account: z.string(),
  token: z.string(),
  refreshToken: z.string(),
  avatar: z.string(),
  email: z.string(),
  accessExpiresInSec: z.number().int().positive(),
  refreshExpiresInSec: z.number().int().positive(),
})

export const loginResponseSchema = authSessionSchema.extend({
  remember: z.boolean(),
  mustChangePassword: z.boolean(),
})
export type LoginResponse = z.infer<typeof loginResponseSchema>

export const refreshTokenResponseSchema = authSessionSchema.extend({
  mustChangePassword: z.boolean(),
})
export type RefreshTokenResponse = z.infer<typeof refreshTokenResponseSchema>

export const permissionResponseSchema = z.object({
  permissions: z.array(z.string()),
  mustChangePassword: z.boolean(),
  /**
   * 当前账号的角色种类：`guest` 就是内置游客角色（只读预览）。
   *
   * 界面据此弹「当前是游客模式」的提示——不靠"权限点全是 read"去猜：
   * 管理员自建的只读角色也长那样，猜出来的提示会张冠李戴。
   */
  roleKind: z.enum(['user', 'guest']).nullable(),
})
export type PermissionResponse = z.infer<typeof permissionResponseSchema>

export const passwordEditResponseSchema = z.object({
  isSuccess: z.literal(true),
  mustChangePassword: z.literal(false),
})
export type PasswordEditResponse = z.infer<typeof passwordEditResponseSchema>

export const passwordRecoveryStatusResponseSchema = z.object({
  enabled: z.boolean(),
  hint: z.string().nullable(),
})
export type PasswordRecoveryStatusResponse = z.infer<typeof passwordRecoveryStatusResponseSchema>

/**
 * 登录页初始化需要的服务端能力开关。
 *
 * 为什么不把开关塞进 `POST /app/account/login` 的响应：登录页在**渲染之前**就要知道
 * 有没有游客入口（没有就不该渲染那个按钮，而不是让用户点出一个报错）。
 * 这也是本项目里第一条"只回答能力开关"的匿名接口，与
 * `/app/account/password/recovery-status` 同一性质：不含任何凭证与账号信息。
 */
export const loginOptionsResponseSchema = z.object({
  /** 是否开放游客（只读预览）免密登录 */
  guestLoginEnabled: z.boolean(),
  /**
   * 游客账号名，仅用于按钮上的展示文案（例如「以游客身份预览」）。
   *
   * 它不是凭证：口令是随机值且不落盘，知道账号名没有任何用。
   */
  guestAccountLabel: z.string(),
})
export type LoginOptionsResponse = z.infer<typeof loginOptionsResponseSchema>

export const successResponseSchema = z.object({
  isSuccess: z.literal(true),
})
export type SuccessResponse = z.infer<typeof successResponseSchema>
