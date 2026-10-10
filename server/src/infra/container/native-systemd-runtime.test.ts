import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  buildNativeLauncherScript,
  buildNativeSystemdUnit,
  formatUnitLoadDiagnostic,
  NativeSystemdRuntime,
  parseCgroupOomKillCount,
  readFileTailLines,
  readNativeResourceSnapshot,
  resolveNativeUnitState,
  resolveShardCpuQuotaPercent,
  rotateConsoleLogFile,
} from './native-systemd-runtime'
import type { ContainerRef, LogLine, ShardContainerSpec } from './types'
import type { TestContext } from 'node:test'

it('native leaf joins only the explicitly verified shared slice, including unlimited leaf memory', () => {
  const spec: ShardContainerSpec = { instanceId: 'budget', shard: 'master', image: '', name: 'bsp-budget-master', hostInstallPath: '/game', cmd: ['/game/server'], workingDir: '/game', memoryParent: 'bspdst.slice', resourceLimits: { memory: 0 } }
  const unit = buildNativeSystemdUnit(spec, '/launcher', '/console')
  assert.match(unit, /Slice=bspdst\.slice/)
  assert.match(unit, /MemoryAccounting=yes/)
  assert.doesNotMatch(unit, /MemoryMax=/)
  assert.doesNotMatch(buildNativeSystemdUnit({ ...spec, memoryParent: undefined }, '/launcher', '/console'), /Slice=/)
})

it('historical Native OOM counters do not masquerade as the current invocation result', () => {
  const result = readNativeResourceSnapshot({ LoadState: 'loaded', Result: 'success', NRestarts: '0' })
  assert.equal(result.oomKilled, false)
})

it('reads actual cgroup limits, peaks and pressure, preserving unsupported values as null', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-cgroup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const group = path.join(root, 'slice', 'shard')
  fs.mkdirSync(group, { recursive: true })
  for (const [name, content] of Object.entries({
    'memory.current': String(1500 * 1024 * 1024), 'memory.peak': String(2000 * 1024 * 1024),
    'memory.max': String(2560 * 1024 * 1024), 'memory.swap.current': String(300 * 1024 * 1024),
    'memory.swap.max': 'max', 'memory.high': 'max', 'memory.events': 'high 7\nmax 2\noom_kill 0\noom_group_kill 9\n',
    'memory.pressure': 'some avg10=1.10 avg60=0.01\nfull avg10=0.25 avg60=0.00\n', 'cpu.stat': 'throttled_usec 123456\n',
  })) fs.writeFileSync(path.join(group, name), content)
  const snapshot = readNativeResourceSnapshot({ LoadState: 'loaded', ControlGroup: '/slice/shard', ExecMainStatus: '0', NRestarts: '2', Result: 'success' }, root)
  assert.equal(snapshot.memoryCurrentMb, 1500)
  assert.equal(snapshot.memoryPeakMb, 2000)
  assert.equal(snapshot.memoryMaxMb, 2560)
  assert.equal(snapshot.swapCurrentMb, 300)
  assert.equal(snapshot.swapMaxMb, null)
  assert.equal(snapshot.memoryHighMb, null)
  assert.equal(snapshot.highEvents, 7)
  assert.equal(snapshot.maxEvents, 2)
  assert.equal(snapshot.oomKillCount, 0)
  assert.equal(snapshot.oomKilled, false)
  assert.equal(snapshot.memoryPressureFullAvg10, 0.25)
  assert.equal(snapshot.throttledUsec, 123456)
  assert.equal(snapshot.restarts, 2)
  const unavailable = readNativeResourceSnapshot({ LoadState: 'loaded', ControlGroup: '/../../outside', MemoryMax: '18446744073709551615' }, root)
  assert.equal(unavailable.memoryCurrentMb, null)
  assert.equal(unavailable.memoryMaxMb, null)
  assert.equal(unavailable.highEvents, null)
  assert.equal(unavailable.oomKilled, null)
})

it('ignores systemd defaults from missing or unknown units instead of reporting a clean exit', () => {
  for (const LoadState of ['not-found', 'error', undefined]) {
    const snapshot = readNativeResourceSnapshot({ ...(LoadState ? { LoadState } : {}), MemoryCurrent: '0', MemoryMax: 'infinity', MemoryHigh: 'infinity', ExecMainStatus: '0', NRestarts: '0', Result: 'success' })
    for (const [key, value] of Object.entries(snapshot)) {
      if (key !== 'measuredAt') assert.equal(value, null, `${LoadState ?? 'unknown'}: ${key}`)
    }
  }
})

it('queries loaded state and preserves OOM exit evidence without treating a deleted unit as healthy', async (t) => {
  const runtime = new NativeSystemdRuntime({ runtimeDir: '/unused', unitDir: '/unused' })
  const ref = { id: 'bsp-test-master.service', name: 'bsp-test-master' }
  let output = 'LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nExecMainStatus=9\nResult=oom-kill\nNRestarts=0\n'
  const control = runtime as unknown as { systemctl(args: string[]): Promise<{ stdout: string, stderr: string }> }
  t.mock.method(control, 'systemctl', async (args: string[]) => {
    assert.match(args.join(' '), /LoadState/)
    assert.match(args.join(' '), /ExecMainStatus/)
    return { stdout: output, stderr: '' }
  })
  const oom = await runtime.inspect(ref)
  assert.equal(oom.exitResult, 'oom-kill')
  assert.equal(oom.exitCode, 9)
  assert.equal((await runtime.resourceSnapshot(ref)).oomKilled, true)
  output = 'LoadState=not-found\nActiveState=inactive\nExecMainStatus=0\nResult=success\nNRestarts=0\nMemoryMax=infinity\nMemoryHigh=infinity\n'
  const missing = await runtime.inspect(ref)
  assert.equal(missing.running, false)
  assert.equal(missing.exitCode, undefined)
  assert.equal(missing.exitResult, undefined)
  assert.equal((await runtime.resourceSnapshot(ref)).oomKilled, null)
  output = 'Result=success\nExecMainStatus=0\n'
  assert.equal((await runtime.inspect(ref)).probeFailed, true)
})

function buildSpec(): ShardContainerSpec {
  return {
    instanceId: 'instance-1',
    shard: 'master',
    image: '',
    name: 'bsp-instance-1-master',
    hostInstallPath: '/srv/bsp/instance-1',
    cmd: [
      '/srv/bsp/instance-1/bin64/dontstarve_dedicated_server_nullrenderer_x64',
      '-cluster',
      'Cluster 1',
    ],
    workingDir: '/srv/bsp/instance-1/bin64',
    env: {
      LD_LIBRARY_PATH: '/srv/bsp/instance-1/bin64/lib64',
    },
  }
}

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

function nativeOperationFixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-native-operations-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runtimeDir = path.join(root, 'runtime')
  const unitDir = path.join(root, 'units')
  const runtime = new NativeSystemdRuntime({ runtimeDir, unitDir })
  const control = runtime as unknown as {
    recordUnitVerify(unitPath: string): Promise<void>
    stopUnit(ref: ContainerRef): Promise<void>
    systemctl(args: string[]): Promise<{ stdout: string, stderr: string }>
  }
  const commands: string[][] = []
  t.mock.method(control, 'recordUnitVerify', async () => {})
  t.mock.method(control, 'stopUnit', async (ref: ContainerRef) => { commands.push(['stop', ref.name]) })
  t.mock.method(control, 'systemctl', async (args: string[]) => {
    commands.push(args)
    return { stdout: '', stderr: '' }
  })
  const spec = { ...buildSpec(), cmd: [path.join(root, 'game'), 'old-generation'] }
  const paths = (name: string) => ({
    unit: path.join(unitDir, `${name}.service`),
    launcher: path.join(runtimeDir, 'services', name, 'launch.sh'),
    fifo: path.join(runtimeDir, 'services', name, 'stdin.fifo'),
  })
  return { runtime, control, commands, spec, paths }
}

for (const waitingAt of ['stop', 'disable'] as const) {
  it(`serializes a new create after remove has entered its internal ${waitingAt}`, async (t) => {
    const { runtime, control, commands, spec, paths } = nativeOperationFixture(t)
    const oldSpec = waitingAt === 'disable' ? { ...spec, name: spec.name.replace(/^bsp-/, 'gsh-') } : spec
    const oldRef = await runtime.createShardContainer(oldSpec)
    const oldPaths = paths(oldRef.name)
    fs.writeFileSync(oldPaths.fifo, 'old-fifo')
    const entered = gate()
    const proceed = gate()
    t.after(proceed.release)
    if (waitingAt === 'stop') {
      t.mock.method(control, 'stopUnit', async () => {
        entered.release()
        await proceed.promise
      })
    }
    else {
      t.mock.method(control, 'systemctl', async (args: string[]) => {
        commands.push(args)
        if (args[0] === 'disable') {
          entered.release()
          await proceed.promise
        }
        return { stdout: '', stderr: '' }
      })
    }
    const removing = runtime.remove(oldRef)
    await entered.promise
    const creating = runtime.createShardContainer({ ...spec, cmd: [spec.cmd[0]!, 'new-generation'] })
    await Promise.resolve()
    assert.match(fs.readFileSync(oldPaths.launcher, 'utf8'), /old-generation/)
    assert.equal(fs.readFileSync(oldPaths.fifo, 'utf8'), 'old-fifo')
    proceed.release()
    await removing
    const newRef = await creating
    const newPaths = paths(newRef.name)
    fs.writeFileSync(newPaths.fifo, 'new-fifo')
    assert.match(fs.readFileSync(newPaths.launcher, 'utf8'), /new-generation/)
    assert.ok(fs.existsSync(newPaths.unit))
    await runtime.remove(oldRef)
    assert.equal(fs.readFileSync(newPaths.fifo, 'utf8'), 'new-fifo')
  })
}

it('rejects stale lifecycle operations queued behind a new create, including legacy names', async (t) => {
  const { runtime, control, commands, spec, paths } = nativeOperationFixture(t)
  const oldRef = await runtime.createShardContainer({ ...spec, name: spec.name.replace(/^bsp-/, 'gsh-') })
  const entered = gate()
  const proceed = gate()
  t.after(proceed.release)
  t.mock.method(control, 'recordUnitVerify', async () => {
    entered.release()
    await proceed.promise
  })
  commands.length = 0
  const creating = runtime.createShardContainer({ ...spec, cmd: [spec.cmd[0]!, 'new-generation'] })
  await entered.promise
  const removing = runtime.remove(oldRef)
  const stopping = runtime.stop(oldRef)
  const starting = assert.rejects(runtime.start(oldRef), /新的启动任务替换/)
  proceed.release()
  const newRef = await creating
  await Promise.all([removing, stopping, starting])
  assert.equal(newRef.name, oldRef.name)
  assert.deepEqual(commands, [['daemon-reload']])
  assert.match(fs.readFileSync(paths(newRef.name).launcher, 'utf8'), /new-generation/)
  await runtime.remove(oldRef)
  assert.ok(fs.existsSync(paths(newRef.name).unit))
  await runtime.remove(newRef)
  assert.equal(fs.existsSync(paths(newRef.name).unit), false)
  const commandCount = commands.length
  await runtime.remove(newRef)
  assert.equal(commands.length, commandCount)
})

it('refuses an unregistered reference to an existing unit while allowing missing-unit cleanup', async (t) => {
  const { runtime, commands, spec, paths } = nativeOperationFixture(t)
  const ref = await runtime.createShardContainer(spec)
  const clone = { ...ref }
  commands.length = 0
  await assert.rejects(runtime.remove(clone), /重新查询当前分片/)
  await assert.rejects(runtime.stop(clone), /重新查询当前分片/)
  await assert.rejects(runtime.start(clone), /重新查询当前分片/)
  assert.deepEqual(commands, [])
  assert.ok(fs.existsSync(paths(ref.name).unit))
  const resolved = await runtime.findByName(ref.name)
  assert.ok(resolved)
  await runtime.remove(resolved)
  await runtime.remove({ ...ref })
  assert.equal(fs.existsSync(paths(ref.name).unit), false)
})

const RESOURCE_ENV_KEYS = ['BSP_DST_CONTAINER_MEMORY_MB', 'BSP_DST_CONTAINER_CPU_QUOTA'] as const
const savedEnv = new Map<string, string | undefined>()

afterEach(() => {
  for (const key of RESOURCE_ENV_KEYS) {
    const previous = savedEnv.get(key)
    if (previous === undefined) {
      delete process.env[key]
    }
    else {
      process.env[key] = previous
    }
  }
  savedEnv.clear()
})

function setResourceEnv(key: typeof RESOURCE_ENV_KEYS[number], value: string) {
  if (!savedEnv.has(key)) {
    savedEnv.set(key, process.env[key])
  }
  process.env[key] = value
}

function clearResourceEnv() {
  for (const key of RESOURCE_ENV_KEYS) {
    if (!savedEnv.has(key)) {
      savedEnv.set(key, process.env[key])
    }
    delete process.env[key]
  }
}

const LAUNCHER = '/srv/bsp/runtime/launch.sh'
const CONSOLE_LOG = '/srv/bsp/runtime/console-logs/shard.log'

describe('NativeSystemdRuntime serialization', () => {
  it('quotes launcher arguments and feeds stdin from a FIFO', () => {
    const script = buildNativeLauncherScript(buildSpec(), '/srv/bsp/runtime/stdin.fifo')
    assert.match(script, /mkfifo -m 600/)
    assert.match(script, /'Cluster 1'/)
    assert.match(script, /<&3/)
  })

  /**
   * 回归：原先分片输出走 journald，而面板以 bsp 用户跑在系统服务里、不在 systemd-journal
   * 组内，线上必然报「No journal files were opened due to insufficient permissions」，
   * 控制台一条游戏输出都看不到，排查只能靠 SSH。改为追加到面板自己可读的文件。
   */
  it('appends stdout and stderr to a file the panel can always read', () => {
    const unit = buildNativeSystemdUnit(buildSpec(), LAUNCHER, CONSOLE_LOG)
    assert.match(unit, /Restart=on-failure/)
    assert.match(unit, /StandardOutput=append:\/srv\/bsp\/runtime\/console-logs\/shard\.log/)
    assert.match(unit, /StandardError=append:\/srv\/bsp\/runtime\/console-logs\/shard\.log/)
    assert.doesNotMatch(unit, /StandardOutput=journal/)
    assert.match(unit, /Environment="LD_LIBRARY_PATH=/)
    assert.match(unit, /WantedBy=default\.target/)
  })

  /**
   * 回归：进程一崩 systemd 就 5 秒后重来，每次都重新吃满 CPU 与磁盘加载整套 Mod，
   * 永远到不了「世界加载完成」。必须给崩溃循环踩刹车，并保留内存硬限与 swap 支持。
   * 不自动设置更低的 MemoryHigh，避免多 Mod 世界在宿主机仍有空闲内存时被强制回收拖住。
   */
  it('bounds the restart storm and preserves the memory cap without an implicit throttle', () => {
    setResourceEnv('BSP_DST_CONTAINER_MEMORY_MB', '2048')
    const unit = buildNativeSystemdUnit(buildSpec(), LAUNCHER, CONSOLE_LOG)
    assert.match(unit, /StartLimitBurst=3/)
    assert.match(unit, /StartLimitIntervalSec=600/)
    assert.doesNotMatch(unit, /^MemoryHigh=/m)
    assert.match(unit, /MemoryMax=2147483648/)
    assert.match(unit, /MemorySwapMax=infinity/)
  })

  // 回归：客户端等待曾短于 unit 的停机预算，DST 存盘途中被判失败，remove 中断后
  // disable 未执行，宿主重启时该分片会被 systemd 自行拉起。
  it('gives the unit enough time to stop and a raised file descriptor limit', () => {
    const unit = buildNativeSystemdUnit(buildSpec(), LAUNCHER, CONSOLE_LOG)
    assert.match(unit, /TimeoutStopSec=30/)
    assert.match(unit, /LimitNOFILE=65535/)
  })

  it('wires DST resource limits from the environment into the unit', () => {
    setResourceEnv('BSP_DST_CONTAINER_MEMORY_MB', '1536')
    setResourceEnv('BSP_DST_CONTAINER_CPU_QUOTA', '1.5')
    const unit = buildNativeSystemdUnit(buildSpec(), LAUNCHER, CONSOLE_LOG)
    assert.match(unit, /MemoryMax=1610612736/)
    assert.match(unit, /MemorySwapMax=infinity/)
    assert.doesNotMatch(unit, /^MemoryHigh=/m)
    assert.match(unit, /CPUQuota=150\.00%/)
  })

  it('applies per-shard memory overrides while preserving CPU, including explicit unlimited settings', () => {
    setResourceEnv('BSP_DST_CONTAINER_MEMORY_MB', '4096')
    setResourceEnv('BSP_DST_CONTAINER_CPU_QUOTA', '1.5')
    const limited = buildNativeSystemdUnit({ ...buildSpec(), resourceLimits: { memory: 2048 * 1024 * 1024 } }, LAUNCHER, CONSOLE_LOG)
    assert.match(limited, /MemoryMax=2147483648/)
    assert.match(limited, /CPUQuota=150\.00%/)
    assert.match(limited, /MemorySwapMax=infinity/)
    assert.doesNotMatch(limited, /MemoryHigh=/)
    const unlimited = buildNativeSystemdUnit({ ...buildSpec(), resourceLimits: { memory: 0 } }, LAUNCHER, CONSOLE_LOG)
    assert.doesNotMatch(unlimited, /MemoryMax=/)
    setResourceEnv('BSP_DST_CONTAINER_CPU_QUOTA', '0')
    assert.doesNotMatch(buildNativeSystemdUnit(buildSpec(), LAUNCHER, CONSOLE_LOG), /CPUQuota=/)
  })

  it('omits the memory cap when the variable is unset but still reserves CPU for the panel', () => {
    clearResourceEnv()
    const unit = buildNativeSystemdUnit(buildSpec(), LAUNCHER, CONSOLE_LOG)
    assert.doesNotMatch(unit, /MemoryMax=/)
    // 未显式配置 CPU 配额时也要留出余量：两个分片各占满一个核时，2 核机上
    // 面板与 sshd 会一起饿死（线上实测面板出现过 69 秒完全无日志的静默期）。
    assert.match(unit, /CPUQuota=\d+\.\d{2}%/)
  })

  // 回归：systemd 对 WorkingDirectory= 不做去引号处理，写 `"/path"` 会被判成
  // "path is not absolute" → `has a bad unit file setting`，Native 下实例一个都起不来。
  it('writes WorkingDirectory without quotes', () => {
    const unit = buildNativeSystemdUnit(buildSpec(), LAUNCHER, CONSOLE_LOG)
    assert.match(unit, /^WorkingDirectory=\/srv\/bsp\/instance-1\/bin64$/m)
    assert.doesNotMatch(unit, /WorkingDirectory="/)
  })

  // 回归：路径里的裸 % 会被 systemd 当成 specifier 展开，整个 unit 被判非法，
  // systemctl 只回一句 "has a bad unit file setting"，现场无法定位。
  it('escapes percent signs in the values systemd expands', () => {
    const spec = buildSpec()
    spec.workingDir = '/srv/bsp/room%1/bin64'
    spec.cmd = ['/srv/bsp/room%1/bin64/dontstarve_dedicated_server_nullrenderer_x64', '-cluster', 'Cluster_1']
    const unit = buildNativeSystemdUnit(spec, '/srv/bsp/room%1/launch.sh', CONSOLE_LOG)
    assert.match(unit, /^WorkingDirectory=\/srv\/bsp\/room%%1\/bin64$/m)
    assert.match(unit, /ExecStart="\/srv\/bsp\/room%%1\/launch\.sh"/)
    assert.doesNotMatch(unit, /room%1/)
  })

  it('clamps out-of-range resource limits instead of writing an invalid unit', () => {
    setResourceEnv('BSP_DST_CONTAINER_MEMORY_MB', '1536')
    setResourceEnv('BSP_DST_CONTAINER_CPU_QUOTA', '200')
    const unit = buildNativeSystemdUnit(buildSpec(), LAUNCHER, CONSOLE_LOG)
    assert.match(unit, /MemoryMax=1610612736/)
    assert.match(unit, /CPUQuota=10000\.00%/)
  })

  it('does not wait on network-online.target, which no user instance provides', () => {
    const unit = buildNativeSystemdUnit(buildSpec(), LAUNCHER, CONSOLE_LOG)
    assert.doesNotMatch(unit, /network-online\.target/)
  })

  it('collects the evidence systemd hides behind a bad unit file setting', () => {
    const diagnostic = formatUnitLoadDiagnostic({
      unitPath: '/srv/bsp/unit.service',
      unitContent: '[Service]\nWorkingDirectory="x"\n',
      verifyOutput: '/srv/bsp/unit.service:2: Invalid setting\n',
      statusOutput: 'Loaded: bad-setting\n',
    })
    assert.match(diagnostic, /systemd-analyze verify：/)
    assert.match(diagnostic, /Invalid setting/)
    assert.match(diagnostic, /unit 文件内容（\/srv\/bsp\/unit\.service）/)
  })

  it('truncates oversized diagnostics', () => {
    const diagnostic = formatUnitLoadDiagnostic({
      unitPath: '/srv/bsp/unit.service',
      unitContent: 'x'.repeat(5000),
    })
    assert.match(diagnostic, /已截断/)
  })
})

describe('resolveNativeUnitState', () => {
  it('treats an active unit as running', () => {
    const state = resolveNativeUnitState({ LoadState: 'loaded', ActiveState: 'active', SubState: 'running' })
    assert.equal(state.running, true)
    assert.equal(state.restarting, false)
    assert.equal(state.exitResult, undefined)
    assert.equal(state.restarts, undefined)
  })

  it('treats the restart window as running instead of stopping the instance', () => {
    // Restart=on-failure + RestartSec=5 期间单元是 activating/auto-restart：
    // 报成「已停止」会让实例状态在运行与停止之间来回跳。
    const state = resolveNativeUnitState({
      LoadState: 'loaded',
      ActiveState: 'activating',
      SubState: 'auto-restart',
    })
    assert.equal(state.running, true)
    assert.equal(state.restarting, true)
  })

  it('reports a unit that really stopped as not running', () => {
    assert.equal(resolveNativeUnitState({ ActiveState: 'inactive', SubState: 'dead' }).running, false)
    assert.equal(resolveNativeUnitState({ ActiveState: 'failed', SubState: 'failed' }).running, false)
    assert.equal(resolveNativeUnitState({ LoadState: 'not-found', ActiveState: 'inactive' }).running, false)
    assert.equal(resolveNativeUnitState({}).running, false)
  })

  it('carries the exit reason and restart count back to the caller', () => {
    const state = resolveNativeUnitState({
      LoadState: 'loaded',
      ActiveState: 'active',
      SubState: 'running',
      Result: 'oom-kill',
      NRestarts: '3',
    })
    assert.equal(state.exitResult, 'oom-kill')
    assert.equal(state.restarts, 3)
  })

  it('omits a clean exit result and a zero restart count', () => {
    const state = resolveNativeUnitState({ ActiveState: 'active', SubState: 'running', Result: 'success', NRestarts: '0' })
    assert.equal(state.exitResult, undefined)
    assert.equal(state.restarts, undefined)
  })

  it('换算当前进程已连续运行的秒数（monotonic 与系统 uptime 相减）', () => {
    // 只用 systemd 的 monotonic 启动时刻：ExecMainStartTimestamp 是 `Thu 2026-10-02 09:15:32 CST`
    // 这种带本地时区缩写的文本，按它解析会把时长整体算偏。
    const state = resolveNativeUnitState({
      LoadState: 'loaded',
      ActiveState: 'active',
      SubState: 'running',
      NRestarts: '1',
      ExecMainStartTimestampMonotonic: '1500000000',
    }, 2000)
    assert.equal(state.uptimeSeconds, 500)
  })

  it('单元从未启动过时不给出运行时长，让调用方退回旧口径', () => {
    const state = resolveNativeUnitState({
      ActiveState: 'inactive',
      SubState: 'dead',
      ExecMainStartTimestampMonotonic: '0',
    }, 2000)
    assert.equal(state.uptimeSeconds, undefined)
  })

  it('把 MemoryPeak 字节换算成 MiB（systemd 249+ 才有该属性）', () => {
    const state = resolveNativeUnitState({
      LoadState: 'loaded',
      ActiveState: 'active',
      SubState: 'running',
      MemoryPeak: '1610612736',
    })
    assert.equal(state.memPeakMb, 1536)
  })

  it('没有 MemoryPeak 属性时不编造峰值', () => {
    const state = resolveNativeUnitState({ LoadState: 'loaded', ActiveState: 'active', SubState: 'running' })
    assert.equal(state.memPeakMb, undefined)
  })
})

/**
 * 线上故障的定案证据就是这行：`Memory cgroup out of memory: Killed process …`。
 * `memory.events` 里的计数在进程被自动拉起后仍然保留，而 systemd 的 `Result` 会被重置成
 * success——归因「是不是内存问题」只能靠它。
 */
describe('parseCgroupOomKillCount', () => {
  it('取出 oom_kill 计数', () => {
    const text = ['low 0', 'high 0', 'max 12', 'oom 0', 'oom_kill 3', 'oom_group_kill 0', ''].join('\n')
    assert.equal(parseCgroupOomKillCount(text), 3)
  })

  it('不能把 oom_group_kill 当成 oom_kill（子串匹配会张冠李戴）', () => {
    const text = ['max 0', 'oom 0', 'oom_group_kill 7', ''].join('\n')
    assert.equal(parseCgroupOomKillCount(text), undefined)
  })

  it('计数为 0 时按 0 返回，由调用方判断是否算证据', () => {
    assert.equal(parseCgroupOomKillCount('oom_kill 0\n'), 0)
  })

  it('格式不认识时返回 undefined，不猜', () => {
    assert.equal(parseCgroupOomKillCount(''), undefined)
    assert.equal(parseCgroupOomKillCount('max 12'), undefined)
  })
})

/**
 * 两个 DST 分片各占满一个核时，2 核机上一点余量都不剩，面板与 sshd 会一起饿死
 * （线上实测面板出现过 69 秒完全无日志的静默期）。配额必须给面板留出 CPU。
 */
describe('resolveShardCpuQuotaPercent', () => {
  it('2 核机给两个分片各 90%，留出 0.2 核给面板与 sshd', () => {
    assert.equal(resolveShardCpuQuotaPercent(2), 90)
  })

  it('核数越多单分片配额越高', () => {
    assert.equal(resolveShardCpuQuotaPercent(8), 390)
  })

  it('核数异常时不下发配额', () => {
    assert.equal(resolveShardCpuQuotaPercent(0), undefined)
    assert.equal(resolveShardCpuQuotaPercent(-1), undefined)
  })
})

describe('readFileTailLines', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function writeLog(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-log-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'shard.log')
    fs.writeFileSync(filePath, content)
    return filePath
  }

  it('只取最后 N 行并丢掉空行', () => {
    const filePath = writeLog('a\n\nb\nc\n')
    assert.deepEqual(readFileTailLines(filePath, 2), ['b', 'c'])
  })

  it('文件不存在时返回空数组而不是抛错', () => {
    assert.deepEqual(readFileTailLines('/nonexistent/bsp/shard.log', 10), [])
  })

  it('空文件返回空数组', () => {
    assert.deepEqual(readFileTailLines(writeLog(''), 10), [])
  })
})

/**
 * 分片日志跨重启累积（systemd `append:`），而控制台的日志跟随在启动时会先吐文件尾部 100 行。
 * 不轮转的话，新实例一启动就先显示上一轮的输出，而且那 100 行里的就绪标记是上一轮的——
 * 若上一轮进程尚未完全退出、分片端口仍被占用，就绪判定会据此在 t≈0 就放行洞穴。
 */
describe('rotateConsoleLogFile', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function writeLog(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-rotate-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, 'shard.log')
    fs.writeFileSync(filePath, content)
    return filePath
  }

  it('把上一轮内容挪到 .prev.log，本轮从空文件开始', () => {
    const filePath = writeLog('上一轮的输出\n[Shard] Shard server started on port: 10888\n')
    rotateConsoleLogFile(filePath)
    assert.equal(fs.existsSync(filePath), false, '原文件应被挪走，好让 systemd 重新创建')
    assert.equal(
      fs.readFileSync(`${filePath}.prev.log`, 'utf8'),
      '上一轮的输出\n[Shard] Shard server started on port: 10888\n',
    )
  })

  it('文件不存在时不抛错', () => {
    rotateConsoleLogFile(path.join(os.tmpdir(), `bsp-missing-${Date.now()}`, 'shard.log'))
  })

  it('空文件不产生 .prev.log', () => {
    const filePath = writeLog('')
    rotateConsoleLogFile(filePath)
    assert.equal(fs.existsSync(`${filePath}.prev.log`), false)
  })

  it('重复轮转时覆盖上一份 .prev.log，不会堆出一串备份', () => {
    const filePath = writeLog('第一轮\n')
    rotateConsoleLogFile(filePath)
    fs.writeFileSync(filePath, '第二轮\n')
    rotateConsoleLogFile(filePath)
    assert.equal(fs.readFileSync(`${filePath}.prev.log`, 'utf8'), '第二轮\n')
  })
})

/** 把 unit 拆成 { section: { key: value } }，用来断言指令落在哪个分区 */
function parseUnitSections(unit: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let current = ''
  for (const rawLine of unit.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      current = header[1]!
      sections[current] = {}
      continue
    }
    const separator = line.indexOf('=')
    if (separator <= 0 || !current) {
      continue
    }
    sections[current]![line.slice(0, separator)] = line.slice(separator + 1)
  }
  return sections
}

/**
 * systemd 对指令分区极其严格：把 [Service] 的指令写进 [Unit]（或反过来）会让**整个**
 * unit 被判非法，`systemctl start` 只回一句 "has a bad unit file setting"，Native 下
 * 实例一个都起不来，而现场完全看不出是哪一行的问题。
 *
 * 已用 Debian 12 自带的 systemd 252 跑过 `systemd-analyze verify`，确认当前 unit 无语法
 * 错误；这里把分区固化下来，避免以后挪动指令时无人察觉。
 */
describe('生成的 unit 指令落在正确分区', () => {
  it('资源与重启限制都在 systemd 要求的 section 里', () => {
    setResourceEnv('BSP_DST_CONTAINER_MEMORY_MB', '2048')
    const sections = parseUnitSections(buildNativeSystemdUnit(buildSpec(), LAUNCHER, CONSOLE_LOG))
    for (const key of ['Description', 'StartLimitIntervalSec', 'StartLimitBurst']) {
      assert.ok(key in (sections.Unit ?? {}), `${key} 应写在 [Unit]`)
    }
    for (const key of [
      'Type',
      'WorkingDirectory',
      'ExecStart',
      'Restart',
      'RestartSec',
      'KillMode',
      'TimeoutStopSec',
      'LimitNOFILE',
      'StandardOutput',
      'StandardError',
      'Environment',
      'MemoryMax',
      'MemorySwapMax',
      'CPUQuota',
    ]) {
      assert.ok(key in (sections.Service ?? {}), `${key} 应写在 [Service]`)
    }
    assert.equal(sections.Service?.MemoryHigh, undefined)
    assert.ok('WantedBy' in (sections.Install ?? {}), 'WantedBy 应写在 [Install]')
  })

  it('标准输出与错误落到同一个面板可读的日志文件', () => {
    const sections = parseUnitSections(buildNativeSystemdUnit(buildSpec(), LAUNCHER, CONSOLE_LOG))
    assert.equal(sections.Service!.StandardOutput, `append:${CONSOLE_LOG}`)
    assert.equal(sections.Service!.StandardError, `append:${CONSOLE_LOG}`)
  })
})

async function collectLines(iterable: AsyncIterable<LogLine>): Promise<string[]> {
  const out: string[] = []
  for await (const line of iterable) {
    out.push(line.text)
  }
  return out
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('等待条件超时')
}

/**
 * 分片日志是面板控制台的唯一来源，也是「不用再 SSH 才能看到游戏输出」的全部依赖。
 *
 * 线上原先走 `journalctl --user-unit`，而面板以 bsp 用户跑在系统服务里、不在
 * systemd-journal 组内，必然报权限不足——控制台一条游戏输出都没有。改成直接读
 * systemd 追加的日志文件后，这段跟随逻辑就成了关键路径，必须有测试兜住。
 */
describe('NativeSystemdRuntime.logs 读取分片日志文件', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function setup() {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-native-logs-'))
    tempDirs.push(runtimeDir)
    const runtime = new NativeSystemdRuntime({
      runtimeDir,
      unitDir: path.join(runtimeDir, 'units'),
    })
    const ref: ContainerRef = { id: 'bsp-test-master.service', name: 'bsp-test-master' }
    const logPath = path.join(runtimeDir, 'console-logs', 'bsp-test-master.log')
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    return { runtime, ref, logPath }
  }

  it('日志文件不存在时返回空而不是抛错', async () => {
    const { runtime, ref } = setup()
    assert.deepEqual(await collectLines(runtime.logs(ref, { tail: 10 })), [])
  })

  it('非跟随模式只取最后 N 行，并跳过空行', async () => {
    const { runtime, ref, logPath } = setup()
    fs.writeFileSync(logPath, 'one\n\ntwo\nthree\n')
    assert.deepEqual(await collectLines(runtime.logs(ref, { tail: 2 })), ['two', 'three'])
  })

  it('跟随模式先吐出已有尾部，再增量吐出追加内容', async () => {
    const { runtime, ref, logPath } = setup()
    fs.writeFileSync(logPath, 'first\n')
    const controller = new AbortController()
    const seen: string[] = []
    const task = (async () => {
      for await (const line of runtime.logs(ref, { follow: true, tail: 1, signal: controller.signal })) {
        seen.push(line.text)
      }
    })()
    await waitUntil(() => seen.length >= 1)
    fs.appendFileSync(logPath, 'second\n')
    await waitUntil(() => seen.length >= 2)
    controller.abort()
    await task
    assert.deepEqual(seen, ['first', 'second'])
  })

  it('日志被轮转或截断后从文件头重新读取', async () => {
    const { runtime, ref, logPath } = setup()
    fs.writeFileSync(logPath, 'before-rotation\n')
    const controller = new AbortController()
    const seen: string[] = []
    const task = (async () => {
      for await (const line of runtime.logs(ref, { follow: true, tail: 1, signal: controller.signal })) {
        seen.push(line.text)
      }
    })()
    await waitUntil(() => seen.length >= 1)
    // 模拟 createShardContainer 的轮转：文件被换小，旧 offset 已经越过文件末尾
    fs.writeFileSync(logPath, 'after\n')
    await waitUntil(() => seen.length >= 2)
    controller.abort()
    await task
    assert.deepEqual(seen, ['before-rotation', 'after'])
  })

  it('已经 abort 的 signal 不会再启动跟随', async () => {
    const { runtime, ref, logPath } = setup()
    fs.writeFileSync(logPath, 'boot\n')
    const controller = new AbortController()
    controller.abort()
    const seen = await collectLines(runtime.logs(ref, { follow: true, tail: 1, signal: controller.signal }))
    assert.deepEqual(seen, ['boot'])
  })
})
