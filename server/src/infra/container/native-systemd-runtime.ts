import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveDstContainerResourceLimits } from './dst-container-resources'
import { resolveUptimeSecondsFromMonotonic } from './uptime'
import { sampleProcessMetrics } from '../../shared/instance-runtime/process-metrics'
import type {
  ContainerInspect,
  ContainerRef,
  ContainerRuntime,
  ContainerStats,
  ExecResult,
  LogLine,
  LogOpts,
  ShardContainerSpec,
} from './types'

const execFileAsync = promisify(execFile)
const SAFE_SERVICE_NAME = /^[A-Za-z0-9_.-]+$/
/**
 * unit 的停机预算：DST 收到 SIGTERM 后需要落盘存档，大洞穴存档常见数十秒。
 * 与之配套的客户端等待上限必须严格大于该值，否则 systemd 还在收尾就被判失败。
 */
const NATIVE_UNIT_STOP_TIMEOUT_SEC = 30
const NATIVE_STOP_CLIENT_TIMEOUT_MS = (NATIVE_UNIT_STOP_TIMEOUT_SEC + 15) * 1000
/** 打开文件数上限：多 Mod 大存档下用户级 systemd 默认值偏小，与容器模式对齐 */
const NATIVE_UNIT_NOFILE_LIMIT = 65_535
/** CPUQuota 只接受 1%–10000%：越界会让 systemd 判定整个 unit 非法，宁可钳到边界 */
const NATIVE_UNIT_CPU_QUOTA_MAX_PERCENT = 10_000
/** 低配机上给面板与 sshd 留出的 CPU 余量（百分比，按整机核数折算） */
const NATIVE_SHARD_CPU_RESERVE_PERCENT = 20
/** 单分片 CPUQuota 下限：压太低游戏会跑不动 */
const NATIVE_UNIT_CPU_QUOTA_MIN_PERCENT = 25
/** MemoryMax 低于 1 MiB 是非法值，钳到 1 MiB 而不是写出一个起不来的 unit */
const NATIVE_UNIT_MEMORY_MIN_BYTES = 1024 * 1024
/** 软限比例：超过它就触发回收/换页，而不是直接杀进程 */
const NATIVE_UNIT_MEMORY_HIGH_RATIO = 0.8
/** 崩溃重启风暴的上限：10 分钟内最多拉起 3 次，之后停手并如实报错 */
const NATIVE_UNIT_START_LIMIT_INTERVAL_SEC = 600
const NATIVE_UNIT_START_LIMIT_BURST = 3
/** 分片日志跟随的轮询间隔 */
const NATIVE_LOG_POLL_MS = 500
/** 读取日志尾部时最多回溯的字节数，避免大文件整份读进内存 */
const NATIVE_LOG_TAIL_MAX_BYTES = 512 * 1024

/**
 * 每次启动前把上一轮的分片日志挪到 `.prev.log`，让本轮从空文件开始。
 *
 * 分片日志是 systemd `append:` 累积写入、跨重启保留的（这正是「上一轮的崩溃现场还在」的来源）。
 * 但控制台的日志跟随在启动时会**先吐文件尾部 100 行**，不轮转就会出两个问题：
 *   1. 新实例一启动，控制台先显示上一轮的输出，分不清是哪一次的；
 *   2. 那 100 行会进入面板的内存控制台，其中的就绪标记（`Shard server started on port`）
 *      是**上一轮**的。若上一轮进程尚未完全退出、分片端口仍被占用，就绪判定会在 t≈0
 *      通过门 1，再命中这条陈旧标记通过门 2 —— 洞穴于是会在主世界还在加载时被放行，
 *      「两个分片同时加载」的整机 OOM 风险原样回来。
 * 轮转后两边都干净，上一轮的现场仍完整保留在 `.prev.log` 里。
 */
export function rotateConsoleLogFile(consoleLogPath: string): void {
  if (readFileSize(consoleLogPath) === 0) {
    return
  }
  try {
    fs.renameSync(consoleLogPath, `${consoleLogPath}.prev.log`)
  }
  catch {
    // 轮转失败不阻断启动：systemd 的 append 模式会继续追加到原文件
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function readFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  }
  catch {
    return 0
  }
}

function readFileRange(filePath: string, start: number, end: number): string | null {
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(filePath, 'r')
    const length = Math.max(0, end - start)
    if (length === 0) {
      return ''
    }
    const buffer = Buffer.allocUnsafe(length)
    const read = fs.readSync(descriptor, buffer, 0, length, start)
    return buffer.subarray(0, read).toString('utf8')
  }
  catch {
    return null
  }
  finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor)
    }
  }
}

/** 读日志文件最后 maxLines 行；文件不存在时返回空数组 */
export function readFileTailLines(filePath: string, maxLines: number): string[] {
  const size = readFileSize(filePath)
  if (size === 0 || maxLines <= 0) {
    return []
  }
  const start = size > NATIVE_LOG_TAIL_MAX_BYTES ? size - NATIVE_LOG_TAIL_MAX_BYTES : 0
  const chunk = readFileRange(filePath, start, size)
  if (!chunk) {
    return []
  }
  const lines = chunk.split(/\r?\n/).filter(line => line.trim())
  // 从文件中部开始读时首行可能是半截，丢掉更安全
  if (start > 0 && lines.length > 0) {
    lines.shift()
  }
  return lines.slice(-maxLines)
}

/**
 * 分片 CPUQuota（百分比）。
 *
 * 两个 DST 分片各占满一个核时，2 核机上一个核都不剩，面板和 sshd 会一起饿死
 * （线上实测面板出现 69 秒完全无日志的静默期）。这里按「整机核数 − 预留」均分给
 * 两个分片，保证面板始终有一小片 CPU；用户显式设了 GSH_DST_CONTAINER_CPU_QUOTA
 * 时以用户配置为准。
 */
export function resolveShardCpuQuotaPercent(cpuCount = os.cpus().length): number | undefined {
  if (cpuCount <= 0) {
    return undefined
  }
  const perShard = Math.floor((100 * cpuCount - NATIVE_SHARD_CPU_RESERVE_PERCENT) / 2)
  return Math.min(
    NATIVE_UNIT_CPU_QUOTA_MAX_PERCENT,
    Math.max(NATIVE_UNIT_CPU_QUOTA_MIN_PERCENT, perShard),
  )
}
/** 启动失败时回给界面的诊断文本上限，避免整份 unit 加 status 输出刷屏 */
const UNIT_DIAGNOSTIC_MAX_CHARS = 2_000

export interface NativeSystemdRuntimeOptions {
  runtimeDir: string
  unitDir: string
}

function assertSafeServiceName(name: string) {
  if (!SAFE_SERVICE_NAME.test(name)) {
    throw new Error(`非法 Native 服务名: ${name}`)
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * systemd 会对手写的值做 specifier 展开：路径或描述里出现一个裸 `%`（如实例目录名带 `%`）
 * 会让整个 unit 被判成非法，`systemctl start` 只报一句 "has a bad unit file setting"。
 * `%%` 才是字面 `%`，因此所有来自实例数据的值先过这里。
 */
function escapeSpecifiers(value: string): string {
  return value.replace(/%/g, '%%')
}

function systemdQuote(value: string): string {
  return `"${escapeSpecifiers(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ')}"`
}

/**
 * WorkingDirectory= 不能加引号：systemd 对这一行不做去引号处理，会把 `"/srv/x/bin64"`
 * 整串（引号在内）当路径来判断绝对性，于是报 "path is not absolute" 并把 unit 判成
 * bad unit file setting —— 实例一个都起不来。ExecStart= 走 shell 风格分词，引号是合法的，
 * 因此两者必须分开处理；路径里的 `%` 仍要转义（specifier 展开对两行都生效）。
 */
function systemdPath(value: string): string {
  return escapeSpecifiers(value)
}

function parseSystemctlProperties(stdout: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator <= 0) {
      continue
    }
    result[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return result
}

function writeFileAtomic(filePath: string, content: string, mode: number) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', mode })
  fs.renameSync(temporaryPath, filePath)
  fs.chmodSync(filePath, mode)
}

/**
 * 由 `systemctl show` 的属性解析出单元运行状态。
 *
 * 分片 unit 是 `Type=simple` + `Restart=on-failure` + `RestartSec=5`：进程一崩，unit 会在
 * `activating (auto-restart)` 停留 5 秒。只看 ActiveState 会把这段窗口报成「已停止」，
 * 于是实例状态被对账成 stopped、下一轮又变回 running，在两次请求之间来回翻转。
 * 等待重启同样算运行中；真正停下来时 ActiveState 是 inactive/failed。
 *
 * `systemUptimeSeconds` 只用于把 monotonic 启动时刻换算成「当前进程跑了多久」，注入是为了能测。
 */
export function resolveNativeUnitState(
  properties: Record<string, string>,
  systemUptimeSeconds = os.uptime(),
): {
  running: boolean
  restarting: boolean
  exitResult?: string
  restarts?: number
  uptimeSeconds?: number
  memPeakMb?: number
} {
  const loaded = properties.LoadState !== 'not-found'
  const restarting = loaded && properties.SubState === 'auto-restart'
  const restarts = Number(properties.NRestarts)
  const exitResult = properties.Result?.trim()
  const uptimeSeconds = resolveUptimeSecondsFromMonotonic(
    properties.ExecMainStartTimestampMonotonic,
    systemUptimeSeconds,
  )
  // MemoryPeak 需要 systemd 249+；读不到就是 undefined，界面不显示峰值，判定不受影响
  const memPeakBytes = Number(properties.MemoryPeak)
  const memPeakMb = Number.isInteger(memPeakBytes) && memPeakBytes > 0
    ? Math.round(memPeakBytes / (1024 * 1024))
    : undefined
  return {
    running: loaded && (properties.ActiveState === 'active' || restarting),
    restarting,
    // Result=success 是正常值，只有非正常退出才值得带回上层
    ...(exitResult && exitResult !== 'success' ? { exitResult } : {}),
    ...(Number.isInteger(restarts) && restarts > 0 ? { restarts } : {}),
    ...(uptimeSeconds !== undefined ? { uptimeSeconds } : {}),
    ...(memPeakMb !== undefined ? { memPeakMb } : {}),
  }
}

const CGROUP_ROOT = '/sys/fs/cgroup'

/**
 * cgroup v2 `memory.events` 文本 → `oom_kill` 计数。
 *
 * 必须按行首精确匹配：`oom_group_kill` 是另一条计数，用子串匹配会张冠李戴。
 */
export function parseCgroupOomKillCount(text: string): number | undefined {
  const match = /^oom_kill[ \t]+(\d+)[ \t]*$/m.exec(text)
  if (!match) {
    return undefined
  }
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 读某个单元的 cgroup OOM 计数。
 *
 * 路径拼自 `systemctl show -p ControlGroup`：比硬编码 user slice 层级可靠（uid、单元名、
 * app.slice 都随部署变化）。读不到（cgroup v1、权限不足、单元已被回收）就返回 undefined，
 * 由调用方退回其它判据，不猜。
 */
export function readCgroupOomKillCount(controlGroup: string | undefined): number | undefined {
  const relative = controlGroup?.trim()
  if (!relative || !relative.startsWith('/') || relative.includes('..')) {
    return undefined
  }
  try {
    return parseCgroupOomKillCount(fs.readFileSync(path.join(CGROUP_ROOT, relative, 'memory.events'), 'utf8'))
  }
  catch {
    return undefined
  }
}

export interface UnitLoadDiagnosticInput {
  unitPath: string
  unitContent?: string
  verifyOutput?: string
  statusOutput?: string
}

/** unit 与 status 输出都很长，界面只需要看清哪一行非法 */
function truncateDiagnostic(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > UNIT_DIAGNOSTIC_MAX_CHARS
    ? `${trimmed.slice(0, UNIT_DIAGNOSTIC_MAX_CHARS)}\n…（已截断）`
    : trimmed
}

/**
 * systemd 的 `has a bad unit file setting` 不说是哪一行：这里把自校验输出、status 原文与
 * unit 文件内容一起带上，界面与日志直接给出可定位的证据，省掉一次服务器登录排查。
 */
export function formatUnitLoadDiagnostic(input: UnitLoadDiagnosticInput): string {
  const sections: string[] = []
  if (input.verifyOutput?.trim()) {
    sections.push(`systemd-analyze verify：\n${truncateDiagnostic(input.verifyOutput)}`)
  }
  if (input.statusOutput?.trim()) {
    sections.push(`systemctl --user status：\n${truncateDiagnostic(input.statusOutput)}`)
  }
  if (input.unitContent?.trim()) {
    sections.push(`unit 文件内容（${input.unitPath}）：\n${truncateDiagnostic(input.unitContent)}`)
  }
  return sections.join('\n\n')
}

export function buildNativeLauncherScript(spec: ShardContainerSpec, fifoPath: string): string {
  const command = spec.cmd.map(shellQuote).join(' ')
  return `#!/usr/bin/env bash
set -Eeuo pipefail

fifo_path=${shellQuote(fifoPath)}
rm -f -- "\${fifo_path}"
mkfifo -m 600 -- "\${fifo_path}"
exec 3<>"\${fifo_path}"
exec ${command} <&3
`
}

export function buildNativeSystemdUnit(
  spec: ShardContainerSpec,
  launcherPath: string,
  consoleLogPath: string,
): string {
  const limits = resolveDstContainerResourceLimits()
  const environment = Object.entries(spec.env ?? {})
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
  const resourceLines: string[] = []
  if (limits?.memory) {
    const maxBytes = Math.max(limits.memory, NATIVE_UNIT_MEMORY_MIN_BYTES)
    resourceLines.push(`MemoryHigh=${Math.floor(maxBytes * NATIVE_UNIT_MEMORY_HIGH_RATIO)}`)
    resourceLines.push(`MemoryMax=${maxBytes}`)
    // 允许分片使用 swap：没有它时 MemoryHigh 触发的回收无处可去，内核只能直接 OOM 杀进程。
    resourceLines.push('MemorySwapMax=infinity')
  }
  const cpuQuotaPercent = limits?.nanoCpus
    ? limits.nanoCpus / 1e7
    : resolveShardCpuQuotaPercent()
  if (cpuQuotaPercent) {
    const clamped = Math.min(NATIVE_UNIT_CPU_QUOTA_MAX_PERCENT, Math.max(1, cpuQuotaPercent))
    resourceLines.push(`CPUQuota=${clamped.toFixed(2)}%`)
  }
  /**
   * 不写 After=/Wants=network-online.target：分片跑在用户级 systemd 里，用户实例没有这个
   * target（依赖只会是 not-found 噪音），DST 分片本身也不需要等网络在线。
   *
   * StartLimit* 用来给崩溃循环踩刹车：进程一崩 systemd 就 5 秒后重来，每次都重新吃满
   * CPU 与磁盘加载整套 Mod，永远到不了「世界加载完成」。10 分钟内超过 3 次就停手，
   * 由面板如实报告失败原因。用户手动启动前会先 reset-failed，正常重启不会撞上限。
   */
  return `[Unit]
Description=Game Server Hub ${escapeSpecifiers(spec.instanceId)} ${spec.shard}
StartLimitIntervalSec=${NATIVE_UNIT_START_LIMIT_INTERVAL_SEC}
StartLimitBurst=${NATIVE_UNIT_START_LIMIT_BURST}

[Service]
Type=simple
WorkingDirectory=${systemdPath(spec.workingDir)}
ExecStart=${systemdQuote(launcherPath)}
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=${NATIVE_UNIT_STOP_TIMEOUT_SEC}
LimitNOFILE=${NATIVE_UNIT_NOFILE_LIMIT}
StandardOutput=append:${systemdPath(consoleLogPath)}
StandardError=append:${systemdPath(consoleLogPath)}
${environment.join('\n')}
${resourceLines.join('\n')}

[Install]
WantedBy=default.target
`
}

export class NativeSystemdRuntime implements ContainerRuntime {
  private readonly options: NativeSystemdRuntimeOptions
  /** unit 路径 → systemd-analyze verify 的输出，仅用于启动失败时的诊断 */
  private readonly unitVerifyOutput = new Map<string, string>()

  constructor(options: NativeSystemdRuntimeOptions) {
    this.options = options
  }

  private unitName(refOrName: ContainerRef | string): string {
    const name = typeof refOrName === 'string' ? refOrName : refOrName.name
    assertSafeServiceName(name)
    return `${name}.service`
  }

  private servicePaths(name: string) {
    assertSafeServiceName(name)
    const serviceDir = path.resolve(this.options.runtimeDir, 'services', name)
    const servicesRoot = path.resolve(this.options.runtimeDir, 'services')
    if (serviceDir !== servicesRoot && !serviceDir.startsWith(`${servicesRoot}${path.sep}`)) {
      throw new Error(`Native 服务路径越界: ${name}`)
    }
    return {
      serviceDir,
      fifoPath: path.join(serviceDir, 'stdin.fifo'),
      launcherPath: path.join(serviceDir, 'launch.sh'),
      unitPath: path.join(this.options.unitDir, `${name}.service`),
      consoleLogPath: path.join(this.options.runtimeDir, 'console-logs', `${name}.log`),
    }
  }

  /** 跑命令并尽量取回输出：systemd-analyze/systemctl 判失败时原因都在 stdout/stderr 里 */
  private async captureOutput(command: string, args: string[], timeoutMs: number): Promise<string | undefined> {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        timeout: timeoutMs,
        windowsHide: true,
      })
      return `${stdout}${stderr}`.trim() || undefined
    }
    catch (error) {
      const partial = error as { stdout?: string, stderr?: string }
      return `${partial.stdout ?? ''}${partial.stderr ?? ''}`.trim() || undefined
    }
  }

  /**
   * 写完 unit 立刻让 systemd 自己校验一次。命令缺失或返回非零都不阻断启动
   * （依赖类 warning 也会返回非零），输出只在启动失败时作为诊断证据给出。
   */
  private async recordUnitVerify(unitPath: string): Promise<void> {
    const output = await this.captureOutput('systemd-analyze', ['verify', unitPath], 15_000)
    if (output) {
      this.unitVerifyOutput.set(unitPath, output)
    }
  }

  private async describeStartFailure(ref: ContainerRef, error: unknown): Promise<string> {
    const message = error instanceof Error ? error.message : String(error)
    const paths = this.servicePaths(ref.name)
    let unitContent: string | undefined
    try {
      unitContent = fs.readFileSync(paths.unitPath, 'utf8')
    }
    catch {
      unitContent = undefined
    }
    const statusOutput = await this.captureOutput(
      'systemctl',
      ['--user', 'status', this.unitName(ref), '--no-pager', '-l'],
      15_000,
    )
    const verifyOutput = this.unitVerifyOutput.get(paths.unitPath)
    const diagnostic = formatUnitLoadDiagnostic({
      unitPath: paths.unitPath,
      ...(unitContent ? { unitContent } : {}),
      ...(verifyOutput ? { verifyOutput } : {}),
      ...(statusOutput ? { statusOutput } : {}),
    })
    return diagnostic ? `${message}\n\n${diagnostic}` : message
  }

  private async systemctl(args: string[]) {
    return execFileAsync('systemctl', ['--user', ...args], {
      timeout: 30_000,
      windowsHide: true,
    })
  }

  async ensureShardNetwork(instanceId: string): Promise<string> {
    return `native-${instanceId}`
  }

  async removeShardNetwork(): Promise<void> {
    // Native 分片在同一宿主机通过 loopback 通信，不需要独立网络对象。
  }

  async createShardContainer(spec: ShardContainerSpec): Promise<ContainerRef> {
    assertSafeServiceName(spec.name)
    if (!path.isAbsolute(spec.cmd[0] ?? '')) {
      throw new Error('Native 游戏可执行文件必须使用绝对路径')
    }
    const paths = this.servicePaths(spec.name)
    fs.mkdirSync(paths.serviceDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(this.options.unitDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(path.dirname(paths.consoleLogPath), { recursive: true, mode: 0o700 })
    rotateConsoleLogFile(paths.consoleLogPath)
    writeFileAtomic(paths.launcherPath, buildNativeLauncherScript(spec, paths.fifoPath), 0o700)
    writeFileAtomic(paths.unitPath, buildNativeSystemdUnit(spec, paths.launcherPath, paths.consoleLogPath), 0o600)
    await this.recordUnitVerify(paths.unitPath)
    await this.systemctl(['daemon-reload'])
    return {
      id: this.unitName(spec.name),
      name: spec.name,
    }
  }

  async start(ref: ContainerRef): Promise<void> {
    // 手动启动前先清掉 StartLimit 计数：崩溃循环触发的「不再拉起」不应该连累用户
    // 主动点击的启动，否则重启几次之后实例会拒绝启动，看起来像面板坏了。
    try {
      await this.systemctl(['reset-failed', this.unitName(ref)])
    }
    catch {
      // unit 不存在或未处于 failed 状态时 reset-failed 会报错，忽略即可
    }
    try {
      await this.systemctl(['enable', '--now', this.unitName(ref)])
    }
    catch (error) {
      // systemd 的 "bad unit file setting" 不指出具体哪一行：这里补上 unit 原文与自校验输出
      throw new Error(await this.describeStartFailure(ref, error))
    }
  }

  async stop(ref: ContainerRef, timeoutSec = 10): Promise<void> {
    // 等待上限取「调用方预算 + 5 秒」与「unit 停机预算 + 15 秒」的较大者：
    // 后者保证 systemd 有完整时间收尾，不会在存档落盘途中被判成失败。
    const clientTimeoutMs = Math.max(((timeoutSec ?? 10) + 5) * 1000, NATIVE_STOP_CLIENT_TIMEOUT_MS)
    try {
      await execFileAsync('systemctl', ['--user', 'stop', this.unitName(ref)], {
        timeout: clientTimeoutMs,
        windowsHide: true,
      })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/not loaded|not found/i.test(message)) {
        throw error
      }
    }
  }

  async remove(ref: ContainerRef): Promise<void> {
    // 停止失败不能中断清理：单元若仍处于 enabled，宿主重启时该分片会被 systemd 自动拉起，
    // 与「实例已停止/已删除」的状态完全相反。这里先记下错误，做完清理再抛出。
    let stopError: unknown
    try {
      await this.stop(ref)
    }
    catch (error) {
      stopError = error
    }
    try {
      await this.systemctl(['disable', this.unitName(ref)])
    }
    catch {
      // Unit 可能尚未启用或已被手工清理。
    }
    const paths = this.servicePaths(ref.name)
    for (const filePath of [paths.unitPath, paths.fifoPath, paths.launcherPath]) {
      try {
        fs.unlinkSync(filePath)
      }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') {
          throw error
        }
      }
    }
    this.unitVerifyOutput.delete(paths.unitPath)
    try {
      fs.rmdirSync(paths.serviceDir)
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
        throw error
      }
    }
    await this.systemctl(['daemon-reload'])
    if (stopError) {
      throw stopError
    }
  }

  /**
   * 分片日志读取。
   *
   * 原先走 `journalctl --user-unit`：面板以 gsh 用户跑在系统服务里、不在 systemd-journal
   * 组内，线上必然报 `No journal files were opened due to insufficient permissions`，
   * 控制台一条游戏输出都看不到，排查只能靠 SSH。改为让 systemd 直接追加到分片日志文件后，
   * 面板自己就能读，且日志跨重启累积，上一轮崩溃的现场不会再被覆盖。
   */
  async *logs(ref: ContainerRef, opts: LogOpts = {}): AsyncIterable<LogLine> {
    const { consoleLogPath } = this.servicePaths(ref.name)
    for (const line of readFileTailLines(consoleLogPath, opts.tail ?? 200)) {
      yield { stream: 'stdout', text: line }
    }
    if (!opts.follow || opts.signal?.aborted) {
      return
    }
    let offset = readFileSize(consoleLogPath)
    let carry = ''
    let done = false
    const abort = () => {
      done = true
    }
    opts.signal?.addEventListener('abort', abort, { once: true })
    try {
      while (!done) {
        await sleepMs(NATIVE_LOG_POLL_MS)
        const size = readFileSize(consoleLogPath)
        if (size < offset) {
          // 文件被轮转或截断：从头再读，避免停留在旧 offset 上再也读不到内容
          offset = 0
          carry = ''
        }
        if (size === offset) {
          continue
        }
        const chunk = readFileRange(consoleLogPath, offset, size)
        if (chunk === null) {
          continue
        }
        offset = size
        const parts = `${carry}${chunk}`.split(/\r?\n/)
        carry = parts.pop() ?? ''
        for (const line of parts) {
          if (line.trim()) {
            yield { stream: 'stdout', text: line }
          }
        }
      }
    }
    finally {
      opts.signal?.removeEventListener('abort', abort)
    }
  }

  async exec(): Promise<ExecResult> {
    return {
      exitCode: 1,
      output: 'Native systemd 运行时不支持在游戏进程中执行独立命令',
    }
  }

  async execStdin(ref: ContainerRef, input: string): Promise<ExecResult> {
    const inspect = await this.inspect(ref)
    if (!inspect.running) {
      return { exitCode: 1, output: '实例未运行' }
    }
    const { fifoPath } = this.servicePaths(ref.name)
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)
      fs.writeSync(descriptor, input.endsWith('\n') ? input : `${input}\n`, undefined, 'utf8')
      return { exitCode: 0, output: '' }
    }
    catch (error) {
      return {
        exitCode: 1,
        output: error instanceof Error ? error.message : '无法写入 Native 控制台管道',
      }
    }
    finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor)
      }
    }
  }

  async inspect(ref: ContainerRef): Promise<ContainerInspect> {
    try {
      const { stdout } = await this.systemctl([
        'show',
        this.unitName(ref),
        '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStartTimestamp,ExecMainStartTimestampMonotonic,ControlGroup,MemoryPeak,Result,NRestarts',
      ])
      const properties = parseSystemctlProperties(stdout)
      const state = resolveNativeUnitState(properties)
      const pid = Number(properties.MainPID)
      const memOomKillCount = readCgroupOomKillCount(properties.ControlGroup)
      return {
        id: this.unitName(ref),
        name: ref.name,
        running: state.running,
        ...(state.restarting ? { restarting: true } : {}),
        ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
        ...(properties.ExecMainStartTimestamp ? { startedAt: properties.ExecMainStartTimestamp } : {}),
        ...(state.uptimeSeconds !== undefined ? { uptimeSeconds: state.uptimeSeconds } : {}),
        ...(state.memPeakMb !== undefined ? { memPeakMb: state.memPeakMb } : {}),
        ...(memOomKillCount !== undefined ? { memOomKillCount } : {}),
        ...(state.exitResult ? { exitResult: state.exitResult } : {}),
        ...(state.restarts ? { restarts: state.restarts } : {}),
      }
    }
    catch {
      // 问不到 systemd（user bus 不可达、systemctl 不可用）：这不是「没在运行」，
      // 如实标出来，由调用方保持现状——否则运行中的实例会被对账成已停止。
      return {
        id: this.unitName(ref),
        name: ref.name,
        running: false,
        probeFailed: true,
      }
    }
  }

  async stats(ref: ContainerRef): Promise<ContainerStats> {
    const inspect = await this.inspect(ref)
    const uptimeSeconds = inspect.uptimeSeconds ?? null
    if (!inspect.running || !inspect.pid) {
      return { cpuUsageRate: null, memoryMb: null, uptimeSeconds }
    }
    try {
      const usage = await sampleProcessMetrics(inspect.pid)
      if (!usage) {
        return { cpuUsageRate: null, memoryMb: null, uptimeSeconds }
      }
      return {
        cpuUsageRate: usage.cpuUsageRate,
        memoryMb: usage.memoryMb,
        uptimeSeconds,
      }
    }
    catch {
      return { cpuUsageRate: null, memoryMb: null, uptimeSeconds }
    }
  }

  async findByName(name: string): Promise<ContainerRef | undefined> {
    assertSafeServiceName(name)
    const paths = this.servicePaths(name)
    if (!fs.existsSync(paths.unitPath)) {
      return undefined
    }
    return {
      id: this.unitName(name),
      name,
    }
  }
}
