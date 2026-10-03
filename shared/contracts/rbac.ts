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
  /** 内置角色的稳定标识（`guest`、`system-admin`）；用户自建的为 null */
  key: z.string().nullable(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(['user', 'guest']),
  /** 内置角色不可修改、不可删除 */
  isBuiltin: z.boolean(),
  permissions: z.array(permissionKeySchema),
  memberCount: z.number().int().nonnegative(),
})
export type RoleListItem = z.infer<typeof roleListItemSchema>

/**
 * 角色的最小投影：只够"选一个角色"用。
 *
 * 「成员管理」要能分配角色，但它只需要角色的名字（`isBuiltin` 用于标出内置角色），
 * 不需要权限点清单与成员数——那是「角色管理」页的内容。此前成员页调的是
 * `GET /app/system/roles`（要求 `role:read`），于是"能管成员"被迫等于"能看角色与权限矩阵"；
 * 现在走 `GET /app/system/role-options`，`role:read` 或 `member:read` 任一即可。
 */
export const roleOptionItemSchema = z.object({
  id: idSchema,
  name: z.string(),
  /** 内置角色不可修改、不可删除，成员页据此标出「内置」 */
  isBuiltin: z.boolean(),
})
export type RoleOptionItem = z.infer<typeof roleOptionItemSchema>

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
  /**
   * 是不是配置里的超级管理员账号（默认 `superadmin`）。
   *
   * 界面据此不提供「重置密码」入口——它的密码只能本人在「个人设置 → 修改密码」里改。
   * 真正的拦截在服务端，这个字段只是让入口别出现在那里。
   */
  isAdminAccount: z.boolean(),
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
