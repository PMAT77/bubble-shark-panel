import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { loadModeEnv } from './env-file'
import { resolveRepoRoot } from '../repo-root'

/** v0.2.0 起面板/DST/SteamCMD 共用的统一镜像引用（tag 随版本发布推进）。 */
export const UNIFIED_IMAGE_REF = 'ghcr.io/pmat77/game-server-hub:v0.10.1'

const envSchema = z.object({
  SERVER_HOST: z.string().trim().min(1).default('0.0.0.0'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8888),
  DB_PATH: z.string().trim().min(1).default('./data/game-server-hub.sqlite'),
  SERVER_LOG_DIR: z.string().trim().min(1).default('./logs'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  FORCE_PASSWORD_CHANGE: z.string().trim().optional(),
  ADMIN_USERNAME: z.string().trim().optional(),
  ADMIN_PASSWORD: z.string().optional(),
  DOCKER_HOST: z.string().trim().optional(),
  GSH_INSTANCES_ROOT: z.string().trim().optional(),
  GSH_BACKUPS_ROOT: z.string().trim().optional(),
  GSH_GAME_DST_IMAGE: z.string().trim().optional(),
  GSH_STEAMCMD_IMAGE: z.string().trim().optional(),
  /** 备选镜像 registry 候选（逗号分隔）；v0.2.0 起泛化自 GSH_STEAMCMD_IMAGE_MIRRORS */
  GSH_IMAGE_MIRRORS: z.string().trim().optional(),
  GSH_EDITION: z.string().trim().optional(),
  GSH_RUNTIME_MODE: z.enum(['docker', 'native']).default('docker'),
  GSH_NATIVE_RUNTIME_DIR: z.string().trim().optional(),
  GSH_NATIVE_STEAMCMD_PATH: z.string().trim().optional(),
  GSH_NATIVE_SYSTEMD_UNIT_DIR: z.string().trim().optional(),
  /** Native 面板内更新的请求/状态交换目录；由安装器写入 panel.env，Docker 模式不使用 */
  GSH_NATIVE_UPDATE_DIR: z.string().trim().optional(),
  PANEL_IMAGE: z.string().trim().optional(),
  /** 面板内一键更新时用的 updater 容器镜像（需自带 docker CLI + compose 插件）；留空自动挑选 */
  GSH_PANEL_UPDATER_IMAGE: z.string().trim().optional(),
  GSH_STACK_DIR: z.string().trim().optional(),
  GSH_COMPOSE_FILES: z.string().trim().optional(),
  GSH_PANEL_CONTAINER_NAME: z.string().trim().optional(),
  GSH_GITHUB_REPO: z.string().trim().optional(),
  /** 面板更新检查用的 GitHub API 基址；国内可指向兼容反代 */
  GSH_GITHUB_API_BASE: z.string().trim().optional(),
  /** GitHub 资源（Release 资产）加速代理前缀，如 https://gh-proxy.com/；留空走内置代理池 + 直连 */
  GSH_GITHUB_PROXY: z.string().trim().optional(),
  /** 面板更新下载源：auto=优先下载 Release 离线镜像包、失败回退 registry 拉取；offline=只用离线包；pull=只用 registry */
  GSH_PANEL_UPDATE_SOURCE: z.enum(['auto', 'offline', 'pull']).default('auto'),
  GSH_RELEASE_VERSION: z.string().trim().optional(),
  GSH_BUILD_SHA: z.string().trim().optional(),
  CORS_ORIGIN: z.string().trim().optional(),
  GSH_SYNC_ADMIN_PASSWORD_FROM_ENV: z.string().trim().optional(),
  GSH_PASSWORD_RECOVERY_TOKEN: z.string().trim().optional(),
  /** 可信反向代理列表（精确 IP 或 IPv4 CIDR，逗号分隔）；仅命中时才采信 X-Forwarded-For */
  GSH_TRUST_PROXY: z.string().trim().optional(),
  /** 实例安装路径策略：instances-root=必须位于 GSH_INSTANCES_ROOT 之下；any=允许任意绝对路径（自担风险） */
  GSH_INSTALL_PATH_POLICY: z.enum(['instances-root', 'any']).default('instances-root'),
  /** 游客（只读预览）免密登录开关；1 才启用，且只在 Native + production 下真正生效 */
  GSH_GUEST_LOGIN_ENABLED: z.string().trim().optional(),
  /** 游客账号名；面板启动时会按此名预置一个只读账号 */
  GSH_GUEST_LOGIN_ACCOUNT: z.string().trim().optional(),
})

function resolveMode() {
  const current = process.env.NODE_ENV
  if (current === 'test' || current === 'production') {
    return current
  }
  return 'development'
}

function getServerRootDir() {
  // 打包后模块位于 dist-server/，固定相对层级失效；统一由仓库根探测定位
  return resolveRepoRoot()
}

export interface ServerConfig {
  mode: 'development' | 'test' | 'production'
  host: string
  port: number
  dbPath: string
  logDir: string
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'
  envFile: string
  forcePasswordChange: boolean
  adminUsername: string
  adminPassword: string
  /** 生产环境未配置 ADMIN_PASSWORD 时自动生成 */
  adminPasswordGenerated: boolean
  dockerHost: string
  instancesRoot: string
  backupsRoot: string
  gameDstImage: string
  steamcmdImage: string
  /** 备选镜像 registry 候选（逗号分隔） */
  imageMirrors: string[]
  edition: string
  runtimeMode: 'docker' | 'native'
  nativeRuntimeDir: string
  nativeSteamcmdPath: string
  nativeSystemdUnitDir: string
  /** Native 面板内更新：面板在此目录写请求、读状态；Docker 模式为空目录占位 */
  nativeUpdateDir: string
  panelImage: string
  /** updater 容器镜像覆盖；空字符串表示自动挑选（目标镜像 → 当前面板镜像 → 官方 CLI 镜像） */
  panelUpdaterImage: string
  stackDir: string
  composeFiles: string[]
  panelContainerName: string
  githubRepo: string
  /** GitHub API 基址（检查面板更新）；默认 https://api.github.com */
  githubApiBase: string
  /** GitHub 资源加速代理前缀；为空时按内置候选池依次尝试后回退直连 */
  githubProxy: string
  panelUpdateSource: 'auto' | 'offline' | 'pull'
  releaseVersion: string
  buildSha: string
  syncAdminPasswordFromEnv: boolean
  passwordRecoveryToken: string
  /** 可信反向代理列表；空列表 = 永不信任 X-Forwarded-For */
  trustedProxies: string[]
  /** 实例安装路径策略 */
  installPathPolicy: 'instances-root' | 'any'
  /** Fastify @fastify/cors origin 选项；生产默认同源（false） */
  corsOrigin: boolean | string | string[]
  /**
   * 是否开放**游客（只读预览）免密登录**。
   *
   * 组合判定的结果，不是环境变量的原样透传：见 `resolveGuestLoginEnabled`。
   * 默认永远为 false——只有显式开开关、且 Native + production 时才为真。
   */
  guestLoginEnabled: boolean
  /**
   * 环境变量 `GSH_GUEST_LOGIN_ENABLED` 是否被显式打开（**不含**三道闸门的判定结果）。
   *
   * 单独留着只为一件事：`guestLoginEnabled` 为 false 时区分"没开"与"开了但被拒绝"。
   * 后者要在启动日志里给出原因，否则部署者看到的现象只是"登录页没有游客按钮"。
   */
  guestLoginRequested: boolean
  /** 游客账号名（`GSH_GUEST_LOGIN_ACCOUNT`，默认 `guest`），面板启动时按它预置只读账号 */
  guestLoginAccount: string
}

export function loadServerConfig(): ServerConfig {
  const mode = resolveMode()
  const serverRootDir = getServerRootDir()
  const env = loadModeEnv(serverRootDir, mode)
  const merged = {
    SERVER_HOST: process.env.SERVER_HOST ?? env.SERVER_HOST,
    SERVER_PORT: process.env.SERVER_PORT ?? env.SERVER_PORT,
    DB_PATH: process.env.DB_PATH ?? env.DB_PATH,
    SERVER_LOG_DIR: process.env.SERVER_LOG_DIR ?? env.SERVER_LOG_DIR,
    LOG_LEVEL: process.env.LOG_LEVEL ?? env.LOG_LEVEL,
    FORCE_PASSWORD_CHANGE: process.env.FORCE_PASSWORD_CHANGE ?? env.FORCE_PASSWORD_CHANGE,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME ?? env.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? env.ADMIN_PASSWORD,
    DOCKER_HOST: process.env.DOCKER_HOST ?? env.DOCKER_HOST,
    GSH_INSTANCES_ROOT: process.env.GSH_INSTANCES_ROOT ?? env.GSH_INSTANCES_ROOT,
    GSH_BACKUPS_ROOT: process.env.GSH_BACKUPS_ROOT ?? env.GSH_BACKUPS_ROOT,
    GSH_GAME_DST_IMAGE: process.env.GSH_GAME_DST_IMAGE ?? env.GSH_GAME_DST_IMAGE,
    GSH_STEAMCMD_IMAGE: process.env.GSH_STEAMCMD_IMAGE ?? env.GSH_STEAMCMD_IMAGE,
    // 备选镜像 registry 候选；旧变量 GSH_STEAMCMD_IMAGE_MIRRORS 保留兼容回退
    GSH_IMAGE_MIRRORS: process.env.GSH_IMAGE_MIRRORS ?? env.GSH_IMAGE_MIRRORS
      ?? process.env.GSH_STEAMCMD_IMAGE_MIRRORS ?? env.GSH_STEAMCMD_IMAGE_MIRRORS,
    GSH_EDITION: process.env.GSH_EDITION ?? env.GSH_EDITION,
    GSH_RUNTIME_MODE: process.env.GSH_RUNTIME_MODE ?? env.GSH_RUNTIME_MODE,
    GSH_NATIVE_RUNTIME_DIR: process.env.GSH_NATIVE_RUNTIME_DIR ?? env.GSH_NATIVE_RUNTIME_DIR,
    GSH_NATIVE_STEAMCMD_PATH: process.env.GSH_NATIVE_STEAMCMD_PATH ?? env.GSH_NATIVE_STEAMCMD_PATH,
    GSH_NATIVE_SYSTEMD_UNIT_DIR: process.env.GSH_NATIVE_SYSTEMD_UNIT_DIR ?? env.GSH_NATIVE_SYSTEMD_UNIT_DIR,
    GSH_NATIVE_UPDATE_DIR: process.env.GSH_NATIVE_UPDATE_DIR ?? env.GSH_NATIVE_UPDATE_DIR,
    PANEL_IMAGE: process.env.PANEL_IMAGE ?? env.PANEL_IMAGE,
    GSH_PANEL_UPDATER_IMAGE: process.env.GSH_PANEL_UPDATER_IMAGE ?? env.GSH_PANEL_UPDATER_IMAGE,
    GSH_STACK_DIR: process.env.GSH_STACK_DIR ?? env.GSH_STACK_DIR,
    GSH_COMPOSE_FILES: process.env.GSH_COMPOSE_FILES ?? env.GSH_COMPOSE_FILES,
    GSH_PANEL_CONTAINER_NAME: process.env.GSH_PANEL_CONTAINER_NAME ?? env.GSH_PANEL_CONTAINER_NAME,
    GSH_GITHUB_REPO: process.env.GSH_GITHUB_REPO ?? env.GSH_GITHUB_REPO,
    GSH_GITHUB_API_BASE: process.env.GSH_GITHUB_API_BASE ?? env.GSH_GITHUB_API_BASE,
    GSH_GITHUB_PROXY: process.env.GSH_GITHUB_PROXY ?? env.GSH_GITHUB_PROXY,
    GSH_PANEL_UPDATE_SOURCE: process.env.GSH_PANEL_UPDATE_SOURCE ?? env.GSH_PANEL_UPDATE_SOURCE,
    GSH_RELEASE_VERSION: process.env.GSH_RELEASE_VERSION ?? env.GSH_RELEASE_VERSION,
    GSH_BUILD_SHA: process.env.GSH_BUILD_SHA ?? env.GSH_BUILD_SHA,
    CORS_ORIGIN: process.env.CORS_ORIGIN ?? env.CORS_ORIGIN,
    GSH_SYNC_ADMIN_PASSWORD_FROM_ENV: process.env.GSH_SYNC_ADMIN_PASSWORD_FROM_ENV ?? env.GSH_SYNC_ADMIN_PASSWORD_FROM_ENV,
    GSH_PASSWORD_RECOVERY_TOKEN: process.env.GSH_PASSWORD_RECOVERY_TOKEN ?? env.GSH_PASSWORD_RECOVERY_TOKEN,
    GSH_TRUST_PROXY: process.env.GSH_TRUST_PROXY ?? env.GSH_TRUST_PROXY,
    GSH_INSTALL_PATH_POLICY: process.env.GSH_INSTALL_PATH_POLICY ?? env.GSH_INSTALL_PATH_POLICY,
    GSH_GUEST_LOGIN_ENABLED: process.env.GSH_GUEST_LOGIN_ENABLED ?? env.GSH_GUEST_LOGIN_ENABLED,
    GSH_GUEST_LOGIN_ACCOUNT: process.env.GSH_GUEST_LOGIN_ACCOUNT ?? env.GSH_GUEST_LOGIN_ACCOUNT,
  }
  const parsed = envSchema.parse(merged)
  const adminCredentials = resolveAdminCredentials(mode, parsed.ADMIN_USERNAME, parsed.ADMIN_PASSWORD)
  const defaultInstancesRoot = process.platform === 'win32'
    ? path.resolve(serverRootDir, 'data', 'instances')
    : '/var/lib/game-server-hub/instances'
  const defaultBackupsRoot = process.platform === 'win32'
    ? path.resolve(serverRootDir, 'data', 'backups')
    : '/var/lib/game-server-hub/backups'
  return {
    mode,
    host: parsed.SERVER_HOST,
    port: parsed.SERVER_PORT,
    dbPath: path.resolve(serverRootDir, parsed.DB_PATH),
    logDir: path.resolve(serverRootDir, parsed.SERVER_LOG_DIR),
    logLevel: parsed.LOG_LEVEL,
    envFile: path.resolve(serverRootDir, `.env.${mode}`),
    forcePasswordChange: isTruthyEnv(parsed.FORCE_PASSWORD_CHANGE),
    adminUsername: adminCredentials.username,
    adminPassword: adminCredentials.password,
    adminPasswordGenerated: adminCredentials.generated,
    dockerHost: parsed.DOCKER_HOST || (process.platform === 'win32'
      ? 'npipe:////./pipe/docker_engine'
      : 'unix:///var/run/docker.sock'),
    instancesRoot: path.resolve(parsed.GSH_INSTANCES_ROOT || defaultInstancesRoot),
    backupsRoot: path.resolve(parsed.GSH_BACKUPS_ROOT || defaultBackupsRoot),
    // v0.2.0 起面板/DST/SteamCMD 合并为同一统一镜像；三个引用默认一致，旧 env 显式设置时仍优先采用
    gameDstImage: parsed.GSH_GAME_DST_IMAGE || UNIFIED_IMAGE_REF,
    steamcmdImage: parsed.GSH_STEAMCMD_IMAGE || UNIFIED_IMAGE_REF,
    imageMirrors: (parsed.GSH_IMAGE_MIRRORS?.trim() || '')
      .split(',')
      .map(item => item.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''))
      .filter(Boolean),
    edition: parsed.GSH_EDITION || 'community',
    runtimeMode: parsed.GSH_RUNTIME_MODE,
    nativeRuntimeDir: path.resolve(parsed.GSH_NATIVE_RUNTIME_DIR || path.join(defaultInstancesRoot, '..', 'runtime')),
    nativeSteamcmdPath: path.resolve(parsed.GSH_NATIVE_STEAMCMD_PATH || '/opt/game-server-hub/runtime/steamcmd/steamcmd.sh'),
    nativeSystemdUnitDir: path.resolve(parsed.GSH_NATIVE_SYSTEMD_UNIT_DIR || path.join(os.homedir(), '.config/systemd/user')),
    nativeUpdateDir: path.resolve(parsed.GSH_NATIVE_UPDATE_DIR || path.join(defaultInstancesRoot, '..', 'panel-update')),
    panelImage: parsed.PANEL_IMAGE || UNIFIED_IMAGE_REF,
    panelUpdaterImage: parsed.GSH_PANEL_UPDATER_IMAGE?.trim() || '',
    stackDir: parsed.GSH_STACK_DIR?.trim() || '',
    composeFiles: (parsed.GSH_COMPOSE_FILES?.trim() || 'docker-compose.yml:docker-compose.bind.yml')
      .split(':')
      .map(item => item.trim())
      .filter(Boolean),
    panelContainerName: parsed.GSH_PANEL_CONTAINER_NAME?.trim() || 'game-server-hub-panel',
    githubRepo: parsed.GSH_GITHUB_REPO?.trim() || 'PMAT77/game-serve-hub',
    githubApiBase: parsed.GSH_GITHUB_API_BASE?.trim() || 'https://api.github.com',
    githubProxy: parsed.GSH_GITHUB_PROXY?.trim() || '',
    panelUpdateSource: parsed.GSH_PANEL_UPDATE_SOURCE,
    releaseVersion: parsed.GSH_RELEASE_VERSION?.trim() || '',
    buildSha: parsed.GSH_BUILD_SHA?.trim() || '',
    syncAdminPasswordFromEnv: isTruthyEnv(parsed.GSH_SYNC_ADMIN_PASSWORD_FROM_ENV),
    passwordRecoveryToken: parsed.GSH_PASSWORD_RECOVERY_TOKEN?.trim() || '',
    trustedProxies: (parsed.GSH_TRUST_PROXY?.trim() || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
    installPathPolicy: parsed.GSH_INSTALL_PATH_POLICY,
    corsOrigin: resolveCorsOrigin(mode, parsed.CORS_ORIGIN),
    guestLoginEnabled: resolveGuestLoginEnabled({
      requested: isTruthyEnv(parsed.GSH_GUEST_LOGIN_ENABLED),
      runtimeMode: parsed.GSH_RUNTIME_MODE,
      mode,
      account: parsed.GSH_GUEST_LOGIN_ACCOUNT,
      adminUsername: adminCredentials.username,
    }),
    guestLoginRequested: isTruthyEnv(parsed.GSH_GUEST_LOGIN_ENABLED),
    guestLoginAccount: parsed.GSH_GUEST_LOGIN_ACCOUNT?.trim() || DEFAULT_GUEST_LOGIN_ACCOUNT,
  }
}

/** 游客（只读预览）账号的默认名 */
export const DEFAULT_GUEST_LOGIN_ACCOUNT = 'guest'

/**
 * 是否真的开放游客免密登录。**只在三件事同时成立时为真。**
 *
 * 为什么不是"读一下环境变量就行"：`SECURITY.md` 早就写明游客角色有两条硬前提，
 * 其中第一条是**必须 Native 模式部署**——Docker 模式下面板挂着 `docker.sock`，
 * 对 Docker 守护进程 API 的访问等价于宿主机 root，**一次有效登录就等于 root**，
 * 而面板自身的权限体系不构成隔离层。游客登录会把"一次有效登录"免费送给任何匿名访客，
 * 所以它在 Docker 模式下不是"风险高一点"，而是"把宿主机交出去"，必须在代码里拒绝，
 * 而不是指望部署者记得去读文档。
 *
 * 三条闸门：
 * 1. 显式开开关（默认关闭，且重跑安装脚本升级时不会打开）；
 * 2. `native` 运行时；
 * 3. `production`——开发/测试环境不该凭空多出一个免密入口，
 *    本地要看预览效果直接登录预置的游客账号即可。
 *
 * 另外拒绝"游客账号名 == 管理员账号名"：那会让 `POST /app/account/guest-login`
 * 签发的会话属于管理员账号名（`isAdminAccountName()` 会把它当成管理员，
 * 从而解锁"密码只能本人改""不能被停用"这些保护），是彻底的配置事故。
 */
export function resolveGuestLoginEnabled(input: {
  requested: boolean
  runtimeMode: 'docker' | 'native'
  mode: ServerConfig['mode']
  account: string | undefined
  adminUsername: string
}): boolean {
  if (!input.requested) {
    return false
  }
  if (input.runtimeMode !== 'native' || input.mode !== 'production') {
    return false
  }
  const account = input.account?.trim() || DEFAULT_GUEST_LOGIN_ACCOUNT
  if (account === input.adminUsername) {
    return false
  }
  return true
}

/**
 * 游客登录被拒绝的原因（用于启动日志）。返回空串表示没有被拒绝。
 *
 * 单独抽出来是为了让"配了但没生效"这件事在日志里有一句人话可看——
 * 否则表现是"登录页就是不出现游客按钮"，而排查的人只能去翻源码。
 */
export function describeGuestLoginRejection(input: {
  requested: boolean
  runtimeMode: 'docker' | 'native'
  mode: ServerConfig['mode']
  account: string | undefined
  adminUsername: string
}): string {
  if (!input.requested) {
    return ''
  }
  if (input.runtimeMode !== 'native') {
    return 'GSH_GUEST_LOGIN_ENABLED 已开启，但当前是 Docker 运行时：一次有效登录等价于宿主机 root，游客预览会把它交给任何匿名访客，因此拒绝开放（改用 Native 模式部署，并在反向代理层再加一层访问控制）'
  }
  if (input.mode !== 'production') {
    return `GSH_GUEST_LOGIN_ENABLED 已开启，但当前是 ${input.mode} 环境：游客登录只在 production 下开放`
  }
  if ((input.account?.trim() || DEFAULT_GUEST_LOGIN_ACCOUNT) === input.adminUsername) {
    return 'GSH_GUEST_LOGIN_ACCOUNT 与管理员的 ADMIN_USERNAME 同名：那会让游客会话落到管理员账号名上，因此拒绝开放'
  }
  return ''
}

export function resolveCorsOrigin(
  mode: ServerConfig['mode'],
  raw: string | undefined,
): boolean | string | string[] {
  const normalized = raw?.trim()
  if (normalized) {
    if (normalized === 'true' || normalized === '*') {
      return true
    }
    if (normalized === 'false') {
      return false
    }
    return normalized.split(',').map(item => item.trim()).filter(Boolean)
  }
  return mode === 'development'
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? ''
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function generateAdminPassword() {
  const entropy = randomBytes(12).toString('base64url')
  return `GsH!${entropy}9a`
}

function resolveAdminCredentials(
  mode: ServerConfig['mode'],
  envUsername: string | undefined,
  envPassword: string | undefined,
) {
  const username = envUsername?.trim() || 'superadmin'
  const password = envPassword?.trim()
  if (password) {
    return {
      username,
      password,
      generated: false,
    }
  }
  if (mode === 'production') {
    return {
      username,
      password: generateAdminPassword(),
      generated: true,
    }
  }
  return {
    username,
    password: '123456',
    generated: false,
  }
}

export function resolveInstallLogsDir(dbPath: string) {
  return path.join(path.dirname(dbPath), 'install-logs')
}

export function ensureServerRuntimeDirs(config: Pick<ServerConfig, 'dbPath' | 'logDir' | 'instancesRoot' | 'backupsRoot' | 'nativeRuntimeDir'>) {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
  fs.mkdirSync(config.logDir, { recursive: true })
  fs.mkdirSync(config.instancesRoot, { recursive: true })
  fs.mkdirSync(config.backupsRoot, { recursive: true })
  fs.mkdirSync(config.nativeRuntimeDir, { recursive: true })
  fs.mkdirSync(resolveInstallLogsDir(config.dbPath), { recursive: true })
}
