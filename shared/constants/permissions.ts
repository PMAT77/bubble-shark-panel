/**
 * 权限点常量（前后端共用）。
 *
 * 为什么单独抽出来：菜单定义在服务端（`server/src/shared/menu-routes.ts`），
 * 而前端也要按同一套权限点判断「这个入口能不能点」。此前常量定义在服务端模块里，
 * 前端无法 import，只能硬编码字符串——一旦改名，服务端拒绝了、前端还在放行（或反之），
 * 表现为"点进去全是报错"。放在 `shared/constants/` 下两边都能用同一份定义。
 *
 * ---
 *
 * **2026-09 起的细粒度体系**：本文件同时是本项目的「权限点唯一真源」。
 *
 * - 每个权限点在 `PERMISSION_SPECS` 里有一条登记，含中文名、模块分组、读写性质与作用域；
 * - 角色管理页的勾选面板、服务端鉴权、菜单 `auth`、前端按钮、以及
 *   `scripts/check-route-permissions.mjs` 门禁都从这一份消费，不允许另写一份清单；
 * - **命名规则**：`模块[.子模块]:动作`，动作为 `read` / `write` / 具体动词（`create`、`kick`…）。
 *   子模块只有在同一模块下需要再分一层时才用（`instance.console`、`world.map`、`player.profile`）。
 * - **作用域 `scope`**：`instance` 表示该权限点作用于某个具体实例，服务端在权限点之外
 *   **还必须**校验调用者对该实例有授权（`instance_grants`）；`global` 表示与具体实例无关。
 *   这个字段不是文档，`authorizeInstance` 的实现依赖它。
 *
 * 新增权限点的步骤：在 `PERMISSION_SPECS` 加一条 → 在路由上引用 → 跑门禁。
 * 门禁会拦住「引用了清单里没有的权限点」与「路由没有声明权限点」两种情况。
 */

/** 权限点的作用域：instance = 需要实例级授权才能生效 */
export type PermissionScope = 'global' | 'instance'

/** 权限点的动作性质：read 用于菜单可见性，write 用于按钮与写操作拦截 */
export type PermissionAction = 'read' | 'write'

export interface PermissionSpec {
  /** 权限点字符串，例如 `instance:lifecycle` */
  key: string
  /** 中文名，角色管理页的勾选框直接显示它 */
  label: string
  /** 模块分组名，用于角色管理页的分组与「全选本模块」 */
  group: PermissionGroup
  action: PermissionAction
  scope: PermissionScope
  /** 一句话说明：这个权限点允许对方做什么（界面上的悬停说明与文档都取自它） */
  summary: string
}

/** 模块分组。顺序即角色管理页的展示顺序 */
export const PERMISSION_GROUPS = [
  '监控',
  '实例',
  '控制台',
  '房间',
  '世界',
  '玩家',
  'Mod',
  '文件',
  '备份',
  '计划任务',
  '系统',
  '成员与角色',
] as const

export type PermissionGroup = typeof PERMISSION_GROUPS[number]

export const PERMISSION_SPECS: readonly PermissionSpec[] = [
  // ── 监控 ────────────────────────────────────────────────────────────────
  {
    key: 'console.monitor:read',
    label: '监控台',
    group: '监控',
    action: 'read',
    scope: 'global',
    summary: '查看主机 CPU / 内存 / 磁盘 / 网络与运行环境信息',
  },

  // ── 实例 ────────────────────────────────────────────────────────────────
  {
    key: 'instance:read',
    label: '查看实例',
    group: '实例',
    action: 'read',
    scope: 'global',
    summary: '查看实例列表与详情；列表内容按该账号被授权的实例范围过滤',
  },
  {
    key: 'instance:create',
    label: '创建实例',
    group: '实例',
    action: 'write',
    scope: 'global',
    summary: '创建新实例并安装游戏服务端',
  },
  {
    key: 'instance:delete',
    label: '删除实例',
    group: '实例',
    action: 'write',
    scope: 'instance',
    summary: '删除实例（会先自动停止运行中的实例并备份存档）',
  },
  {
    key: 'instance:lifecycle',
    label: '启停与重启',
    group: '实例',
    action: 'write',
    scope: 'instance',
    summary: '启动、停止、重启实例',
  },
  {
    key: 'instance:update',
    label: '更新游戏版本',
    group: '实例',
    action: 'write',
    scope: 'instance',
    summary: '检查并安装游戏服务端更新',
  },
  {
    key: 'instance:ports',
    label: '分配端口',
    group: '实例',
    action: 'write',
    scope: 'instance',
    summary: '修改实例的端口分配',
  },
  {
    key: 'instance.install-log:read',
    label: '安装进度与日志',
    group: '实例',
    action: 'read',
    scope: 'instance',
    summary: '查看实例的安装进度与安装日志',
  },
  {
    key: 'instance.migration:read',
    label: '查看迁移报告',
    group: '实例',
    action: 'read',
    scope: 'instance',
    summary: '检查实例的迁移体检报告（分片端口、Mod 清单、风险项）',
  },
  {
    key: 'instance.migration:export',
    label: '导出迁移包',
    group: '实例',
    action: 'write',
    scope: 'instance',
    summary: '导出可导入其他面板的迁移包',
  },

  // ── 控制台 ──────────────────────────────────────────────────────────────
  {
    key: 'instance.console:read',
    label: '查看控制台',
    group: '控制台',
    action: 'read',
    scope: 'instance',
    summary: '查看实例控制台的实时日志与历史日志',
  },
  {
    key: 'console:clear',
    label: '清空日志',
    group: '控制台',
    action: 'write',
    scope: 'instance',
    summary: '清空实例的控制台日志',
  },
  {
    key: 'console:command',
    label: '下发命令',
    group: '控制台',
    action: 'write',
    scope: 'instance',
    summary: '向游戏控制台下发命令',
  },
  {
    key: 'maintenance:write',
    label: '维护公告',
    group: '控制台',
    action: 'write',
    scope: 'instance',
    summary: '编辑并推送维护公告',
  },

  // ── 房间 ────────────────────────────────────────────────────────────────
  {
    key: 'room:read',
    label: '查看房间配置',
    group: '房间',
    action: 'read',
    scope: 'instance',
    summary: '查看房间设置与在线玩家',
  },
  {
    key: 'room:write',
    label: '修改房间配置',
    group: '房间',
    action: 'write',
    scope: 'instance',
    summary: '修改房间名、密码、人数、游戏模式等房间配置',
  },

  // ── 世界 ────────────────────────────────────────────────────────────────
  {
    key: 'world:read',
    label: '查看世界配置',
    group: '世界',
    action: 'read',
    scope: 'instance',
    summary: '查看世界规则、分片配置与存档点',
  },
  {
    key: 'world:write',
    label: '修改世界配置',
    group: '世界',
    action: 'write',
    scope: 'instance',
    summary: '修改世界规则与地图生成参数、初始化洞穴',
  },
  {
    key: 'world:rollback',
    label: '回档',
    group: '世界',
    action: 'write',
    scope: 'instance',
    summary: '把世界回档到某个存档点（回档前自动备份）',
  },
  {
    key: 'world:reset',
    label: '重置世界',
    group: '世界',
    action: 'write',
    scope: 'instance',
    summary: '重置世界并重新生成（重置前自动备份）',
  },
  {
    key: 'world.map:read',
    label: '查看地形图',
    group: '世界',
    action: 'read',
    scope: 'instance',
    summary: '查看已生成世界的地形图与图例',
  },
  {
    key: 'world.map:generate',
    label: '生成地形图',
    group: '世界',
    action: 'write',
    scope: 'instance',
    summary: '向运行中的世界下发导出命令并生成地形图',
  },

  // ── 玩家 ────────────────────────────────────────────────────────────────
  {
    key: 'player:read',
    label: '查看玩家',
    group: '玩家',
    action: 'read',
    scope: 'instance',
    summary: '查看在线玩家、玩家档案与三份名单',
  },
  {
    key: 'player:write',
    label: '编辑玩家名单',
    group: '玩家',
    action: 'write',
    scope: 'instance',
    summary: '编辑管理员、白名单与黑名单',
  },
  {
    key: 'player:kick',
    label: '踢出玩家',
    group: '玩家',
    action: 'write',
    scope: 'instance',
    summary: '把玩家踢出当前房间',
  },
  {
    key: 'player:ban',
    label: '封禁玩家',
    group: '玩家',
    action: 'write',
    scope: 'instance',
    summary: '封禁玩家（写入黑名单并立刻踢下线）',
  },
  {
    key: 'player.profile:write',
    label: '编辑玩家备注',
    group: '玩家',
    action: 'write',
    scope: 'instance',
    summary: '同步玩家档案并编辑备注',
  },

  // ── Mod ─────────────────────────────────────────────────────────────────
  {
    key: 'mod:read',
    label: '查看 Mod',
    group: 'Mod',
    action: 'read',
    scope: 'instance',
    summary: '查看已订阅 Mod、Mod 市场与单个 Mod 的配置',
  },
  {
    key: 'mod:install',
    label: '订阅与卸载 Mod',
    group: 'Mod',
    action: 'write',
    scope: 'instance',
    summary: '从创意工坊订阅、下载与卸载 Mod',
  },
  {
    key: 'mod:toggle',
    label: '启停与排序 Mod',
    group: 'Mod',
    action: 'write',
    scope: 'instance',
    summary: '启用或禁用 Mod、调整加载顺序',
  },
  {
    key: 'mod:config',
    label: '修改 Mod 配置',
    group: 'Mod',
    action: 'write',
    scope: 'instance',
    summary: '修改单个 Mod 的配置项',
  },

  // ── 文件 ────────────────────────────────────────────────────────────────
  {
    key: 'file:read',
    label: '浏览文件',
    group: '文件',
    action: 'read',
    scope: 'instance',
    summary: '浏览实例目录、查看文本文件内容',
  },
  {
    key: 'file:write',
    label: '编辑文件',
    group: '文件',
    action: 'write',
    scope: 'instance',
    summary: '编辑文本文件、新建文件、重命名（写前自动备份）',
  },
  {
    key: 'file:delete',
    label: '删除文件',
    group: '文件',
    action: 'write',
    scope: 'instance',
    summary: '删除实例目录内的文件',
  },
  {
    key: 'file:upload',
    label: '上传文件',
    group: '文件',
    action: 'write',
    scope: 'instance',
    summary: '上传文件到实例目录（覆盖前自动备份）',
  },
  {
    key: 'file:download',
    label: '下载文件',
    group: '文件',
    action: 'write',
    scope: 'instance',
    summary: '从实例目录下载文件',
  },

  // ── 备份 ────────────────────────────────────────────────────────────────
  {
    key: 'backup:read',
    label: '查看备份',
    group: '备份',
    action: 'read',
    scope: 'instance',
    summary: '查看存档备份列表与面板数据库快照',
  },
  {
    key: 'backup:create',
    label: '创建备份',
    group: '备份',
    action: 'write',
    scope: 'instance',
    summary: '手动创建存档备份或面板数据库快照',
  },
  {
    key: 'backup:delete',
    label: '删除备份',
    group: '备份',
    action: 'write',
    scope: 'instance',
    summary: '删除存档备份或面板数据库快照',
  },
  {
    key: 'backup:restore',
    label: '恢复备份',
    group: '备份',
    action: 'write',
    scope: 'instance',
    summary: '从存档备份恢复，或把面板数据库快照恢复回面板',
  },
  {
    key: 'backup:import',
    label: '导入存档',
    group: '备份',
    action: 'write',
    scope: 'instance',
    summary: '导入外部存档包或外部面板数据库快照',
  },

  // ── 计划任务 ────────────────────────────────────────────────────────────
  {
    key: 'schedule:read',
    label: '查看计划任务',
    group: '计划任务',
    action: 'read',
    scope: 'global',
    summary: '查看定时任务列表与执行记录；列表按被授权的实例范围过滤',
  },
  {
    key: 'schedule:write',
    label: '编辑计划任务',
    group: '计划任务',
    action: 'write',
    scope: 'instance',
    summary: '新建、修改、删除与立即执行定时任务',
  },

  // ── 系统 ────────────────────────────────────────────────────────────────
  {
    key: 'settings:read',
    label: '查看面板设置',
    group: '系统',
    action: 'read',
    scope: 'global',
    summary: '查看面板设置、环境自检、版本与更新状态、通知渠道',
  },
  {
    key: 'settings:write',
    label: '修改面板设置',
    group: '系统',
    action: 'write',
    scope: 'global',
    summary: '修改面板设置、安装 SteamCMD、检查与安装面板更新、配置通知渠道',
  },
  {
    key: 'audit:read',
    label: '查看操作记录',
    group: '系统',
    action: 'read',
    scope: 'global',
    summary: '查看谁在什么时候改了什么（含被拒绝的写操作）',
  },
  {
    key: 'plugin:read',
    label: '查看插件',
    group: '系统',
    action: 'read',
    scope: 'global',
    summary: '查看插件列表、状态与插件调用记录',
  },
  {
    key: 'plugin:manage',
    label: '管理插件',
    group: '系统',
    action: 'write',
    scope: 'global',
    summary: '启用、停用与导入插件（危险能力的插件会先要求确认）',
  },
  {
    key: 'license:read',
    label: '查看版本与授权',
    group: '系统',
    action: 'read',
    scope: 'global',
    summary: '查看版本形态、许可状态与可选付费服务说明',
  },

  // ── 成员与角色 ──────────────────────────────────────────────────────────
  {
    key: 'member:read',
    label: '查看成员',
    group: '成员与角色',
    action: 'read',
    scope: 'global',
    summary: '查看成员列表、角色与实例授权情况',
  },
  {
    key: 'member:write',
    label: '管理成员',
    group: '成员与角色',
    action: 'write',
    scope: 'global',
    summary: '创建子账号、停用启用、重置密码、分配角色与实例授权',
  },
  {
    key: 'role:read',
    label: '查看角色',
    group: '成员与角色',
    action: 'read',
    scope: 'global',
    summary: '查看角色列表与每个角色拥有的权限点',
  },
  {
    key: 'role:write',
    label: '管理角色',
    group: '成员与角色',
    action: 'write',
    scope: 'global',
    summary: '新建、修改、删除角色与其权限点',
  },
]

/** 全部权限点字符串，顺序即展示顺序 */
export const ALL_PERMISSIONS: readonly string[] = PERMISSION_SPECS.map(spec => spec.key)

const SPEC_BY_KEY = new Map(PERMISSION_SPECS.map(spec => [spec.key, spec]))

export function findPermissionSpec(key: string): PermissionSpec | undefined {
  return SPEC_BY_KEY.get(key)
}

export function isKnownPermission(key: string): boolean {
  return SPEC_BY_KEY.has(key)
}

/** 中文名；未登记的权限点原样返回，避免界面出现空白 */
export function permissionLabel(key: string): string {
  return SPEC_BY_KEY.get(key)?.label ?? key
}

/** 只读权限点（全部 read）。「只读角色」用得上，也是游客角色的基线 */
export const READ_ONLY_PERMISSIONS: readonly string[] = PERMISSION_SPECS
  .filter(spec => spec.action === 'read')
  .map(spec => spec.key)

/** 需要实例授权的权限点 */
export const INSTANCE_SCOPED_PERMISSIONS: readonly string[] = PERMISSION_SPECS
  .filter(spec => spec.scope === 'instance')
  .map(spec => spec.key)

// ── 兼容别名 ─────────────────────────────────────────────────────────────
/**
 * 旧体系（v0.9.x 及更早）的 5 个权限点。
 *
 * **保留原因**：存量部署的 `user_permissions` 里就是这些字符串，删掉会让老账号失去权限；
 * 且 `home-capabilities.ts` 等位置仍在引用。迁移到细粒度体系后它们不再被服务端鉴权使用，
 * 但**不要删除**——迁移函数（`server/src/shared/db/rbac-migration.ts`）正是靠它们识别老账号。
 *
 * 新的代码不要再引用这几个常量，改用上面 `PERMISSION_SPECS` 里的权限点。
 */
/** @deprecated 用 `instance:read` / `instance:lifecycle` 等细粒度权限点代替 */
export const NODE_INSTANCE_MANAGE_PERMISSION = 'pages.node.instance:manage'
/** @deprecated 用 `settings:read` / `license:read` / `plugin:read` 代替 */
export const SYSTEM_READ_PERMISSION = 'system:read'
/** @deprecated 用 `settings:write` / `plugin:manage` 代替 */
export const SYSTEM_MANAGE_PERMISSION = 'system:manage'
/** @deprecated 用 `backup:read` / `schedule:read` 代替 */
export const OPS_READ_PERMISSION = 'ops:read'
/** @deprecated 用 `backup:create` / `schedule:write` 等代替 */
export const OPS_MANAGE_PERMISSION = 'ops:manage'

/** 框架遗留权限点（母仓 fantastic-admin 的示例页），本项目没有对应页面，仅作登记 */
export const LEGACY_FRAMEWORK_PERMISSIONS: readonly string[] = [
  'pages.general:browse',
  'pages.form:browse',
  'pages.list:browse',
  'pages.shop:browse',
]
