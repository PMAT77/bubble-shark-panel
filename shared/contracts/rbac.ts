import { z } from 'zod'
import { PERMISSION_SPECS } from '../constants/permissions'

/**
 * 成员与角色（RBAC）的对外契约。
 *
 * 权限点本身的清单不在这里——它是 `shared/constants/permissions.ts` 的 `PERMISSION_SPECS`，
 * 前端直接 import 它渲染勾选面板。**不要另开一个"权限点列表"接口**：
 * 多一份传输就多一个漂移点，而这个清单是前端与后端都要用的同一份常量。
 */

const idSchema = z.string().trim().min(1).max(128)
const permissionKeySchema = z.string().trim().min(1).max(128)
const secretSchema = z.string().min(1).max(256)

/** 一个角色（含它的权限点与成员数） */
export const roleListItemSchema = z.object({
  id: idSchema,
  /** 内置角色的稳定标识（当前只有 `guest`）；用户自建的为 null */
  key: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(['user', 'guest']),
  /** 内置角色不可改权限点、不可删除 */
  isBuiltin: z.boolean(),
  permissions: z.array(permissionKeySchema),
  memberCount: z.number().int().nonnegative(),
})
export type RoleListItem = z.infer<typeof roleListItemSchema>

export const roleCreatePayloadSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(permissionKeySchema).max(PERMISSION_SPECS.length),
})
export type RoleCreatePayload = z.infer<typeof roleCreatePayloadSchema>

export const roleUpdatePayloadSchema = z.object({
  roleId: idSchema,
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(permissionKeySchema).max(PERMISSION_SPECS.length),
})
export type RoleUpdatePayload = z.infer<typeof roleUpdatePayloadSchema>

export const roleDeletePayloadSchema = z.object({ roleId: idSchema })
export type RoleDeletePayload = z.infer<typeof roleDeletePayloadSchema>

export const roleMutationResultSchema = z.object({
  isSuccess: z.boolean(),
  roleId: idSchema.optional(),
  message: z.string().optional(),
})
export type RoleMutationResult = z.infer<typeof roleMutationResultSchema>

/** 一个成员（含角色与实例授权范围） */
export const memberListItemSchema = z.object({
  id: idSchema,
  account: z.string(),
  email: z.string(),
  avatar: z.string(),
  /** 1 = 启用，0 = 停用 */
  status: z.number().int(),
  mustChangePassword: z.boolean(),
  roleId: z.string().nullable(),
  roleName: z.string().nullable(),
  roleKind: z.enum(['user', 'guest']).nullable(),
  /** 该成员被授权的实例 ID；鉴权时与角色能力相交生效 */
  instanceIds: z.array(idSchema),
  createdAt: z.string(),
})
export type MemberListItem = z.infer<typeof memberListItemSchema>

export const memberCreatePayloadSchema = z.object({
  account: z.string().trim().min(1).max(128),
  password: secretSchema,
  roleId: idSchema,
  instanceIds: z.array(idSchema).max(500).optional(),
  /**
   * 首次登录强制改密，默认 true。
   *
   * 默认开是有意的：管理员建子账号时给的是初始密码，让它长期有效等于把"初始密码"
   * 变成了长期凭据。需要例外（例如给只读预览账号）时显式传 false。
   */
  mustChangePassword: z.boolean().optional(),
})
export type MemberCreatePayload = z.infer<typeof memberCreatePayloadSchema>

export const memberUpdatePayloadSchema = z.object({
  userId: idSchema,
  roleId: idSchema.optional(),
  status: z.union([z.literal(0), z.literal(1)]).optional(),
})
export type MemberUpdatePayload = z.infer<typeof memberUpdatePayloadSchema>

export const memberPasswordResetPayloadSchema = z.object({
  userId: idSchema,
  password: secretSchema,
  mustChangePassword: z.boolean().optional(),
})
export type MemberPasswordResetPayload = z.infer<typeof memberPasswordResetPayloadSchema>

export const memberInstanceGrantPayloadSchema = z.object({
  userId: idSchema,
  instanceIds: z.array(idSchema).max(500),
})
export type MemberInstanceGrantPayload = z.infer<typeof memberInstanceGrantPayloadSchema>

export const memberDeletePayloadSchema = z.object({ userId: idSchema })
export type MemberDeletePayload = z.infer<typeof memberDeletePayloadSchema>

export const memberMutationResultSchema = z.object({
  isSuccess: z.boolean(),
  userId: idSchema.optional(),
  message: z.string().optional(),
})
export type MemberMutationResult = z.infer<typeof memberMutationResultSchema>
