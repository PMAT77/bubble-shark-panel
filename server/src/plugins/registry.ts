import { readBrandEnv } from '../../../shared/brand-env'
import type { PluginListItem, PluginListResult, PluginState } from '../../../shared/contracts/plugin'
import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_HOST_API_VERSION } from '../../../shared/contracts/plugin'
import { loadServerConfig } from '../shared/config'
import { readLicenseState } from '../shared/license'
import { loadPluginDirectory, summarizePluginCapabilities } from './manifest'
import { PLUGIN_STORE_NOTICE } from './store-catalog'

/**
 * 插件注册表：扫描插件目录、维护启用状态、给出每个插件的可用性结论。
 *
 * 目录与状态文件：
 * ```text
 * <插件根>/                      默认 <面板数据目录>/plugins
 *   plugins.state.json          启用状态（人工可读可改）
 *   <插件目录>/plugin.json      插件本体
 * ```
 *
 * 两条设计选择：
 * 1. **状态存 JSON 而不是数据库**：插件启用状态是运维数据，出问题时管理员要能直接
 *    看文件、手工改、随数据目录一起搬走。放进数据库反而让「插件把面板搞坏了」更难救。
 * 2. **扫描永不抛异常**：某个插件目录损坏只影响它自己的状态，绝不能让插件列表接口
 *    500 —— 否则一个坏插件会让管理员连"禁用"按钮都点不到。
 */

const STATE_FILE = 'plugins.state.json'

interface PluginsStateFile {
  version: 1
  enabled: string[]
}

const EMPTY_STATE: PluginsStateFile = { version: 1, enabled: [] }

export function resolvePluginsRoot(): string {
  const configured = readBrandEnv('BSP_PLUGINS_ROOT')?.trim()
  if (configured) {
    return path.resolve(configured)
  }
  return path.join(path.dirname(loadServerConfig().dbPath), 'plugins')
}

function resolveStateFilePath(pluginsRoot: string): string {
  return path.join(pluginsRoot, STATE_FILE)
}

function readState(pluginsRoot: string): PluginsStateFile {
  const statePath = resolveStateFilePath(pluginsRoot)
  if (!fs.existsSync(statePath)) {
    return { ...EMPTY_STATE, enabled: [] }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<PluginsStateFile>
    const enabled = Array.isArray(parsed.enabled) ? parsed.enabled.filter(item => typeof item === 'string') : []
    return { version: 1, enabled }
  }
  catch {
    // 状态文件损坏时按「全部未启用」处理：宁可要求管理员重新启用，也不要凭半个文件猜
    return { ...EMPTY_STATE, enabled: [] }
  }
}

function writeState(pluginsRoot: string, state: PluginsStateFile): void {
  fs.mkdirSync(pluginsRoot, { recursive: true })
  fs.writeFileSync(
    resolveStateFilePath(pluginsRoot),
    `${JSON.stringify({ version: 1, enabled: [...state.enabled].sort() }, null, 2)}\n`,
    'utf8',
  )
}

/** 列出插件目录名（忽略文件、状态文件与隐藏目录） */
function listPluginDirectories(pluginsRoot: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(pluginsRoot, { withFileTypes: true })
  }
  catch {
    return []
  }
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort()
}

/**
 * 商业功能 → 该功能最可能用到的宿主 API 能力。
 *
 * 这里有两个不同的命名空间，别混：
 * - **插件清单**里声明的 `capabilities` 是宿主 API 权限（`instances:read` 之类）；
 * - **授权文件**里的能力是商业打包单位（`audit-log`、`multi-node` 之类）。
 *
 * 两者不一一对应，所以需要一层显式映射来做「这个插件是不是该要授权」的判断。
 * 映射只用于**授权门槛**，不用来收窄插件所需的 API 权限——否则一个自研的多节点插件
 * 会因为没买商业授权而连自己写的功能都用不了。
 */
const COMMERCIAL_CAPABILITY_REQUIREMENTS: Record<string, { apiCapabilities: string[], label: string }> = {
  'audit-log': { apiCapabilities: ['instances:read', 'console:read'], label: '操作审计日志' },
  'remote-backup': { apiCapabilities: ['backups:read', 'backups:write'], label: '异地与云备份' },
  'multi-node': { apiCapabilities: ['instances:read', 'metrics:read'], label: '多节点统一管理' },
  'advanced-rbac': { apiCapabilities: ['instances:read'], label: '高级权限与角色' },
}

/**
 * 只读审计类插件单独判定：它们是**只读**的（不碰实例、不改数据），
 * 只要申请了 `operations:read` 或 `console:read` 就落在「操作审计日志」的商业范围内。
 * 不这样分开的话，一个只读审计插件会因为没申请实例读写能力而绕过授权。
 */
const READ_ONLY_AUDIT_CAPABILITIES = new Set(['operations:read'])

/**
 * 判断插件是否落在某个商业能力的范围内，并给出授权缺口。
 *
 * 判定方式是「插件声明的宿主 API 能力覆盖了某商业功能所需的全部 API」——
 * 只有真正要动那些能力的插件才会被要求授权；只读指标之类的轻量插件不受影响。
 */
export function resolveLicenseGap(manifestCapabilities: string[]): string | null {
  const declared = new Set(manifestCapabilities)
  const license = readLicenseState()
  const licenseHas = (capability: string) =>
    license.status === 'active' && license.capabilities.includes(capability as never)

  for (const [commercialCapability, requirement] of Object.entries(COMMERCIAL_CAPABILITY_REQUIREMENTS)) {
    const inScope = requirement.apiCapabilities.every(capability => declared.has(capability))
    if (!inScope) {
      continue
    }
    if (!licenseHas(commercialCapability)) {
      return `该插件提供的是「${requirement.label}」能力，属于商业插件，当前未检测到包含它的有效授权。`
    }
  }

  for (const capability of declared) {
    if (READ_ONLY_AUDIT_CAPABILITIES.has(capability) && !licenseHas('audit-log')) {
      return '该插件读取面板的操作审计，属于「操作审计日志」商业能力，当前未检测到包含它的有效授权。'
    }
  }
  return null
}

export interface ScanPluginsOptions {
  /** 跳过授权检查（测试与排障用；面板正常路径不传） */
  skipLicenseCheck?: boolean
  /**
   * 进程运行状态查询（由宿主 runtime 提供）；缺省时全部记为 stopped。
   * 类型直接取自契约里的 `runtime` 字段，避免两处手写枚举漂移
   * （新增 `finished` 状态时就因为手写联合类型漏了一处而编译失败）。
   */
  runtimeStatus?: (pluginId: string) => PluginListItem['runtime'] | undefined
}

const STOPPED_RUNTIME = {
  state: 'stopped' as const,
  pid: null,
  startedAt: null,
  restarts: 0,
  lastError: null,
}

/** 扫描插件根目录，给出每个插件的状态 */
export function scanPlugins(options: ScanPluginsOptions = {}): PluginListResult {
  const pluginsRoot = resolvePluginsRoot()
  const state = readState(pluginsRoot)
  const enabledSet = new Set(state.enabled)
  const items: PluginListItem[] = []
  const runtimeOf = (pluginId: string) => options.runtimeStatus?.(pluginId) ?? STOPPED_RUNTIME

  for (const directory of listPluginDirectories(pluginsRoot)) {
    const pluginDir = path.join(pluginsRoot, directory)
    const loaded = loadPluginDirectory(pluginDir)

    if (!loaded.ok) {
      items.push({
        id: directory,
        name: directory,
        version: '-',
        apiVersion: 0,
        kind: 'community',
        state: 'invalid',
        enabled: false,
        message: loaded.message,
        capabilities: [],
        hasDangerousCapabilities: false,
        signed: false,
        publisher: null,
        description: null,
        author: null,
        directory,
        runtime: STOPPED_RUNTIME,
      })
      continue
    }

    const manifest = loaded.manifest
    const summary = summarizePluginCapabilities(manifest)
    const enabled = enabledSet.has(manifest.id)
    let pluginState: PluginState = enabled ? 'ready' : 'disabled'
    /**
     * 正常状态不给说明：界面上的「已启用 / 已停用」与进程状态标签已经把话说完，
     * 再补一句「等待宿主启动」在进程已经跑起来之后就是错话。这里只留需要用户注意的，
     * 即装载失败原因、缺授权，以及下面的进程侧说明。
     */
    let message = ''

    if (enabled && manifest.kind === 'commercial' && !options.skipLicenseCheck) {
      const gap = resolveLicenseGap(manifest.capabilities)
      if (gap) {
        pluginState = 'missing_license'
        message = gap
      }
    }

    const runtime = runtimeOf(manifest.id)
    // 进程侧的说明（启动失败、异常退出、正常退出）本身就是用户要看的东西，直接作为状态说明
    if (runtime.lastError) {
      message = runtime.lastError
    }

    items.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      kind: manifest.kind,
      state: pluginState,
      enabled,
      message,
      capabilities: summary.capabilities,
      hasDangerousCapabilities: summary.hasDangerousCapabilities,
      signed: loaded.signed,
      publisher: loaded.publisher,
      description: manifest.description ?? null,
      author: manifest.author ?? null,
      directory,
      runtime,
    })
  }

  return {
    hostApiVersion: PLUGIN_HOST_API_VERSION,
    pluginsRoot,
    items,
    /**
     * 货架说明在这里给一份，而不是只在商店合并那一步拼上：`scanPlugins()` 是
     * 「插件列表」的唯一真源，漏了它就会返回一个不符合契约的对象。
     * 合并函数用的是同一个常量，因此两处不会出现两种说法。
     */
    storeNotice: PLUGIN_STORE_NOTICE,
  }
}

export type SetPluginEnabledResult
  = | { ok: true, message: string }
    | { ok: false, message: string }

/**
 * 启用或停用插件。
 *
 * 拒绝的情况都给出可执行的说明：
 * - 插件不存在（提示刷新）；
 * - 插件装载失败（先修文件，别指望启用能绕过校验）；
 * - 启用危险能力但未确认；
 * - 商业插件缺少授权能力。
 */
export function setPluginEnabled(input: {
  pluginId: string
  enabled: boolean
  acknowledgeDangerous?: boolean
}): SetPluginEnabledResult {
  const pluginsRoot = resolvePluginsRoot()
  const state = readState(pluginsRoot)
  const enabledSet = new Set(state.enabled)

  const targetDirectory = listPluginDirectories(pluginsRoot)
    .find((directory) => {
      const loaded = loadPluginDirectory(path.join(pluginsRoot, directory))
      return (loaded.ok && loaded.manifest.id === input.pluginId) || directory === input.pluginId
    })
  if (!targetDirectory) {
    return { ok: false, message: `未找到插件「${input.pluginId}」：请刷新列表，确认插件目录已放入 ${pluginsRoot}。` }
  }

  if (!input.enabled) {
    enabledSet.delete(input.pluginId)
    writeState(pluginsRoot, { version: 1, enabled: [...enabledSet] })
    return { ok: true, message: `已停用「${input.pluginId}」。` }
  }

  const loaded = loadPluginDirectory(path.join(pluginsRoot, targetDirectory))
  if (!loaded.ok) {
    return { ok: false, message: `无法启用：${loaded.message}` }
  }
  const summary = summarizePluginCapabilities(loaded.manifest)
  if (summary.hasDangerousCapabilities && !input.acknowledgeDangerous) {
    const dangerous = summary.capabilities.filter(capability => capability === 'instances:lifecycle'
      || capability === 'console:write'
      || capability === 'backups:write'
      || capability === 'network:outbound')
    return {
      ok: false,
      message: `该插件声明了会影响线上实例或对外联网的能力（${dangerous.join('、')}），需要确认后才能启用。`,
    }
  }
  if (loaded.manifest.kind === 'commercial') {
    const gap = resolveLicenseGap(loaded.manifest.capabilities)
    if (gap) {
      return { ok: false, message: `无法启用：${gap}` }
    }
  }

  enabledSet.add(loaded.manifest.id)
  writeState(pluginsRoot, { version: 1, enabled: [...enabledSet] })
  return { ok: true, message: `已启用「${loaded.manifest.name}」。` }
}
