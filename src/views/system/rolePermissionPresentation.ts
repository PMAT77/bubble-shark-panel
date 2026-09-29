import type { PermissionGroup, PermissionKey, PermissionSpec } from '../../../shared/constants/permissions'
import {
  ALL_PERMISSIONS,
  GUEST_ROLE_PERMISSIONS,
  isKnownPermission,
  PERMISSION_GROUPS,
  PERMISSION_SPECS,
} from '../../../shared/constants/permissions'

/**
 * 角色权限选择器的展示逻辑（纯函数，无 Vue 依赖）。
 *
 * 为什么单独抽出来：权限区要回答的问题不止「勾了哪几个」——还要给出每组的已选计数与三态、
 * 搜索命中、以及「勾了写权限却没勾查看权限」这类会让权限**实际不生效**的组合。
 * 这些判断放在组件里就只能靠肉眼看，抽成纯函数才能被单测钉住。
 *
 * 三条边界：
 * 1. 权限点清单的唯一真源仍是 `shared/constants/permissions.ts`，这里只读它，不另立一份；
 * 2. 本文件里的模块说明、起点模板与危险标记都是**界面文案与勾选起点**，不参与任何鉴权；
 * 3. `selected` 里的未知权限点一律忽略（不显示、不计数），与服务端 `validatePermissions` 一致。
 */

// ── 模块说明 ──────────────────────────────────────────────────────────────

/**
 * 每个模块一句话：这一组管什么。
 *
 * 用 `Record<PermissionGroup, string>` 而不是数组，是为了在新增模块分组时**编译期**报错——
 * 漏写一条说明会让角色弹窗出现一个只有标题、没有解释的分组。
 */
export const PERMISSION_GROUP_HINTS: Record<PermissionGroup, string> = {
  '监控': '看面板所在主机的运行状态：CPU、内存、磁盘与网络。',
  '实例': '能不能看到实例，以及创建、删除、更新版本与分配端口。',
  '控制台': '实时日志与历史日志、清空日志、下发命令与维护公告。',
  '房间': '房间名、密码、人数、游戏模式这些开局设定。',
  '世界': '世界规则与地形图，以及回档、重置这两个「重来」的操作。',
  '玩家': '在线玩家与档案，以及踢人、封禁、名单与备注。',
  'Mod': '订阅、启停、排序与单个 Mod 的配置。',
  '文件': '浏览、编辑、上传、下载与删除实例目录里的文件。',
  '备份': '创建、恢复、导入与删除存档备份。',
  '计划任务': '定时重启、定时备份这类自动执行的任务。',
  '系统': '面板设置、通知渠道、操作记录、插件与版本授权。',
  '成员': '面板账号本身：建号、停用、重置密码、分配角色与实例。',
  '角色': '角色与每个角色拥有的权限点。',
}

// ── 危险权限 ──────────────────────────────────────────────────────────────

/**
 * 会「弄坏东西」或「放权」的权限点，界面上单独标记。
 *
 * 判据沿用插件模块对危险能力的定义（影响线上运行 / 不可逆 / 能把权限交出去，
 * 见 `shared/contracts/plugin.ts` 的 `DANGEROUS_PLUGIN_CAPABILITIES`）：
 * 这里不把 `instance:lifecycle`、`player:kick`、`console:command` 算进来——
 * 它们是日常运维动作，标红了反而让真正危险的那几个失去信号，它们的说明里已写明影响。
 */
export const DANGEROUS_PERMISSION_KEYS = [
  'instance:delete',
  'world:reset',
  'world:rollback',
  'player:ban',
  'file:delete',
  'backup:delete',
  'backup:restore',
  'backup:import',
  'plugin:manage',
  'member:write',
  'role:write',
  'settings:write',
] as const satisfies readonly PermissionKey[]

const DANGEROUS_PERMISSION_SET: ReadonlySet<string> = new Set<string>(DANGEROUS_PERMISSION_KEYS)

export function isDangerousPermission(key: string): boolean {
  return DANGEROUS_PERMISSION_SET.has(key)
}

// ── 起点模板 ──────────────────────────────────────────────────────────────

export interface PermissionPreset {
  key: 'readonly' | 'ops' | 'full'
  label: string
  description: string
  permissions: readonly PermissionKey[]
}

/**
 * 「日常运维」的权限集合：**有意保守**。
 *
 * 不含删实例、删文件、封禁、回档、重置世界、改面板设置、管账号——这些都是「出事很难回头」
 * 或「能顺手把权限发出去」的动作，想要的人可以自己再勾。
 *
 * 新增权限点后要人工决定是否纳入这里（单测会拦住写错的权限点名，但不会替你判断该不该加）。
 */
const OPS_PERMISSIONS = [
  'console.monitor:read',
  'instance:read',
  'instance:lifecycle',
  'instance:update',
  'instance.install-log:read',
  'instance.migration:read',
  'instance.migration:export',
  'instance.console:read',
  'console:command',
  'maintenance:write',
  'room:read',
  'room:write',
  'world:read',
  'world.map:read',
  'world.map:generate',
  'player:read',
  'player:write',
  'player:kick',
  'player.profile:write',
  'mod:read',
  'mod:install',
  'mod:toggle',
  'mod:config',
  'file:read',
  'backup:read',
  'backup:create',
  'backup:restore',
  'schedule:read',
  'schedule:write',
] as const satisfies readonly PermissionKey[]

/**
 * 三个起点，顺序即展示顺序。
 *
 * 「只读看板」直接复用 `GUEST_ROLE_PERMISSIONS`、「完全管理」复用 `ALL_PERMISSIONS`：
 * 这两份清单本来就由权限点真源派生，另写一份只会漂移（单测钉住它们相等）。
 */
export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  {
    key: 'readonly',
    label: '只读看板',
    description: '能看监控、实例、房间、世界、玩家、Mod、备份与计划任务；不能做任何操作，也看不到成员与角色管理。',
    permissions: GUEST_ROLE_PERMISSIONS,
  },
  {
    key: 'ops',
    label: '日常运维',
    description: '开关与更新实例、看日志、管房间与玩家名单、建备份；不能删实例、不能改面板设置、不能管账号。',
    permissions: OPS_PERMISSIONS,
  },
  {
    key: 'full',
    label: '完全管理',
    description: '开关与更新实例、改房间与世界、管玩家、Mod 与文件、备份与计划任务，还能建账号、配角色、改面板设置；没有限制。',
    permissions: ALL_PERMISSIONS,
  },
]

/** 当前勾选是否正好等于某个起点模板（用于卡片高亮） */
export function isPresetApplied(selected: readonly string[], preset: PermissionPreset): boolean {
  const current = normalizedSelection(selected)
  if (current.size !== preset.permissions.length) {
    return false
  }
  return preset.permissions.every(key => current.has(key))
}

// ── 分组视图 ──────────────────────────────────────────────────────────────

export interface PermissionItemView {
  key: PermissionKey
  label: string
  summary: string
  dangerous: boolean
  checked: boolean
}

export interface PermissionGroupView {
  group: PermissionGroup
  /** 这一组管什么（一句话） */
  hint: string
  /** 搜索过滤后的条目；未搜索时是该组全部 */
  items: PermissionItemView[]
  /** 已选数量与总数都按**该组全部**权限点算，不受搜索影响 */
  selectedCount: number
  total: number
  allSelected: boolean
  partiallySelected: boolean
  /** 勾了写权限但一个查看权限都没勾：成员进不去这个页面，勾了也用不上 */
  needsReadHint: boolean
}

export interface PermissionSelectionSummary {
  selected: number
  total: number
}

/** `PERMISSION_SPECS` 的元素类型：`key` 是字面量联合，视图要拿它当 `PermissionKey` 用 */
type KnownPermissionSpec = typeof PERMISSION_SPECS[number]

const SPECS_BY_GROUP: ReadonlyMap<PermissionGroup, readonly KnownPermissionSpec[]> = (() => {
  const map = new Map<PermissionGroup, KnownPermissionSpec[]>()
  for (const group of PERMISSION_GROUPS) {
    map.set(group, [])
  }
  for (const spec of PERMISSION_SPECS) {
    map.get(spec.group)?.push(spec)
  }
  return map
})()

/** 只保留清单里存在的权限点 */
export function normalizedSelection(selected: readonly string[]): Set<PermissionKey> {
  const result = new Set<PermissionKey>()
  for (const key of selected) {
    if (isKnownPermission(key)) {
      result.add(key)
    }
  }
  return result
}

// ── 菜单要求：read 权限 → 侧边栏入口 ───────────────────────────────────────

/**
 * 一个主导航模块要出现，需要哪些权限点。
 *
 * 这份表是**分组提示文案**的唯一真源，与 `server/src/shared/menu-routes.ts` 的 `auth`
 * 逐条对应（`rolePermissionPresentation.test.ts` 会比对两者，漂移立刻失败）。
 * 这里不直接 import 服务端菜单，是为了不让服务端模块进入前端包。
 *
 * 只有一个 `anyOf`（菜单的 `auth` 就是这个语义）：**一个菜单项只由它自己的读权限决定**。
 * 页面需要的跨模块数据不写进这里——那是接口的事（按页面自己的权限放行、只回本页字段），
 * 否则会出现「取消『查看实例』把七个菜单一起收走」这种耦合。
 */
export interface ModuleMenuRequirement {
  /** 侧边栏里的模块名，与 `menuRouteList` 的模块标题一致 */
  title: string
  /** 模块入口的 `auth`：任一满足即可 */
  anyOf: PermissionKey[]
  /**
   * 该模块暂时不在侧边栏里（`menu: false`，当前只有「插件」）。
   * 这类模块的权限点仍然可用（直接输地址进得去），所以提示里不把它算作入口。
   */
  hidden?: boolean
  /** 这个模块承载哪些权限组 */
  groups: PermissionGroup[]
}

export const MODULE_MENU_REQUIREMENTS: ModuleMenuRequirement[] = [
  { title: '监控台', anyOf: ['console.monitor:read'], groups: ['监控'] },
  // 实例详情、实例控制台与文件卡片都挂在「实例管理」下，所以控制台组与文件组也由它承载
  { title: '实例管理', anyOf: ['instance:read'], groups: ['实例', '控制台', '文件'] },
  { title: '房间管理', anyOf: ['room:read'], groups: ['房间'] },
  { title: '世界管理', anyOf: ['world:read'], groups: ['世界'] },
  { title: '玩家管理', anyOf: ['player:read'], groups: ['玩家'] },
  { title: '模组管理', anyOf: ['mod:read'], groups: ['Mod'] },
  { title: '备份与恢复', anyOf: ['backup:read'], groups: ['备份'] },
  { title: '计划任务', anyOf: ['schedule:read'], groups: ['计划任务'] },
  // 插件页当前 `menu: false`：页面与接口都在，入口收起来了，提示里不当作一个入口
  { title: '插件', anyOf: ['plugin:read'], hidden: true, groups: ['系统'] },
  { title: '成员管理', anyOf: ['member:read'], groups: ['成员'] },
  { title: '角色管理', anyOf: ['role:read'], groups: ['角色'] },
  { title: '商业支持与 Pro', anyOf: ['license:read'], groups: ['系统'] },
  { title: '系统设置', anyOf: ['settings:read', 'audit:read'], groups: ['系统'] },
]

function matchesKeyword(spec: PermissionSpec, terms: readonly string[]): boolean {
  if (terms.length === 0) {
    return true
  }
  const haystack = `${spec.label}\n${spec.summary}\n${spec.key}\n${spec.group}`.toLowerCase()
  return terms.every(term => haystack.includes(term))
}

/**
 * 构建权限区分组视图。
 *
 * `keyword` 非空时只返回有命中的分组，且组内只保留命中的条目（组头计数仍是全量，避免
 * 「搜索后计数变小」被误读成权限丢了）。关键词按空格拆成多个词，词之间是「都要命中」，
 * 所以「踢 玩家」比「踢玩家」更容易搜到东西。
 */
export function buildPermissionGroupViews(selected: readonly string[], keyword = ''): PermissionGroupView[] {
  const current = normalizedSelection(selected)
  const terms = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const views: PermissionGroupView[] = []

  for (const group of PERMISSION_GROUPS) {
    const specs = SPECS_BY_GROUP.get(group) ?? []
    const matched = specs.filter(spec => matchesKeyword(spec, terms))
    if (matched.length === 0) {
      continue
    }

    const selectedSpecs = specs.filter(spec => current.has(spec.key))
    const selectedCount = selectedSpecs.length
    const total = specs.length
    const items: PermissionItemView[] = matched.map(spec => ({
      key: spec.key,
      label: spec.label,
      summary: spec.summary,
      dangerous: isDangerousPermission(spec.key),
      checked: current.has(spec.key),
    }))

    views.push({
      group,
      hint: PERMISSION_GROUP_HINTS[group],
      items,
      selectedCount,
      total,
      allSelected: total > 0 && selectedCount === total,
      partiallySelected: selectedCount > 0 && selectedCount < total,
      needsReadHint: selectedCount > 0
        && !selectedSpecs.some(spec => spec.action === 'read')
        && selectedSpecs.some(spec => spec.action === 'write'),
    })
  }

  return views
}

/** 底部摘要：已选几项 / 共几项 */
export function countSelection(selected: readonly string[]): PermissionSelectionSummary {
  return {
    selected: normalizedSelection(selected).size,
    total: PERMISSION_SPECS.length,
  }
}
