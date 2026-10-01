import fs from 'node:fs'
import type {
  DstPlayerSummaryDto,
  DstRoomSummaryDto,
  DstWorldSummaryDto,
  PlayerSummariesDto,
  RoomSummariesDto,
  WorldSummariesDto,
} from '../../../../shared/contracts/dst-summary'
import type { InstanceSummaryItem } from '../../../../shared/contracts/instance'
import type { DbGameInstance } from '../../shared/db/index'
import type { DstConsoleShard } from '../../shared/instance/dst-container-command-port'
import { DST_APP_ID } from '../../infra/game-adapter/dst/constants'
import { getClusterConfig, resolveInstanceInstallPath } from '../../infra/game-adapter/dst/cluster-service'
import { sumOnlinePlayerCounts } from '../../infra/game-adapter/dst/online-players'
import { isCavesShardConfigured } from '../../infra/game-adapter/dst/shard-layout'
import { getShardList } from '../../infra/game-adapter/dst/shard-service'

/**
 * DST 列表页的**按模块投影**。
 *
 * 原来只有一份「全量摘要」，房间/世界/玩家三个列表页共用它、并因此都要求 `instance:read`——
 * 「能看房间」被迫等于「能看实例管理」。现在每张投影一个入口、各自只需要本模块的读权限点
 * （路由在 `instance/index.ts` 里），并且**只构建这一页要用的字段**：
 * 房间页拿不到分片细节，世界页拿不到房间配置，三者都拿不到安装路径与端口。
 *
 * 实例标识统一走 `toInstanceSummaryItem`（`instanceSummaryItemSchema`），可见范围由调用方
 * 先用实例授权过滤好再传进来——这些函数只负责投影，不负责鉴权。
 */

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

/** DB 行 → 实例标识（三张投影与 `/app/instance/options` 共用同一份映射） */
export function toInstanceSummaryItem(instance: DbGameInstance): InstanceSummaryItem {
  return {
    id: instance.id,
    name: instance.name,
    gameCode: instance.gameCode,
    status: instance.status,
    lastError: instance.lastError,
    lastErrorPhase: instance.lastErrorPhase,
    lastCommand: instance.lastCommand,
  }
}

/** 未安装 / 未就绪的实例：三张投影共用同一句原因 */
const NOT_INSTALLED_MESSAGE = '实例尚未完成安装'

function isInstalled(instance: DbGameInstance): boolean {
  return instance.status !== 'pending_install'
    && instance.status !== 'installing'
    && fs.existsSync(resolveInstanceInstallPath(instance))
}

/** 在线人数按分片合计：玩家走进洞穴后，只查地上世界会少算一个人 */
function resolveCountShards(installPath: string): DstConsoleShard[] {
  return isCavesShardConfigured(installPath) ? ['master', 'caves'] : ['master']
}

async function readOnlinePlayerCount(instance: DbGameInstance, installPath: string): Promise<number | null> {
  if (instance.status !== 'running') {
    return null
  }
  return sumOnlinePlayerCounts(instance.id, resolveCountShards(installPath)).catch(() => null)
}

async function buildRoomSummary(
  instance: DbGameInstance,
): Promise<{ instance: InstanceSummaryItem, room: DstRoomSummaryDto }> {
  const identity = toInstanceSummaryItem(instance)
  const unavailable = (error: string) => ({
    instance: identity,
    room: {
      clusterName: null,
      networkMode: null,
      shardEnabled: null,
      cavesConfigured: null,
      onlinePlayerCount: null,
      maxPlayers: null,
      error,
    },
  })

  if (!isInstalled(instance)) {
    return unavailable(NOT_INSTALLED_MESSAGE)
  }

  try {
    const installPath = resolveInstanceInstallPath(instance)
    const cluster = getClusterConfig(instance)
    return {
      instance: identity,
      room: {
        clusterName: cluster.clusterName,
        networkMode: cluster.networkMode,
        shardEnabled: cluster.shardEnabled,
        // 列表里那一列（未开启 / 已开启 / 配置异常）要的就是它，不需要读世界投影
        cavesConfigured: isCavesShardConfigured(installPath),
        onlinePlayerCount: await readOnlinePlayerCount(instance, installPath),
        maxPlayers: cluster.maxPlayers,
        error: null,
      },
    }
  }
  catch (error) {
    return unavailable(getErrorMessage(error, '读取 DST 房间摘要失败'))
  }
}

async function buildWorldSummary(
  instance: DbGameInstance,
): Promise<{ instance: InstanceSummaryItem, world: DstWorldSummaryDto }> {
  const identity = toInstanceSummaryItem(instance)
  const unavailable = (error: string) => ({
    instance: identity,
    world: { clusterShardEnabled: null, master: null, caves: null, error },
  })

  if (!isInstalled(instance)) {
    return unavailable(NOT_INSTALLED_MESSAGE)
  }

  try {
    const shardList = await getShardList(instance)
    const master = shardList.shards.find(shard => shard.id === 'master')
    const caves = shardList.shards.find(shard => shard.id === 'caves')
    return {
      instance: identity,
      world: {
        clusterShardEnabled: shardList.clusterShardEnabled,
        master: master
          ? { configured: master.configured, containerStatus: master.containerStatus }
          : null,
        caves: caves
          ? { configured: caves.configured, containerStatus: caves.containerStatus }
          : null,
        error: null,
      },
    }
  }
  catch (error) {
    return unavailable(getErrorMessage(error, '读取 DST 世界摘要失败'))
  }
}

async function buildPlayerSummary(
  instance: DbGameInstance,
): Promise<{ instance: InstanceSummaryItem, player: DstPlayerSummaryDto }> {
  const identity = toInstanceSummaryItem(instance)
  const unavailable = (error: string) => ({
    instance: identity,
    player: { clusterName: null, onlinePlayerCount: null, maxPlayers: null, error },
  })

  if (!isInstalled(instance)) {
    return unavailable(NOT_INSTALLED_MESSAGE)
  }

  try {
    const installPath = resolveInstanceInstallPath(instance)
    /**
     * 房间名在这里是"这些玩家在哪个房间"的上下文标识；上限（`maxPlayers`）是
     * "在线 x / 上限 y"这个读数的分母。联网方式、洞穴开关这些真正的房间配置不在这里出现。
     */
    const cluster = getClusterConfig(instance)
    return {
      instance: identity,
      player: {
        clusterName: cluster.clusterName,
        onlinePlayerCount: await readOnlinePlayerCount(instance, installPath),
        maxPlayers: cluster.maxPlayers,
        error: null,
      },
    }
  }
  catch (error) {
    return unavailable(getErrorMessage(error, '读取 DST 玩家摘要失败'))
  }
}

function onlyDstInstances(instances: DbGameInstance[]): DbGameInstance[] {
  return instances.filter(instance => instance.gameCode === DST_APP_ID)
}

export async function getRoomSummaries(instances: DbGameInstance[]): Promise<RoomSummariesDto> {
  return {
    items: await Promise.all(onlyDstInstances(instances).map(buildRoomSummary)),
    collectedAt: new Date().toISOString(),
  }
}

export async function getWorldSummaries(instances: DbGameInstance[]): Promise<WorldSummariesDto> {
  return {
    items: await Promise.all(onlyDstInstances(instances).map(buildWorldSummary)),
    collectedAt: new Date().toISOString(),
  }
}

export async function getPlayerSummaries(instances: DbGameInstance[]): Promise<PlayerSummariesDto> {
  return {
    items: await Promise.all(onlyDstInstances(instances).map(buildPlayerSummary)),
    collectedAt: new Date().toISOString(),
  }
}
