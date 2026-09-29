import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { GUEST_ROLE_PERMISSIONS } from '../../../../shared/constants/permissions'
import { loadServerConfig } from '../config'
import { ensureDb, hashPassword, nowIso } from './connection'
import { GUEST_ROLE_KEY } from './rbac-migration'
import {
  addUserInstanceGrants,
  createUserRecord,
  findRoleKindByUserId,
  findUserIdByAccount,
  listAllInstanceIds,
  listGrantedInstanceIds,
  listRolePermissions,
  replaceUserPermissions,
  setUserRole,
} from './rbac-repository'
import { roles, systemSettings, userRoles, users } from './schema/index'

/**
 * 游客（只读预览）账号的服务端预置。
 *
 * ## 为什么游客账号不能靠"管理员手动建 + 把口令写进前端"
 *
 * 需求原话是"点击游客登录自动填充账号密码"。那条路只有三种实现，每一种都不成立：
 *
 * 1. 口令写进前端常量 / `VITE_*`：`dist/` 是公开静态资源，口令等于印在页面上，
 *    而且拿到后绕开按钮直接调 `/app/account/login` 就能登；
 * 2. 口令写在仓库里（README / 环境变量）：一旦公开，它就成了撞库字典的一行；
 * 3. 口令由接口返回给前端去"填充"：等于多开一个匿名口令接口，效果与 1 相同。
 *
 * 所以这里的做法是**取消口令这个概念**：面板自己在启动时按配置的账号名建一个
 * 游客账号，口令是一个当场生成、随即丢弃的随机值——它**从不返回、从不落盘、从不打日志**，
 * 因此 `/app/account/login` 对游客账号永远登不上。免密入口是独立的
 * `POST /app/account/guest-login`，由服务端直接签发游客角色的会话（见 `modules/auth/index.ts`）。
 *
 * ## 为什么需要 `system_settings` 里的指针
 *
 * 支持改账号名（`GSH_GUEST_LOGIN_ACCOUNT`）。改名后旧账号仍在库里，不能凭名字猜
 * "哪个才是面板的游客账号"——所以签发会话前要能**只按指针**找到它：
 * 指针指向的账号还必须真的是游客角色，否则视为未就绪（不泄露账号状态细节）。
 */

/** 指针键：面板预置的游客账号 userId */
const GUEST_ACCOUNT_KEY = 'guest.account'

export interface GuestAccountOutcome {
  /** 配置的游客账号名 */
  account: string
  /** 本次启动是否新建了账号 */
  created: boolean
  /** 本次启动是否修正了指针（账号被改名或被删后重建） */
  repaired: boolean
  /** 指针是否存在且指向一个启用中的游客角色账号 */
  ready: boolean
  /** 本次启动补了多少条实例授权 */
  grantsAdded: number
}

async function readGuestAccountId(): Promise<string | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, GUEST_ACCOUNT_KEY))
    .limit(1)
  const value = rows[0]?.value?.trim()
  return value ? value : undefined
}

async function writeGuestAccountId(userId: string): Promise<void> {
  const { drizzleDb } = ensureDb()
  const now = nowIso()
  await drizzleDb
    .insert(systemSettings)
    .values({ key: GUEST_ACCOUNT_KEY, value: userId, updatedAt: now })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: userId, updatedAt: now },
    })
}

async function findGuestRoleId(): Promise<string | undefined> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.key, GUEST_ROLE_KEY))
    .limit(1)
  return rows[0]?.id
}

/** 指针指向的账号是否真的是"启用中的游客角色账号" */
async function isUsableGuestAccount(userId: string): Promise<boolean> {
  const { drizzleDb } = ensureDb()
  const rows = await drizzleDb
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!rows[0] || rows[0].status !== 1) {
    return false
  }
  return await findRoleKindByUserId(userId) === 'guest'
}

/**
 * 幂等地补上"现有全部实例"的游客授权。
 *
 * 为什么在启动时补而不是在请求里补：请求期读写授权表会让"读接口"产生写副作用，
 * 而且并发签发会话时会打架。代价是**新建实例后要重启面板（或重启过一次）游客才看得到它**，
 * 这一点写在 `docs/INSTALL.md` 的游客登录一节里。
 */
async function syncGuestInstanceGrants(userId: string): Promise<number> {
  const allInstanceIds = await listAllInstanceIds()
  if (allInstanceIds.length === 0) {
    return 0
  }
  const granted = new Set(await listGrantedInstanceIds(userId))
  const missing = allInstanceIds.filter(id => !granted.has(id))
  if (missing.length === 0) {
    return 0
  }
  await addUserInstanceGrants(userId, missing, null)
  return missing.length
}

/**
 * 保证游客账号存在、是游客角色、且能看见全部实例。幂等。
 *
 * 调用点只有一个：`initDatabase` 的末尾，且必须排在 `syncGuestRolePermissions()` 之后
 * （游客角色是在那一步建出来/刷新好的）。`enabled` 为 false 时直接返回，
 * 因此默认部署不会凭空多出一个账号。
 */
export async function ensureGuestAccount(options: {
  enabled: boolean
  account: string
}): Promise<GuestAccountOutcome | null> {
  if (!options.enabled) {
    return null
  }
  const account = options.account.trim()
  const outcome: GuestAccountOutcome = {
    account,
    created: false,
    repaired: false,
    ready: false,
    grantsAdded: 0,
  }

  const guestRoleId = await findGuestRoleId()
  if (!guestRoleId) {
    // 游客角色由每次启动的 `syncGuestRolePermissions()` 保证存在；到这里还没有只能说明有更严重的问题
    return { ...outcome, ready: false }
  }

  let userId = await readGuestAccountId()
  if (userId && !await isUsableGuestAccount(userId)) {
    // 指针指向的账号被删了、停用了，或被改成了别的角色：不修它的角色（那是管理员的选择），
    // 直接按配置的账号名重新找一个/建一个，并把指针搬过去。
    userId = undefined
    outcome.repaired = true
  }

  if (!userId) {
    const existingId = await findUserIdByAccount(account)
    if (existingId) {
      /**
       * 同名账号**只有已经是游客角色**时才接管。
       *
       * 这一点不是洁癖：`GSH_GUEST_LOGIN_ACCOUNT` 默认是 `guest`，如果运维手上正好有一个
       * 同名的真实账号，无条件接管会**把它的角色和权限点全部改写**——它原本是什么角色、
       * 能管哪些实例，都会变成"只能看"，而且是在一次重启里静默发生的。
       * 接管一个本来就是游客角色的账号则没有任何损失（它本来就是那个用途）。
       *
       * 名字被别的角色占着时什么都不做：不覆盖它，也不把它当游客账号用。
       * 调用方会把 ready=false 写进启动日志，部署者看到后改 `GSH_GUEST_LOGIN_ACCOUNT` 即可。
       */
      if (await findRoleKindByUserId(existingId) !== 'guest') {
        return { ...outcome, ready: false }
      }
      userId = existingId
      outcome.repaired = true
    }
  }

  if (!userId) {
    userId = randomUUID()
    /**
     * 口令是当场生成并**立刻丢弃**的随机值。
     *
     * 这不是"占位符"——它必须不可知：`/app/account/login` 会用它做校验，
     * 只要没人知道它，游客账号就只能通过 `guest-login` 进入。
     * 也刻意不写进任何日志与返回值。
     */
    await createUserRecord({
      id: userId,
      account,
      passwordHash: hashPassword(`${randomUUID()}${randomUUID()}`),
      email: `${account}@guest.local`,
      avatar: 'https://api.dicebear.com/9.x/bottts-neutral/svg?seed=guest',
      status: 1,
      // 游客不该被"首次登录须改密"拦住：它没有可改的口令，而且拦下来就进不了预览
      mustChangePassword: false,
    })
    outcome.created = true
  }

  // 角色与权限点每次启动都对一遍：管理员误把游客角色换掉/停用后，下次启动会恢复成"可预览"
  await setUserRole(userId, guestRoleId)
  await replaceUserPermissions(userId, GUEST_ROLE_PERMISSIONS.length > 0
    ? GUEST_ROLE_PERMISSIONS
    : await listRolePermissions(guestRoleId))
  await writeGuestAccountId(userId)

  outcome.grantsAdded = await syncGuestInstanceGrants(userId)
  outcome.ready = true
  return outcome
}

/**
 * 本次请求要签发的游客账号 ID。
 *
 * **只认指针，不认账号名**：账号名可以被改成任何东西（包括与别的账号重名的历史数据），
 * 按名字找等于"谁叫这个名字谁就是游客"——而签发的会话属于那个账号。
 * 找不到、或指针指向的账号已不是启用中的游客角色时返回 undefined，调用方一律回
 * 同一句"游客账号未就绪"，不区分原因。
 */
export async function resolveGuestAccountId(): Promise<string | undefined> {
  const userId = await readGuestAccountId()
  if (!userId) {
    return undefined
  }
  return await isUsableGuestAccount(userId) ? userId : undefined
}

/** 判断某个账号名是不是配置里的游客账号名（成员管理侧误配保护用） */
export function isConfiguredGuestAccountName(account: string): boolean {
  return account.trim() === loadServerConfig().guestLoginAccount
}

/**
 * 持有游客角色、但**不是**配置里那个游客账号的账号。
 *
 * 为什么要在启动时报出来：把某个真实运维账号改成游客角色，表现是"他一登录就只能看、
 * 什么按钮都没有"——看起来像面板坏了，而原因在成员管理里，且没有任何报错。
 * 这里的守卫（`rbac-service.ts` 的 `assertGuestRoleAssignable`）已经拦住了新的误配，
 * 这段只负责把**历史上已经配错的**翻出来提醒。
 */
export async function listMisassignedGuestRoleMembers(): Promise<string[]> {
  const { drizzleDb } = ensureDb()
  const guestRoleId = await findGuestRoleId()
  if (!guestRoleId) {
    return []
  }
  const rows = await drizzleDb
    .select({ account: users.account })
    .from(userRoles)
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(eq(userRoles.roleId, guestRoleId))
  const configured = loadServerConfig().guestLoginAccount
  return rows
    .map(row => row.account)
    .filter(account => account !== configured)
    .sort()
}
