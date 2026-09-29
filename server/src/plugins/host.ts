import type { ChildProcess } from 'node:child_process'
import type { PluginAuditRecord, PluginCapability, PluginManifest } from '../../../shared/contracts/plugin'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { readPluginAudit } from './audit-store'
import { loadPluginDirectory, summarizePluginCapabilities } from './manifest'
import { resolvePluginsRoot } from './registry'
import { startCapabilityServer } from './capability-server'
import type { CapabilityContext, CapabilityServerHandle } from './capability-server'

/**
 * 插件进程的生命周期管理。
 *
 * 三条设计前提（改动前先确认仍成立）：
 * 1. **进程外**：插件是独立子进程，崩溃、挂死或被杀都不会带走面板；面板也不会替它兜异常。
 * 2. **能力按声明授予**：宿主只把清单里声明过的能力交给它，能力服务据此拒绝越权请求。
 * 3. **失败要看得见**：启动失败、非零退出、重启次数都记在插件状态里，界面上直接显示，
 *    而不是只在日志里留一行。插件"装上了但没跑"是最难排查的状态。
 *
 * 崩溃重启采用有上限的指数退避：反复崩溃的插件最终停在 `crashed`，不会无限重启刷日志。
 */

const RESTART_BASE_DELAY_MS = 1_000
const RESTART_MAX_DELAY_MS = 30_000
const RESTART_MAX_ATTEMPTS = 5
/** 插件输出日志文件名（放在插件自己的目录下，便于用户打包反馈） */
const PLUGIN_LOG_FILE = 'plugin.log'

export type PluginRuntimeState = 'stopped' | 'starting' | 'running' | 'finished' | 'crashed'

export interface PluginRuntimeStatus {
  pluginId: string
  state: PluginRuntimeState
  pid: number | null
  startedAt: string | null
  /** 连续重启次数（成功运行一段时间后清零） */
  restarts: number
  /** 最近一次错误或退出原因，直接展示给管理员 */
  lastError: string | null
}

interface PluginProcessRecord {
  manifest: PluginManifest
  directory: string
  child: ChildProcess | null
  state: PluginRuntimeState
  pid: number | null
  startedAt: string | null
  restarts: number
  lastError: string | null
  restartTimer: ReturnType<typeof setTimeout> | null
  /** 主动停止时置位：用于区分「我们让它退出的」与「它自己崩了」 */
  stopping: boolean
}

export interface PluginRuntime {
  /** 按当前启用状态拉起插件（面板启动时调用） */
  sync: () => void
  /** 停掉某个插件的进程（停用时调用） */
  stop: (pluginId: string) => void
  /** 停掉全部插件并关闭能力服务（面板退出时调用） */
  shutdown: () => Promise<void>
  /** 读取全部插件的运行状态，供接口合并展示 */
  listStatus: () => PluginRuntimeStatus[]
  /** 读取插件调用审计（最近的在前） */
  readAudit: (options?: { pluginId?: string, limit?: number }) => PluginAuditRecord[]
  /** 能力服务基址（调试与测试用） */
  capabilityBaseUrl: () => string | null
}

/**
 * 等子进程真正退出。
 *
 * 为什么不能只 `kill()` 再 sleep 一个固定值：kill 只是「请求」退出，实际退出是异步的。
 * 面板退出时若不等，能力服务会在子进程仍持有连接时被关掉，进程也可能残留成孤儿；
 * 测试里更直接——整个测试进程会在子进程还没退的时候结束，被记成用例失败。
 * 超时后不再纠缠：子进程已经不可能自己退了，剩下的交给操作系统回收。
 */
async function waitForExit(child: ChildProcess | null, timeoutMs: number): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      child.off('close', finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    child.once('close', finish)
  })
}

/** 退出时等待单个插件进程自行退出的上限；Windows 上进程退出明显慢于 Linux */
const STOP_EXIT_TIMEOUT_MS = 3_000
/** 强杀之后允许它被操作系统回收的时间：给过机会还不退，就不能再等 */
const STOP_EXIT_KILL_GRACE_MS = 500

/**
 * 请插件进程退出：先好声好气（SIGTERM / TerminateProcess），宽限期内没退就结束它。
 *
 * 为什么必须补最后一刀：`kill()` 只是发出终止请求，进程何时真正回收由操作系统决定。
 * 实测 Windows 上被终止的插件进程可以拖住父进程的事件循环约 30 秒（子进程句柄仍在），
 * 会让面板退出、以及测试进程收尾都卡在"跑完了但退不掉"。宽限期一过就不再讲礼貌。
 */
async function stopPluginProcess(child: ChildProcess | null): Promise<void> {
  if (!child) {
    return
  }
  child.kill()
  await waitForExit(child, STOP_EXIT_TIMEOUT_MS)
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  child.kill('SIGKILL')
  await waitForExit(child, STOP_EXIT_KILL_GRACE_MS)
}

/**
 * 启动插件进程。
 *
 * 环境变量是插件与宿主之间唯一的启动约定：
 * - `GSH_PLUGIN_ID` / `GSH_PLUGIN_DIR`：我是谁、我在哪；
 * - `GSH_CAPABILITY_URL` / `GSH_PLUGIN_TOKEN`：能力服务的地址与一次性令牌；
 * - `GSH_PLUGIN_API_VERSION`：宿主实现的接口版本。
 * 令牌只通过环境变量传递，不出现在命令行参数里（进程列表对同机其它用户可见）。
 */
function spawnPluginProcess(input: {
  manifest: PluginManifest
  pluginDir: string
  capabilityUrl: string
  token: string
  hostApiVersion: number
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
  onError: (error: Error) => void
}): ChildProcess {
  const entryPath = path.join(input.pluginDir, input.manifest.entry)
  const logPath = path.join(input.pluginDir, PLUGIN_LOG_FILE)
  const logFd = fs.openSync(logPath, 'a')

  const child = spawn(process.execPath, [entryPath], {
    cwd: input.pluginDir,
    env: {
      ...process.env,
      GSH_PLUGIN_ID: input.manifest.id,
      GSH_PLUGIN_DIR: input.pluginDir,
      GSH_PLUGIN_API_VERSION: String(input.hostApiVersion),
      GSH_CAPABILITY_URL: input.capabilityUrl,
      GSH_PLUGIN_TOKEN: input.token,
    },
    /**
     * 插件的输出接到它自己目录下的日志文件：既不在面板日志里制造噪音，
     * 也保证插件日志能随插件目录一起被打包反馈；用文件描述符而不是管道，
     * 避免宿主与插件之间因管道背压互相拖住。
     */
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  })
  child.on('close', () => {
    try {
      fs.closeSync(logFd)
    }
    catch {
      // 已关闭
    }
  })
  child.on('error', input.onError)
  child.on('exit', input.onExit)
  return child
}

export interface CreatePluginRuntimeOptions {
  hostApiVersion: number
  onLog?: (event: { pluginId: string, message: string }) => void
  /** 重启退避基数（毫秒）；测试传入较小的值以免用例等真实退避 */
  restartBaseDelayMs?: number
}

export async function createPluginRuntime(
  options: CreatePluginRuntimeOptions,
): Promise<PluginRuntime> {
  const records = new Map<string, PluginProcessRecord>()
  const granted = new Map<string, Set<PluginCapability>>()
  const context: CapabilityContext = { grantedCapabilities: granted }
  const restartBaseDelayMs = options.restartBaseDelayMs ?? RESTART_BASE_DELAY_MS
  const log = (pluginId: string, message: string) => options.onLog?.({ pluginId, message })
  /**
   * 退出后不再安排任何重启。
   *
   * 只清一遍 `restartTimer` 是不够的：子进程退出是异步的，`kill()` 之后 onExit 仍可能在
   * shutdown 过程中到达，并挂上新的退避定时器——最长 30 秒。那个定时器会让事件循环一直有活干，
   * 面板退出与测试进程收尾都要干等它跑完；等它真的触发时数据库已经关了，还会抛
   * 「SQLite database is not initialized」。所以用显式状态拦住，而不是逐处清理。
   */
  let stopped = false

  let capability: CapabilityServerHandle | null = null
  try {
    capability = await startCapabilityServer(context, {
      onAuditError: error => log('*', `插件审计写入失败（调用本身不受影响）：${error.message}`),
    })
  }
  catch (error) {
    // 能力服务起不来时插件无法工作，但面板必须照常运行
    options.onLog?.({
      pluginId: '*',
      message: `插件能力服务启动失败，插件将被跳过：${error instanceof Error ? error.message : String(error)}`,
    })
  }

  function clearRestartTimer(record: PluginProcessRecord): void {
    if (record.restartTimer) {
      clearTimeout(record.restartTimer)
      record.restartTimer = null
    }
  }

  function scheduleRestart(record: PluginProcessRecord): void {
    if (stopped || record.stopping || !capability) {
      return
    }
    if (record.restarts >= RESTART_MAX_ATTEMPTS) {
      record.state = 'crashed'
      /**
       * 这里把「连续失败多少次」补进原因里：前几次崩溃留下的 lastError 只说了一次
       * 「退出码 3」，管理员会以为它只崩了一次；真正要看到的是"已经反复崩了、宿主不再重启"。
       */
      const previous = record.lastError ? `（最近一次：${record.lastError}）` : ''
      record.lastError = `连续 ${record.restarts} 次异常退出，已停止重启${previous}。请查看插件目录下的 ${PLUGIN_LOG_FILE}。`
      record.child = null
      record.pid = null
      log(record.manifest.id, record.lastError)
      return
    }
    const delayMs = Math.min(restartBaseDelayMs * 2 ** record.restarts, RESTART_MAX_DELAY_MS)
    record.restarts += 1
    log(record.manifest.id, `插件异常退出，${Math.round(delayMs / 1000)} 秒后尝试第 ${record.restarts} 次重启`)
    record.restartTimer = setTimeout(() => {
      record.restartTimer = null
      launch(record)
    }, delayMs)
  }

  function launch(record: PluginProcessRecord): void {
    if (stopped) {
      return
    }
    if (!capability) {
      record.state = 'crashed'
      record.lastError = '插件能力服务不可用，无法启动插件。'
      return
    }
    record.state = 'starting'
    const child = spawnPluginProcess({
      manifest: record.manifest,
      pluginDir: record.directory,
      capabilityUrl: capability.baseUrl,
      token: capability.token,
      hostApiVersion: options.hostApiVersion,
      onError: (error) => {
        record.state = 'crashed'
        record.lastError = `插件进程启动失败：${error.message}`
        record.child = null
        record.pid = null
        log(record.manifest.id, record.lastError)
      },
      onExit: (code, signal) => {
        record.child = null
        record.pid = null
        if (record.stopping) {
          record.state = 'stopped'
          return
        }
        /**
         * 退出语义分两类，混在一起会把两种插件都搞坏：
         * - **零码退出**：插件自己做完了事（例如一次性同步任务）。记为 `finished` 且**不重启**——
         *   否则一个跑完就退的插件会被无限拉起，日志里全是重启记录；
         * - **非零退出或被信号终止**：视为崩溃，记录原因并在退避后重启。
         */
        if (!signal && code === 0) {
          record.state = 'finished'
          record.lastError = '插件已正常退出（退出码 0）。'
          log(record.manifest.id, record.lastError)
          return
        }
        record.state = 'crashed'
        record.lastError = signal
          ? `插件被信号 ${signal} 终止`
          : `插件异常退出（退出码 ${code ?? 'unknown'}）`
        log(record.manifest.id, record.lastError)
        scheduleRestart(record)
      },
    })
    record.child = child
    record.pid = child.pid ?? null
    record.startedAt = new Date().toISOString()
    // 子进程能 spawn 出来就视为已启动；插件是否真的工作由它自己的能力调用与日志体现
    record.state = 'running'
  }

  function ensureRecord(input: {
    manifest: PluginManifest
    directory: string
    capabilities: PluginCapability[]
  }): PluginProcessRecord {
    const existing = records.get(input.manifest.id)
    if (existing) {
      existing.manifest = input.manifest
      existing.directory = input.directory
      return existing
    }
    const record: PluginProcessRecord = {
      manifest: input.manifest,
      directory: input.directory,
      child: null,
      state: 'stopped',
      pid: null,
      startedAt: null,
      restarts: 0,
      lastError: null,
      restartTimer: null,
      stopping: false,
    }
    records.set(input.manifest.id, record)
    return record
  }

  function sync(): void {
    const pluginsRoot = resolvePluginsRoot()
    const enabled = readEnabledIds(pluginsRoot)

    // 停掉不再需要运行的插件
    for (const [pluginId, record] of records) {
      if (!enabled.has(pluginId) && record.state !== 'stopped') {
        stop(record.manifest.id)
      }
    }

    for (const pluginId of enabled) {
      const directory = findPluginDirectory(pluginsRoot, pluginId)
      if (!directory) {
        log(pluginId, '插件已启用但目录不存在，跳过启动')
        continue
      }
      const loaded = loadPluginDirectory(directory)
      if (!loaded.ok) {
        log(pluginId, `插件装载失败，跳过启动：${loaded.message}`)
        continue
      }
      const summary = summarizePluginCapabilities(loaded.manifest)
      ensureRecord({
        manifest: loaded.manifest,
        directory,
        capabilities: summary.capabilities,
      })
      // 授予能力：这是宿主对插件的实际授权，能力服务据此判定
      granted.set(pluginId, new Set(summary.capabilities))
      const record = records.get(pluginId)!
      /**
       * `crashed` 且已经用满重启次数时不再拉起：崩溃上限是**不可逆**的，
       * 否则任何一次 `sync()`（例如管理员刷一下插件开关）都会把它重新拉起来，
       * 让"已停止重启"的结论与界面显示互相矛盾。
       */
      const restartBudgetExhausted = record.state === 'crashed' && record.restarts >= RESTART_MAX_ATTEMPTS
      if (!restartBudgetExhausted
        && (record.state === 'stopped' || record.state === 'crashed' || record.state === 'finished')) {
        record.restarts = 0
        record.lastError = null
        record.stopping = false
        launch(record)
      }
    }
  }

  function stop(pluginId: string): void {
    const record = records.get(pluginId)
    if (!record) {
      return
    }
    record.stopping = true
    clearRestartTimer(record)
    granted.delete(pluginId)
    const child = record.child
    if (child && child.pid) {
      child.kill()
    }
    record.child = null
    record.pid = null
    record.state = 'stopped'
  }

  return {
    sync,
    stop,
    async shutdown() {
      stopped = true
      const pending: (ChildProcess | null)[] = []
      for (const record of records.values()) {
        record.stopping = true
        clearRestartTimer(record)
        const child = record.child
        child?.kill()
        record.child = null
        record.pid = null
        record.state = 'stopped'
        pending.push(child)
      }
      granted.clear()
      // 等子进程真的退出：别把孤儿进程和未关闭的连接留给下一次启动（或留给测试进程收尾）
      await Promise.all(pending.map(child => stopPluginProcess(child)))
      await capability?.close()
      capability = null
    },
    listStatus() {
      return [...records.values()].map(record => ({
        pluginId: record.manifest.id,
        state: record.state,
        pid: record.pid,
        startedAt: record.startedAt,
        restarts: record.restarts,
        lastError: record.lastError,
      }))
    },
    capabilityBaseUrl() {
      return capability?.baseUrl ?? null
    },
    readAudit(auditOptions = {}) {
      return readPluginAudit(auditOptions)
    },
  }
}

/** 读取启用列表；与 registry 的状态文件同一份数据，避免两处解析不一致 */
function readEnabledIds(pluginsRoot: string): Set<string> {
  const statePath = path.join(pluginsRoot, 'plugins.state.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { enabled?: unknown }
    if (!Array.isArray(parsed.enabled)) {
      return new Set()
    }
    return new Set(parsed.enabled.filter((item): item is string => typeof item === 'string'))
  }
  catch {
    return new Set()
  }
}

function findPluginDirectory(pluginsRoot: string, pluginId: string): string | null {
  for (const entry of fs.existsSync(pluginsRoot) ? fs.readdirSync(pluginsRoot, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue
    }
    const pluginDir = path.join(pluginsRoot, entry.name)
    const loaded = loadPluginDirectory(pluginDir)
    if (loaded.ok && loaded.manifest.id === pluginId) {
      return pluginDir
    }
  }
  return null
}
