import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * RBAC:角色、角色权限点、用户角色、实例授权。
 *
 * 设计取舍（改动前先读这一段）：
 *
 * 1. **`user_permissions` 仍是最终生效表**。角色是唯一的**编辑入口**，改角色或改成员的角色时，
 *    在同一事务里把结果物化回 `user_permissions`。这样登录、`/app/account/permission`、
 *    菜单 `auth` 判定、前端 `permissions` 数组全都不用改，存量数据也零破坏；
 *    将来要做「用户级额外授权」时，`user_permissions` 就是那个覆盖位。
 *    代价是存在两份真相——所以**只允许通过 service 层改权限**，不要直接写 `user_permissions`。
 *
 * 2. **实例授权是独立的一层**，不挂在角色上。角色的语义是「能做什么」，实例授权是「能在哪些实例上做」，
 *    两者相交生效。把实例绑到角色上会让「同一个角色在不同实例上生效范围不同」变成笛卡尔积。
 *
 * 3. **游客角色（`kind: 'guest'`）由代码固化**：权限点恒为空，服务端拒绝为它加权限点、拒绝删除。
 *    它是将来公开只读预览的唯一安全阀，所以宁可写死在代码里也不用约定。
 */

/** 角色：一组权限点 */
export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),
  /** 内置角色的稳定标识（当前只有 `guest`）；用户自建的角色为 null */
  key: text('key'),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** `user` = 普通角色；`guest` = 固化的只读游客（权限点恒为空） */
  kind: text('kind').notNull().default('user'),
  /** 1 = 内置，不可改权限点、不可删除 */
  isBuiltin: integer('is_builtin').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/** 角色 → 权限点 */
export const rolePermissions = sqliteTable('role_permissions', {
  roleId: text('role_id').notNull(),
  permission: text('permission').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [
  primaryKey({ columns: [table.roleId, table.permission] }),
])

/**
 * 用户 → 角色。
 *
 * 主键就是 `userId`：一个用户一个角色。多角色会让「权限取并集还是交集」「按哪个角色审计」
 * 两个问题同时出现，而当前场景（几个运维各管一批实例）用不到。
 * 将来要放开时，把主键改成 (userId, roleId) 即可，读权限的地方本来就是并集语义。
 */
export const userRoles = sqliteTable('user_roles', {
  userId: text('user_id').primaryKey(),
  roleId: text('role_id').notNull(),
  createdAt: text('created_at').notNull(),
})

/** 用户 → 实例（实例级可见范围）。没有行即不可见，包括列表里的聚合统计 */
export const instanceGrants = sqliteTable('instance_grants', {
  userId: text('user_id').notNull(),
  instanceId: text('instance_id').notNull(),
  /** 授权人账号 ID；系统迁移补的授权为 null */
  grantedBy: text('granted_by'),
  createdAt: text('created_at').notNull(),
}, table => [
  primaryKey({ columns: [table.userId, table.instanceId] }),
])
