export type ShardRole = 'master' | 'caves'

export interface ContainerRef {
  id: string
  name: string
  runtimeIdentity?: string
}

export interface PortMapping {
  hostPort: number
  containerPort: number
  protocol: 'udp' | 'tcp'
}

export interface ShardContainerSpec {
  instanceId: string
  shard: ShardRole
  image: string
  name: string
  hostInstallPath: string
  containerGameRoot?: string
  hostBinds?: string[]
  /** 双容器分片互联用的 Docker 自定义网络名 */
  networkName?: string
  cmd: string[]
  workingDir: string
  env?: Record<string, string>
  ports?: PortMapping[]
  resourceLimits?: DstContainerResourceLimits
  /** 经宿主能力核验的父组；兼容部署留空。 */
  memoryParent?: string
}

export interface LogOpts {
  tail?: number
  follow?: boolean
  since?: number
  /** follow 模式下中止信号：abort 时立即销毁底层流，避免连接泄漏 */
  signal?: AbortSignal
}

export interface LogLine {
  stream: 'stdout' | 'stderr'
  text: string
  timestamp?: string
}

export interface ExecResult {
  exitCode: number
  output: string
}

export interface ContainerInspect {
  id: string
  name: string
  running: boolean
  pid?: number
  startedAt?: string
  /**
   * 进程已退出、运行时正在把它拉起来（Native 的 systemd `Restart=` 等待窗口）。
   * 此时 `running` 为 true —— 对上层而言实例仍算在运行中，否则状态会在运行/停止之间来回翻转。
   */
  restarting?: boolean
  /** 上一次退出的原因（Native 取 systemd 的 `Result`：exit-code / signal / oom-kill / timeout…） */
  exitResult?: string
  /** 累计重启次数（Native 取 systemd 的 `NRestarts`）；Docker 运行时不填 */
  restarts?: number
  /**
   * 当前进程已连续运行的秒数。
   *
   * 与 `startedAt` 的区别是它跨运行时可用、且已经换算成时长：区分「正在崩溃循环」与
   * 「启动时崩过一次、之后一直稳跑」只能靠它，`restarts` 是累计值，两者分不开。
   */
  uptimeSeconds?: number
  /**
   * 该单元被 cgroup 按内存上限杀掉的累计次数（cgroup v2 `memory.events` 的 `oom_kill`）。
   *
   * 这是"因内存不足失败"最确凿的证据，而且**进程被自动拉起后计数仍在**——systemd 的
   * `Result` 会在重启成功后重置成 success，光靠它查不出线上那次 OOM。读不到（Docker 模式、
   * cgroup v1、权限不足）时不填，调用方退回推断。
   */
  memOomKillCount?: number
  /** 该单元的内存峰值（MiB，systemd 的 `MemoryPeak`）；读不到时不填 */
  memPeakMb?: number
  /**
   * 探测本身失败（运行时不可达）：此时 `running: false` 只代表「问不到」，
   * 不代表实例真的停了。调用方据此保持现状，而不是把运行中的实例标成已停止。
   */
  probeFailed?: boolean
  exitCode?: number
  oomKilled?: boolean
}

export interface ContainerStats {
  cpuUsageRate: number | null
  memoryMb: number | null
  /** 当前进程已连续运行的秒数；运行时给不出时为 null（调用方据此退回面板记录的启动时刻） */
  uptimeSeconds?: number | null
}

export interface ContainerRuntime {
  hostResources?(): Promise<HostResourceSnapshot>
  emergencyRemove?(ref: ContainerRef): Promise<void>
  resourceSnapshot?(ref: ContainerRef): Promise<RuntimeResourceSnapshot>
  createShardContainer(spec: ShardContainerSpec): Promise<ContainerRef>
  ensureShardNetwork(instanceId: string): Promise<string>
  removeShardNetwork(instanceId: string): Promise<void>
  start(ref: ContainerRef): Promise<void>
  stop(ref: ContainerRef, timeoutSec?: number): Promise<void>
  remove(ref: ContainerRef): Promise<void>
  logs(ref: ContainerRef, opts?: LogOpts): AsyncIterable<LogLine>
  exec(ref: ContainerRef, cmd: string[]): Promise<ExecResult>
  execStdin(ref: ContainerRef, input: string): Promise<ExecResult>
  inspect(ref: ContainerRef): Promise<ContainerInspect>
  stats(ref: ContainerRef): Promise<ContainerStats>
  findByName(name: string): Promise<ContainerRef | undefined>
}
import type { HostResourceSnapshot, ResourceSnapshot } from '../../../../shared/contracts/instance-resources'
import type { DstContainerResourceLimits } from './dst-container-resources'

export type RuntimeResourceSnapshot = ResourceSnapshot
