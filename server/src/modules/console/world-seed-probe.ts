import { randomUUID } from 'node:crypto'
import { generationSeedGuard } from '../shard/world-maintenance-store'
import type { ShardId, ShardWorldSeedProbe } from '../../../../shared/contracts/shard'
import type { DbGameInstance } from '../../shared/db/index'
import type { ObservedWorldSeed } from '../../infra/game-adapter/dst/panel-config-meta'
import { readObservedWorldSeed, writeObservedWorldSeed } from '../../infra/game-adapter/dst/panel-config-meta'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import {
  ensureContainerRuntimeReady,
  isCavesContainerRunning,
  isInstanceContainerRunning,
  sendInstanceContainerCommand,
} from '../instance/container-lifecycle'
import { buildWorldSeedQueryCommand, parseWorldSeedLogLine } from './world-seed-parser'

/** 指令送达后等待游戏输出的轮询参数（与 world-state 查询一致） */
const POLL_INTERVAL_MS = 250
const POLL_MAX_ATTEMPTS = 16

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function isShardRunning(instanceId: string, shard: ShardId): Promise<boolean> {
  return shard === 'caves'
    ? isCavesContainerRunning(instanceId)
    : isInstanceContainerRunning(instanceId)
}

/**
 * 向正在运行的分片问一次当前世界的真实种子，读到了就记进面板元数据。
 *
 * 种子必须来自游戏本身（`TheWorld.meta.seed`，与存档 `savedata.meta.seed` 同一个值），
 * 面板不做任何加工：读不到就如实说读不到，绝不用面板里填写的值顶替。
 */
export async function probeWorldSeed(input: {
  instanceId: string
  shard: ShardId
  installPath: string
}): Promise<ShardWorldSeedProbe> {
  const { instanceId, shard, installPath } = input
  const unavailable = (message: string): ShardWorldSeedProbe => ({
    instanceId,
    shard,
    available: false,
    seed: null,
    recordedAt: null,
    message,
  })

  if (!await isShardRunning(instanceId, shard)) {
    return unavailable('该分片未运行，读取当前世界种子需要实例正在运行')
  }
  const runtimeReady = await ensureContainerRuntimeReady()
  if (!runtimeReady.ok) {
    return unavailable(runtimeReady.message ?? '容器运行时未就绪')
  }

  const token = randomUUID()
  const afterId = instanceConsoleLogStore.listLogs(instanceId).at(-1)?.id ?? 0
  const sendResult = await sendInstanceContainerCommand(instanceId, buildWorldSeedQueryCommand(token), shard)
  if (!sendResult.ok) {
    return unavailable(sendResult.message ?? '读取世界种子的指令发送失败')
  }

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    await sleep(POLL_INTERVAL_MS)
    const lines = instanceConsoleLogStore.listLogs(instanceId, afterId)
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!
      if (line.stream !== 'stdout') {
        continue
      }
      if (line.shard !== shard) {
        continue
      }
      const parsed = parseWorldSeedLogLine(line.text, token)
      if (parsed) {
        const guard = generationSeedGuard(installPath, shard, parsed.sessionId)
        if (guard) return unavailable(guard)
        const at = new Date().toISOString()
        writeObservedWorldSeed(installPath, shard, {
          seed: parsed.seed,
          at,
          sessionId: parsed.sessionId,
        })
        const recorded = readObservedWorldSeed(installPath, shard)
        return {
          instanceId,
          shard,
          available: true,
          seed: recorded?.seed ?? parsed.seed,
          recordedAt: recorded?.at ?? at,
          message: null,
        }
      }
    }
  }

  return unavailable('暂时没读到当前世界种子（世界可能还在加载，或该存档生成时没有记录种子）')
}

/**
 * 是否需要补读：还没有记录、记录已过时（世界被重新生成过），或记录发生在本次运行开始之前。
 *
 * 种子的读取必须发生在实例运行期间，所以"跑过一次就该被记下来"；一旦记录既可信又覆盖了
 * 本次运行，就不再重复向游戏进程发问。读不到启动时间时按"需要补读"处理（宁可多问一次）。
 */
export function shouldProbeWorldSeed(
  recorded: ObservedWorldSeed | null,
  runtimeStartedAt: string | null,
): boolean {
  if (!recorded || recorded.stale) {
    return true
  }
  if (!runtimeStartedAt) {
    return true
  }
  const recordedAt = Date.parse(recorded.at)
  const startedAt = Date.parse(runtimeStartedAt)
  if (Number.isNaN(recordedAt) || Number.isNaN(startedAt)) {
    return true
  }
  return recordedAt < startedAt
}

const inFlightProbes = new Set<string>()

/**
 * 实例运行期间自动补读世界种子（后台执行，不阻塞调用方）。
 *
 * 自动补读失败是常态（世界还在加载、容器刚重启），因此完全静默；
 * 用户也可以在页面上手动再读一次。
 */
export function scheduleWorldSeedProbes(instance: DbGameInstance, shards: ShardId[]): void {
  if (instance.status !== 'running' || !instance.installPath) {
    return
  }
  for (const shard of shards) {
    const key = `${instance.id}:${shard}`
    if (inFlightProbes.has(key)) {
      continue
    }
    const recorded = readObservedWorldSeed(instance.installPath, shard)
    if (!shouldProbeWorldSeed(recorded, instance.runtimeStartedAt ?? null)) {
      continue
    }
    inFlightProbes.add(key)
    void (async () => {
      try {
        await probeWorldSeed({ instanceId: instance.id, shard, installPath: instance.installPath! })
      }
      catch {
        // best-effort：世界尚未加载完、容器刚重启等情况都不该影响接口本身
      }
      finally {
        inFlightProbes.delete(key)
      }
    })()
  }
}

/** 测试用：清空并发去重表 */
export function resetWorldSeedProbeStateForTest(): void {
  inFlightProbes.clear()
}
