import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { resolveDockerStatus } from '../../infra/docker.ts'
import type { ContainerRef } from '../../infra/container/types.ts'
import { isSteamcmdImagePresent } from '../../infra/container/steamcmd-runner.ts'
import { resolveShardRoot } from '../../infra/game-adapter/dst/shard-layout.ts'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store.ts'
import {
  bumpCavesStartGeneration,
  classifyMasterProbe,
  ensureContainerRuntimeReady,
  hasMasterReadyMarker,
  isCurrentCavesStartGeneration,
  isHealthyRuntimeForResurrect,
  isShardPortBound,
  readClusterMasterPort,
  resolveShardReadyWaitSec,
  summarizeLoadedMods,
  waitForMasterShardReady,
} from './container-lifecycle.ts'

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-lifecycle-'))
  tempDirs.push(dir)
  return dir
}

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('ensureContainerRuntimeReady', () => {
  it('returns ok=false with message when Docker is stopped', async () => {
    if ((await resolveDockerStatus()) === 'running') {
      return
    }
    const result = await ensureContainerRuntimeReady()
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /Docker/)
  })

  /**
   * 这一条在有 Docker、但没有本地 SteamCMD 镜像的开发机上会变成一次真实的镜像拉取：
   * `ensureContainerRuntimeReady()` 走完 Docker 探测后调用 `ensureSteamcmdImage()`，
   * 后者按候选仓库重试拉取，在拉不动镜像的网络里会长时间挂住（实测让整个 test:unit 卡死，
   * 且看不到任何输出）。单测不该联网，因此这里以「镜像已在本地」为前置条件，
   * 不满足就跳过——镜像存在时这条路径依然是真实走通的。
   */
  it('returns structured readiness result', async (t) => {
    if (!(await isSteamcmdImagePresent())) {
      t.skip('本地没有 SteamCMD 镜像，跳过：这条路径会触发真实拉取')
      return
    }
    const result = await ensureContainerRuntimeReady()
    assert.equal(typeof result.ok, 'boolean')
    if (!result.ok) {
      assert.ok(result.message && result.message.length > 0)
    }
  })
})

/**
 * 回归：systemd `Restart=on-failure` + `RestartSec=5` 期间单元是 activating/auto-restart。
 * 状态对账的第二趟若把它当成「容器还在跑」而翻回运行中，就会抹掉上一趟刚写入的崩溃告警
 * ——线上实测同一个请求里两趟互相覆盖，「主世界已停止但洞穴仍在运行」写入一秒后就消失，
 * 服主永远看不到。
 */
describe('isHealthyRuntimeForResurrect', () => {
  it('拒绝把自动拉起窗口里的分片当成健康运行', () => {
    assert.equal(isHealthyRuntimeForResurrect({
      id: 'bsp-x-master.service',
      name: 'bsp-x-master',
      running: true,
      restarting: true,
      exitResult: 'oom-kill',
    }), false)
  })

  it('拒绝把已经重启过的分片重新标成运行中', () => {
    assert.equal(isHealthyRuntimeForResurrect({
      id: 'bsp-x-master.service',
      name: 'bsp-x-master',
      running: true,
      restarts: 2,
    }), false)
  })

  it('接受真正在跑且没重启过的分片', () => {
    assert.equal(isHealthyRuntimeForResurrect({
      id: 'bsp-x-master.service',
      name: 'bsp-x-master',
      running: true,
    }), true)
  })

  it('探测不到运行时时不复活实例', () => {
    assert.equal(isHealthyRuntimeForResurrect(null), false)
    assert.equal(isHealthyRuntimeForResurrect({
      id: 'bsp-x-master.service',
      name: 'bsp-x-master',
      running: false,
      probeFailed: true,
    }), false)
  })
})

/**
 * 等待主世界就绪期间的判决。
 *
 * 关键回归：`Restart=on-failure` 的重启窗口里单元仍算「在运行」。若只看 running，
 * 主世界崩溃循环时会被判成「还活着」，白等满 300 秒上限后照样把洞穴拉起来占内存
 * ——这正是线上「洞穴单独在跑、主世界反复重启」的成因。
 */
describe('classifyMasterProbe', () => {
  it('把重启窗口里的主世界判成崩溃循环而不是还活着', () => {
    assert.equal(classifyMasterProbe({
      id: 'bsp-x-master.service',
      name: 'bsp-x-master',
      running: true,
      restarting: true,
    }), 'restart-loop')
  })

  it('把我们启动之后又崩过的主世界判成崩溃循环', () => {
    assert.equal(classifyMasterProbe({
      id: 'bsp-x-master.service',
      name: 'bsp-x-master',
      running: true,
      restarts: 3,
      exitResult: 'oom-kill',
    }, 1), 'restart-loop')
  })

  /**
   * 关键：重启计数与「本次启动时的基线」比较，而不是与 0 比较。
   * systemd 是否在显式启动时清零 `NRestarts` 是实现细节，赌错一次就会让每次正常启动
   * 都被误判成崩溃循环而中止。
   */
  it('沿用历史重启计数不算崩溃（基线之上的才算）', () => {
    assert.equal(classifyMasterProbe({
      id: 'bsp-x-master.service',
      name: 'bsp-x-master',
      running: true,
      restarts: 5,
    }, 5), 'healthy')
  })

  it('基线为 0 时任何非零重启计数都算崩溃', () => {
    assert.equal(classifyMasterProbe({
      id: 'bsp-x-master.service',
      name: 'bsp-x-master',
      running: true,
      restarts: 1,
    }), 'restart-loop')
  })

  it('把真正在跑的主世界判成健康', () => {
    assert.equal(classifyMasterProbe({
      id: 'bsp-x-master.service',
      name: 'bsp-x-master',
      running: true,
    }), 'healthy')
  })

  it('把已停止的主世界判成退出', () => {
    assert.equal(classifyMasterProbe({
      id: 'bsp-x-master.service',
      name: 'bsp-x-master',
      running: false,
      exitResult: 'oom-kill',
    }), 'stopped')
  })

  it('问不到运行时只算未知，不能误判成崩溃', () => {
    assert.equal(classifyMasterProbe(null), 'unknown')
  })
})

/**
 * 后台等主世界就绪可能好几分钟，这期间用户完全可能又点了一次停止或重新启动。
 * 旧任务若不作废，就会在实例已经停机之后把洞穴拉起来，并挂上一个再也停不掉的日志跟随。
 */
describe('洞穴启动代号', () => {
  it('停止或重新启动会让等待中的任务作废', () => {
    const instanceId = 'instance-gen-1'
    const first = bumpCavesStartGeneration(instanceId)
    assert.equal(isCurrentCavesStartGeneration(instanceId, first), true)
    const second = bumpCavesStartGeneration(instanceId)
    assert.equal(isCurrentCavesStartGeneration(instanceId, first), false)
    assert.equal(isCurrentCavesStartGeneration(instanceId, second), true)
  })

  it('从未启动过的实例没有任何代号算当前', () => {
    assert.equal(isCurrentCavesStartGeneration('instance-gen-never-started', 1), false)
    assert.equal(isCurrentCavesStartGeneration('instance-gen-never-started', 0), true)
  })
})

describe('resolveShardReadyWaitSec', () => {  const original = process.env.BSP_SHARD_READY_WAIT_SEC
  afterEach(() => {
    if (original === undefined) {
      delete process.env.BSP_SHARD_READY_WAIT_SEC
    }
    else {
      process.env.BSP_SHARD_READY_WAIT_SEC = original
    }
  })

  /**
   * 上限必须给足：36 个 Mod 的分片在 2 核机上冷启动要两分多钟。
   * 等不够就放洞穴进来，两个加载峰值会重新叠在一起——正是被 OOM 杀掉的那次。
   */
  it('默认上限足以覆盖多 Mod 分片的冷启动', () => {
    delete process.env.BSP_SHARD_READY_WAIT_SEC
    assert.ok(resolveShardReadyWaitSec() >= 600)
  })

  it('允许用环境变量覆盖', () => {
    process.env.BSP_SHARD_READY_WAIT_SEC = '1200'
    assert.equal(resolveShardReadyWaitSec(), 1200)
  })

  it('非法值退回默认上限', () => {
    process.env.BSP_SHARD_READY_WAIT_SEC = 'abc'
    assert.ok(resolveShardReadyWaitSec() >= 600)
    process.env.BSP_SHARD_READY_WAIT_SEC = '-5'
    assert.ok(resolveShardReadyWaitSec() >= 600)
  })
})

async function bindUdpPort(): Promise<{ port: number, close: () => void }> {
  const socket = dgram.createSocket('udp4')
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '0.0.0.0', () => resolve())
  })
  return { port: socket.address().port, close: () => socket.close() }
}

/**
 * 回归：DST 的端口全是 UDP。此处原先用 TCP `net.connect` 探测分片端口，
 * TCP 连一个只监听 UDP 的端口会被内核直接回 RST，探测永远返回 false——
 * 线上表现为「房间已经能进、控制台却一路报主世界仍在加载」，
 * 直到 900 秒超时兜底才启动洞穴（洞穴因此白等 15 分钟）。
 *
 * 下面第一个用例在旧实现下必然失败：UDP 端口已被占用，TCP 探测却会返回 false。
 */
describe('isShardPortBound', () => {
  it('UDP 端口被占用时判定为已绑定', async () => {
    const held = await bindUdpPort()
    try {
      assert.equal(await isShardPortBound(held.port), true)
    }
    finally {
      held.close()
    }
  })

  it('端口空闲时判定为未绑定', async () => {
    const probe = await bindUdpPort()
    const port = probe.port
    probe.close()
    assert.equal(await isShardPortBound(port), false)
  })
})

describe('hasMasterReadyMarker', () => {
  function freshInstanceId(): string {
    return `inst-marker-${Date.now()}-${Math.round(Math.random() * 1e6)}`
  }

  /** 用户服务器上主世界日志的真实片段：世界加载完成、分片端口已在监听 */
  const REAL_MASTER_READY_LOG = [
    '[00:01:22]: 1 uploads added to server. From server_temp',
    '[00:01:22]: About to start a shard with these settings:',
    '[00:01:22]:   ShardName: Master',
    '[00:01:22]:   ShardID: 1',
    '[00:01:22]:   ShardRole: MASTER',
    '[00:01:22]:   MasterBind: 127.0.0.1',
    '[00:01:22]:   MasterPort: 10888',
    '[00:01:22]: [Shard] Starting master server',
    '[00:01:22]: [Shard] Shard server started on port: 10888',
    '[00:01:22]: Telling Client our new session identifier: 47AE3E80A26892DF',
    '[00:02:20]: Validating portal[3] <-> 1244824001[3] (inactive)',
    '',
  ].join('\n')

  /** 同一台机器上洞穴分片的真实片段（列在这里是为了说明：两个分片打印的行并不相同） */
  const REAL_CAVES_READY_LOG = [
    '[00:02:49]: Reconstructing topology\t',
    '[00:02:49]: \t...Done!\t',
    '[00:02:50]: About to start a shard with these settings:',
    '[00:02:50]:   ShardRole: SECONDARY',
    '[00:02:50]: [Shard] Connecting to master...',
    '',
  ].join('\n')

  function writeShardLog(installPath: string, content: string): void {
    const dir = resolveShardRoot(installPath, 'master')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'server_log.txt'), content)
  }

  /**
   * 就绪标记必须同时能从 DST 自己写的 server_log.txt 里认出来——面板从实例目录直接读，
   * 不依赖 systemd 的 stdout 采集链路。控制台里看不到游戏输出时，这条是唯一的判据。
   */
  it('从主世界自己的 server_log.txt 认出世界已就绪（真实主世界日志片段）', () => {
    const installPath = createTempDir()
    writeShardLog(installPath, REAL_MASTER_READY_LOG)
    assert.equal(hasMasterReadyMarker('inst-not-used', installPath), true)
  })

  it('洞穴分片的就绪行同样能认出（同一套标记要覆盖两种分片）', () => {
    const installPath = createTempDir()
    writeShardLog(installPath, REAL_CAVES_READY_LOG)
    assert.equal(hasMasterReadyMarker('inst-not-used', installPath), true)
  })

  it('世界还在加载时不认（只有 Mod 注册行）', () => {
    const installPath = createTempDir()
    writeShardLog(installPath, '[00:00:30]: Mod: workshop-1 (X)\t  Registering prefabs\t\n')
    assert.equal(hasMasterReadyMarker('inst-not-used', installPath), false)
  })

  it('日志文件不存在时不认（不抛错）', () => {
    assert.equal(hasMasterReadyMarker('inst-not-used', createTempDir()), false)
  })

  /**
   * 回归：就绪标记最初是凭想象写的（`Sim paused` / `[Shard] Listen`），
   * 而线上真实日志里并不存在这些行。猜错不会报错，只会一路等到超时，极难发现。
   */
  it('不把猜出来的 Sim paused 当成就绪标记', () => {
    const installPath = createTempDir()
    writeShardLog(installPath, '[00:00:01]: Sim paused\n[00:00:02]: Sim unpaused\n')
    assert.equal(hasMasterReadyMarker('inst-not-used', installPath), false)
  })

  it('面板自己写的系统提示不算就绪标记', () => {
    const instanceId = freshInstanceId()
    instanceConsoleLogStore.appendSystem(instanceId, '主世界仍在加载（已等待 30 秒），就绪后再启动洞穴分片', 'master')
    assert.equal(hasMasterReadyMarker(instanceId), false)
  })

  it('洞穴分片打印的同一行不算主世界就绪', () => {
    const instanceId = freshInstanceId()
    instanceConsoleLogStore.appendDockerLine(instanceId, '[00:02:50]: About to start a shard with these settings:', 'caves')
    assert.equal(hasMasterReadyMarker(instanceId), false)
  })
})

/**
 * 回归：`master_port` 是 `cluster.ini [SHARD]` 的分片互联端口，只在实例容器的网络里监听，
 * **从不发布到宿主机**（发布的是 `server.ini` 的三个游戏端口）。因此在 Docker 模式下，
 * 面板容器里 bind 它必然成功——「端口已被占用」这条判据永远不成立。
 *
 * 就绪判定此前把 `hasMasterReadyMarker()` 写在「端口已探测到」分支里面，于是标记永远不会被
 * 检查。实测表现：主世界 57 秒就打印 `Sim paused`、房间能进，控制台却一路报
 * 「主世界仍在加载（…尚未监听到分片端口）」，直到 900 秒超时兜底才启动洞穴。
 */
describe('waitForMasterShardReady', () => {
  const fakeApp = {
    log: { warn() {}, info() {}, error() {} },
  } as unknown as FastifyInstance
  const masterRef = { id: 'test-master-container', name: 'test-master-container' } as ContainerRef

  /** 用户服务器上主世界的真实片段：世界加载完成 */
  const REAL_MASTER_READY_LOG = [
    '[00:00:54]: Reconstructing topology\t',
    '[00:00:54]: [Shard] Shard server started on port: 10888',
    '[00:00:57]: Sim paused',
    '',
  ].join('\n')

  function freshInstanceId(): string {
    return `inst-ready-${Date.now()}-${Math.round(Math.random() * 1e6)}`
  }

  function writeMasterLog(installPath: string, content: string): void {
    const dir = resolveShardRoot(installPath, 'master')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'server_log.txt'), content)
  }

  async function freeUdpPort(): Promise<number> {
    const held = await bindUdpPort()
    const port = held.port
    held.close()
    return port
  }

  it('端口探测不到时靠主世界自己的就绪标记立即放行（Docker 模式）', async () => {
    const installPath = createTempDir()
    writeMasterLog(installPath, REAL_MASTER_READY_LOG)
    const port = await freeUdpPort()
    const startedAt = Date.now()
    const outcome = await waitForMasterShardReady(fakeApp, freshInstanceId(), masterRef, port, installPath, 900, 0)
    assert.equal(outcome.kind, 'ready')
    // 旧实现下这里会一直等到上限（15 分钟），用例必然超时
    assert.ok(Date.now() - startedAt < 5000, '就绪标记命中时应立即返回，不再等满上限')
  })

  it('世界还在加载时不放行', async () => {
    const installPath = createTempDir()
    writeMasterLog(installPath, '[00:00:30]: Mod: workshop-1 (X)\t  Registering prefabs\t\n')
    const port = await freeUdpPort()
    const outcome = await waitForMasterShardReady(fakeApp, freshInstanceId(), masterRef, port, installPath, 1, 0)
    assert.notEqual(outcome.kind, 'ready')
  })

  it('端口已绑定但早于宽限期时仍不放行（避免与世界加载撞在一起）', async () => {
    const installPath = createTempDir()
    const held = await bindUdpPort()
    try {
      const outcome = await waitForMasterShardReady(fakeApp, freshInstanceId(), masterRef, held.port, installPath, 1, 0)
      // 唯一要证明的是「端口刚绑定不等于世界就绪」；此时运行时快照如何不影响这个判定
      assert.notEqual(outcome.kind, 'ready')
    }
    finally {
      held.close()
    }
  })
})

describe('readClusterMasterPort', () => {  it('读取 cluster.ini 的 master_port', () => {
    const installPath = createTempDir()
    const shardRoot = path.join(installPath, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1')
    fs.mkdirSync(shardRoot, { recursive: true })
    fs.writeFileSync(
      path.join(shardRoot, 'cluster.ini'),
      ['[SHARD]', 'shard_enabled = true', 'master_port = 12000', ''].join('\n'),
    )
    assert.equal(readClusterMasterPort(installPath), 12000)
  })

  it('配置文件缺失时退回 DST 默认端口', () => {
    assert.equal(readClusterMasterPort(createTempDir()), 10888)
  })
})

/**
 * 回归：面板此前只能回答「Mod 内容已就绪」，无法回答「游戏到底加载了几个」。
 * 落位目录与游戏读取目录不一致时（实测发生过：内容写进 ugc_mods、游戏读 mods/），
 * 面板显示全部就绪、游戏里一个 Mod 都没有，而日志里连报错都没有——只能靠自己数。
 */
describe('summarizeLoadedMods', () => {
  it('统计本轮真正被加载的 Mod（真实日志片段）', () => {
    const logText = [
      '[00:00:04]: ModIndex: Beginning normal load sequence for dedicated server.',
      '[00:00:30]: Mod: workshop-378160973 (Global Positions)\t  Registering prefabs\t',
      '[00:00:31]: Mod: workshop-1207269058 (Food Values)\t  Registering prefabs\t',
      '[00:00:39]: ModIndex: Load sequence finished successfully.',
      '',
    ].join('\n')

    const summary = summarizeLoadedMods(logText)

    assert.equal(summary.indexFinished, true)
    assert.deepEqual(summary.workshopIds.sort(), ['1207269058', '378160973'])
  })

  it('索引还没跑完时不下结论', () => {
    const summary = summarizeLoadedMods('[00:00:04]: ModIndex: Beginning normal load sequence for dedicated server.\n')
    assert.equal(summary.indexFinished, false)
    assert.deepEqual(summary.workshopIds, [])
  })

  it('索引跑完却没有任何 Mod 加载行（这一次故障的形态）', () => {
    const summary = summarizeLoadedMods('[00:00:39]: ModIndex: Load sequence finished successfully.\n')
    assert.equal(summary.indexFinished, true)
    assert.deepEqual(summary.workshopIds, [])
  })

  it('同一个 Mod 的多行注册只算一次', () => {
    const logText = [
      '[00:00:30]: Mod: workshop-1 (X)\t  Registering prefabs\t',
      '[00:00:31]: Mod: workshop-1 (X)\t  Registering prefabs\t',
      '[00:00:39]: ModIndex: Load sequence finished successfully.',
    ].join('\n')
    assert.deepEqual(summarizeLoadedMods(logText).workshopIds, ['1'])
  })
})

it('normalizes caves probe failure to unknown and preserves confirmed states', async (t) => {
  const { getContainerRuntime } = await import('../../infra/container/index.ts')
  const { inspectInstanceShardRuntime } = await import('./container-lifecycle.ts')
  const runtime = getContainerRuntime()
  t.mock.method(runtime, 'findByName', async () => ({ id: 'test-ref', name: 'test-ref' }))
  t.mock.method(runtime, 'inspect', async () => ({ running: false, probeFailed: true }))
  assert.deepEqual(await inspectInstanceShardRuntime('probe-test', 'caves'), { unitExists: true, snapshot: null })
  t.mock.method(runtime, 'inspect', async () => ({ running: false }))
  assert.deepEqual(await inspectInstanceShardRuntime('probe-test', 'caves'), { unitExists: true, snapshot: { running: false } })
  t.mock.method(runtime, 'inspect', async () => ({ running: true }))
  assert.equal((await inspectInstanceShardRuntime('probe-test', 'caves')).snapshot?.running, true)
  t.mock.method(runtime, 'findByName', async () => undefined)
  assert.deepEqual(await inspectInstanceShardRuntime('probe-test', 'caves'), { unitExists: false, snapshot: null })
})
