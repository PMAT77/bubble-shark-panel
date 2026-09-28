import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import {
  playerActionPayloadSchema,
  playerKickPayloadSchema,
  playerListQuerySchema,
  playerListSavePayloadSchema,
  playerProfileNotePayloadSchema,
  playerProfileQuerySchema,
} from '../../../../shared/contracts/player'
import type {
  PlayerBanResult,
  PlayerKickResult,
  PlayerListDto,
  PlayerListEntry,
  PlayerListSaveResult,
  PlayerOnlineRosterDto,
  PlayerProfileSearchResult,
  PlayerProfileSyncResult,
  PlayerShard,
} from '../../../../shared/contracts/player'
import { resolveLocalDstInstance, type ResolvedLocalDstInstance } from '../../shared/dst/local-dst-instance'
import { getPlayerList, savePlayerListForInstance } from '../../infra/game-adapter/dst/player-service'
import {
  buildBanCommand,
  buildClientTableCommand,
  buildConsoleProbeCommand,
  buildDespawnCommand,
  buildKickCommand,
  createConsoleToken,
  hasConsolePing,
  isRoomOwner,
  isSafeCommandUserId,
  isValidKuId,
  parseClientRows,
  parseConsoleHostUserId,
} from '../../infra/game-adapter/dst/player-actions'
import {
  describePlayerActionOutcome,
  findPlayerActionError,
  type PlayerActionKind,
} from '../../infra/game-adapter/dst/player-action-result'
import {
  queryShardsOnlinePlayers,
  resolvePlayerLocation,
  type DstShardOnlineSnapshot,
} from '../../infra/game-adapter/dst/online-players'
import {
  collectPlayerNameHintsFromGameLogs,
  mergePlayerNameHints,
  parsePlayerNameHints,
} from '../../infra/game-adapter/dst/player-name-hints'
import { buildPlayerRoster, type PlayerRosterShardPlan } from '../../infra/game-adapter/dst/player-roster'
import { isCavesShardConfigured } from '../../infra/game-adapter/dst/shard-layout'
import { getClusterConfig } from '../../infra/game-adapter/dst/cluster-service'
import { getActiveConsoleLogFile } from '../../shared/instance-runtime/console-log-file'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import {
  findPlayerProfilesByKuIds,
  listPlayerProfiles,
  setPlayerProfileNote,
  upsertPlayerProfiles,
} from '../../shared/db/index'
import { businessError, success } from '../../shared/http/response'
import { authorizeInstance } from '../system/auth'
import {
  isInstanceContainerRunning,
  sendInstanceContainerCommand,
} from '../instance/container-lifecycle'

const PLAYER_RESOLVE_MESSAGES = {
  wrongNode: '当前仅支持本地节点实例的玩家名单',
  wrongGame: '当前仅支持 DST 实例的玩家名单',
  missingInstallPath: '实例安装目录不存在，请先在实例管理中完成安装',
  clusterDirFailed: '无法创建房间配置目录',
}

/**
 * 踢人 / 封禁前后的在线探测超时。
 *
 * 比周期查询（4 秒）短：管理员点了按钮在等结果，宁可如实回一句「没能确认」，
 * 也不要让一次点击卡到十秒。
 */
const PROBE_TIMEOUT_MS = 2500

/**
 * 在线玩家总览（周期性展示）的查询超时。
 *
 * 与操作探测分开：这里没人盯着等，宁可多等一会儿，也别把「有人在线」报成「没人」。
 * 实例详情页与玩家管理页共用这一个值，两处的结果才可能一致。
 */
const ROSTER_TIMEOUT_MS = 4000

/** 命令下发后等一小会儿再复查，给游戏进程处理命令的时间 */
const RECHECK_DELAY_MS = 900

/**
 * 复查在线名单的超时。
 *
 * 比探测短一点：这一步只是复核，管理员已经在等了，宁可如实回一句「没能确认」，
 * 也不要让一次点击卡到十秒。
 */
const RECHECK_TIMEOUT_MS = 2000

/**
 * 一次玩家操作最多下发几条命令。
 *
 * 首轮之后玩家还在房间里就补发一条（换世界或这一次没被游戏执行），
 * 两条都没用就不必再发——那已经不是「再发一次」能解决的事了。
 */
const KICK_ATTEMPT_LIMIT = 2

/** 回执行的轮询间隔 */
const ACTION_FEEDBACK_POLL_MS = 150

/**
 * 控制台自检的等待上限。
 *
 * 面板往游戏里写一条 print，正常几百毫秒就出现在日志里；超过这个时间还没有回声，
 * 就当通道不可用，直接告诉管理员重启面板，而不是让他一遍遍点踢出。
 */
const PING_TIMEOUT_MS = 1500

/**
 * 查询某个实例的在线玩家总览（地上 + 洞穴）。
 *
 * 实例详情页与玩家管理页共用这一条路径。
 *
 * 各查各的代价是两个页面的口径会漂：详情页只查地上、人数按游戏侧读数，
 * 玩家页查两个分片、人数按明细条数——于是「详情说 1 人在线、玩家页说没人」
 * 与「人在洞穴时详情少算一个」会同时出现。合成一条路径后口径不可能再分叉。
 */
export async function queryInstanceOnlineRoster(instance: ResolvedLocalDstInstance): Promise<PlayerOnlineRosterDto> {
  const plans = await planShardQueries(instance)
  const snapshots = await queryOnlineSnapshots(instance.id, plans, ROSTER_TIMEOUT_MS)
  // 玩家在线时是名字最可靠的来源，顺手写进档案，名单以后就能按名字显示
  await rememberOnlineNames(instance.id, snapshots)
  return buildPlayerRoster({
    instanceId: instance.id,
    plans,
    snapshots,
    maxPlayers: getClusterConfig(instance).maxPlayers,
  })
}

/**
 * player 模块：DST 玩家名单（adminlist.txt / blocklist.txt / whitelist.txt）、
 * 在线玩家与踢出 / 封禁。
 *
 * 名单走文件读写；踢人与封禁向游戏进程下发命令，并在下发后复查在线名单，
 * 只有确认玩家离开才回报成功（见 infra/game-adapter/dst/player-action-result.ts）。
 * 命令本身保持最短形态：命令越复杂，被链路上任何一层改写的面就越大。
 */
export function registerPlayerModule(app: FastifyInstance) {
  app.get('/app/instance/players', async (request): Promise<ApiSuccessResponse<PlayerListDto> | ApiErrorResponse> => {
    const query = playerListQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, query.data.instanceId, 'player:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(query.data.instanceId, request, { messages: PLAYER_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const dto = getPlayerList(resolved.instance, query.data.kind)
      let entries = await attachProfileNames(resolved.instance.id, dto.entries)
      if (entries.some(entry => !entry.name)) {
        // 名单里还有认不出来的 ID（历史条目、或加人时玩家没在线）：
        // 打开页面就顺手从日志里补一次名字，不必让管理员去找按钮
        await syncProfilesFromLogsIfStale(resolved.instance)
        entries = await attachProfileNames(resolved.instance.id, entries)
      }
      return success({ ...dto, entries }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '读取玩家名单失败'
      return businessError(message, request)
    }
  })

  app.put('/app/instance/players', async (request): Promise<ApiSuccessResponse<PlayerListSaveResult> | ApiErrorResponse> => {
    const body = playerListSavePayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const payload = body.data
    const authorized = await authorizeInstance(request, payload.instanceId, 'player:write')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(payload.instanceId, request, { messages: PLAYER_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const result = savePlayerListForInstance(resolved.instance, payload.kind, payload.entries)
      return success({
        saved: true,
        entries: await attachProfileNames(resolved.instance.id, result.entries),
      }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '保存玩家名单失败'
      return businessError(message, request)
    }
  })

  /**
   * 在线玩家总览（含地上 / 洞穴）。
   *
   * 顺手把这次看到的「ID ↔ 名字」写进玩家档案：玩家在线时是名字最可靠的来源，
   * 名单以后就能按名字显示。
   */
  app.get('/app/instance/players/online', async (request): Promise<ApiSuccessResponse<PlayerOnlineRosterDto> | ApiErrorResponse> => {
    const query = playerProfileQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, query.data.instanceId, 'player:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(query.data.instanceId, request, { messages: PLAYER_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      return success(await queryInstanceOnlineRoster(resolved.instance), request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '读取在线玩家失败'
      return businessError(message, request)
    }
  })

  /** 按名字 / ID 搜索玩家档案，供「按游戏名加入名单」使用 */
  app.get('/app/instance/players/profiles', async (request): Promise<ApiSuccessResponse<PlayerProfileSearchResult> | ApiErrorResponse> => {
    const query = playerProfileQuerySchema.safeParse(request.query ?? {})
    if (!query.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, query.data.instanceId, 'player:read')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(query.data.instanceId, request, { messages: PLAYER_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const keyword = query.data.keyword ?? ''
      const profiles = await listPlayerProfiles(resolved.instance.id, { keyword })
      return success({
        instanceId: resolved.instance.id,
        keyword,
        items: profiles.map(profile => ({
          kuId: profile.kuId,
          name: profile.name,
          note: profile.note,
          firstSeenAt: profile.firstSeenAt,
          lastSeenAt: profile.lastSeenAt,
        })),
      }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '搜索玩家失败'
      return businessError(message, request)
    }
  })

  /**
   * 从游戏日志补全玩家名。
   *
   * 在线查询只能记住当时在线的人；历史玩家名散在游戏自己写的 server_log.txt 与
   * 面板采集的控制台日志里，管理员点一下就把它们捞回档案，老名单也能显示名字。
   */
  app.post('/app/instance/players/profiles/sync', async (request): Promise<ApiSuccessResponse<PlayerProfileSyncResult> | ApiErrorResponse> => {
    const body = playerProfileQuerySchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, body.data.instanceId, 'player.profile:write')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(body.data.instanceId, request, { messages: PLAYER_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const result = await syncProfilesFromLogs(resolved.instance)
      return success(result, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '从日志补全玩家名失败'
      return businessError(message, request)
    }
  })

  /** 设置玩家备注名（只存在面板里，不写进游戏名单文件） */
  app.put('/app/instance/players/profiles/note', async (request): Promise<ApiSuccessResponse<PlayerProfileSearchResult> | ApiErrorResponse> => {
    const body = playerProfileNotePayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const authorized = await authorizeInstance(request, body.data.instanceId, 'player.profile:write')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(body.data.instanceId, request, { messages: PLAYER_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const updated = await setPlayerProfileNote(resolved.instance.id, body.data.kuId, body.data.note)
      return success({
        instanceId: resolved.instance.id,
        keyword: '',
        items: updated
          ? [{
              kuId: updated.kuId,
              name: updated.name,
              note: updated.note,
              firstSeenAt: updated.firstSeenAt,
              lastSeenAt: updated.lastSeenAt,
            }]
          : [],
      }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '保存备注失败'
      return businessError(message, request)
    }
  })

  app.post('/app/instance/players/kick', async (request): Promise<ApiSuccessResponse<PlayerKickResult> | ApiErrorResponse> => {
    const body = playerKickPayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      return businessError('请求参数无效', request)
    }
    const { instanceId, kuId } = body.data
    const authorized = await authorizeInstance(request, instanceId, 'player:kick')
    if (authorized.error) {
      return authorized.error
    }
    /**
     * 踢出比封禁宽松：离线 / 局域网进来的路人没有 Klei 账号，ID 形状不受面板控制，
     * 但清场同样需要踢得掉他。所以这里只要求「能安全拼进 Lua 命令」——
     * 拼不进去的一律拒绝，绝不把未校验的字符串交给命令层。
     */
    if (!kuId.trim()) {
      return businessError('游戏没有给出这个玩家的 ID，无法踢出', request)
    }
    if (!isSafeCommandUserId(kuId)) {
      return businessError('这个玩家的 ID 形状异常，面板无法安全地下发踢出命令', request)
    }
    const resolved = await resolveLocalDstInstance(instanceId, request, { messages: PLAYER_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }
    try {
      const plans = await planShardQueries(resolved.instance)
      const before = await queryOnlineSnapshots(instanceId, plans, PROBE_TIMEOUT_MS)
      await rememberOnlineNames(instanceId, before)
      const location = resolvePlayerLocation(before, kuId)
      if (location.status === 'offline') {
        return success({
          isSuccess: true,
          verified: true,
          message: '该玩家已经不在房间里',
        }, request)
      }

      let targetShard: PlayerShard = body.data.shard ?? location.shard ?? 'master'

      // 先确认面板写得进游戏、游戏也真的执行了，再谈踢不踢得掉
      const probe = await probeConsole(instanceId, targetShard)
      if (!probe.alive) {
        request.log.warn({ instanceId, shard: targetShard }, '控制台自检没有回声，判定为通路不可用')
        return businessError('面板发不出命令到房间，请重启面板后重试', request)
      }

      /**
       * 目标是房间主人时换一条路：把他移出世界。
       *
       * 集群令牌属于房间主人时，服务器自己那条 [Host] 连接与他共用同一个 userid，
       * `TheNet:Kick` 会落到那条假连接上（实测：不报错、人也不掉线）。官方的
       * `c_despawn` 内部先按 userid 在连接表里找人（跳过 [Host]），再到 AllPlayers
       * 里找唯一的玩家实体，把人送回角色选择界面——这是这条连接上唯一能生效的动作。
       */
      const ownerTarget = isRoomOwner(probe.hostUserId, kuId)
      const action: PlayerActionKind = ownerTarget ? 'despawn' : 'kick'
      if (ownerTarget) {
        request.log.info({ instanceId, kuId }, '目标是房间主人：改用移出世界')
      }

      /**
       * 最多下发两条命令。
       *
       * 第一轮之后玩家还在房间里，说明这一条没起作用：他可能刚迁到另一个世界
       * （命令发错了分片），也可能就是这一次没被游戏执行。两条命令的代价远小于
       * 「管理员点了没反应、还得自己再点一次」，所以换分片重发或原样补发一次。
       * 只在「复查确认他还在」时才补发——查不到结果时再发一条只会更乱。
       */
      let current = location
      for (let round = 0; round < KICK_ATTEMPT_LIMIT; round += 1) {
        const cursor = currentLogCursor(instanceId)
        const command = ownerTarget ? buildDespawnCommand(kuId) : buildKickCommand(kuId)
        const sent = await sendInstanceContainerCommand(instanceId, command, targetShard)
        if (!sent.ok) {
          if (round === 0) {
            return businessError(sent.message ?? '踢出失败', request)
          }
          // 补发没送达：按已经下发过的那一条如实回报
          break
        }

        await delay(RECHECK_DELAY_MS)
        const after = await queryOnlineSnapshots(instanceId, plans, RECHECK_TIMEOUT_MS)
        current = resolvePlayerLocation(after, kuId)
        logPlayerAction(request, instanceId, {
          action,
          kuId,
          shard: targetShard,
          sinceId: cursor,
          outcome: current.status,
        })
        if (current.status !== 'online') {
          break
        }
        // 玩家可能刚迁到另一个世界：命令发错分片时补发一次，而不是直接判失败
        targetShard = current.shard ?? targetShard
      }

      if (current.status === 'online') {
        // 两条命令都没把人弄走：把游戏侧看到的连接表抄进日志，下一轮排查不用再猜
        await dumpClientTable(request, instanceId, targetShard)
      }

      const outcome = describePlayerActionOutcome({
        stillOnline: current.status === 'online' ? true : current.status === 'offline' ? false : null,
        action,
      })
      return success({
        isSuccess: true,
        verified: outcome.verified,
        message: outcome.message,
      }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '踢出失败'
      return businessError(message, request)
    }
  })

  app.post('/app/instance/players/ban', async (request): Promise<ApiSuccessResponse<PlayerBanResult> | ApiErrorResponse> => {
    const body = playerActionPayloadSchema.safeParse(request.body ?? {})
    if (!body.success) {
      // 封禁要写进黑名单长期生效，只有稳定的 Klei ID 才有意义；
      // 临时身份（离线 / 局域网玩家）每次进服 ID 都会变，写进去拦不住任何人
      const rawKuId = (request.body as { kuId?: unknown } | undefined)?.kuId
      if (typeof rawKuId === 'string' && rawKuId.trim() && !isValidKuId(rawKuId)) {
        return businessError('这个玩家不是 Klei 账号，封禁对他无效：临时身份的 ID 每次进服都会变', request)
      }
      return businessError('请求参数无效', request)
    }
    const { instanceId, kuId } = body.data
    const authorized = await authorizeInstance(request, instanceId, 'player:ban')
    if (authorized.error) {
      return authorized.error
    }
    const resolved = await resolveLocalDstInstance(instanceId, request, { messages: PLAYER_RESOLVE_MESSAGES })
    if (!resolved.ok) {
      return resolved.error
    }

    try {
      const plans = await planShardQueries(resolved.instance)
      const before = await queryOnlineSnapshots(instanceId, plans, PROBE_TIMEOUT_MS)
      await rememberOnlineNames(instanceId, before)
      const location = resolvePlayerLocation(before, kuId)

      /**
       * 落盘之前先看一眼房间主人是谁。
       *
       * 集群令牌用的就是房间里某个玩家的账号时，服务器那条 [Host] 连接与他共用同一个
       * userid——把那个 ID 写进黑名单，等于把房间主人自己关在门外，重启后就进不来了。
       * 房间没运行（自检没有回声）时拿不到这个信息，只能按管理员的指令照写。
       */
      const probe = await probeConsole(instanceId, 'master')
      if (probe.alive && isRoomOwner(probe.hostUserId, kuId)) {
        request.log.info({ instanceId, kuId }, '目标账号同时是房间主人，已拒绝封禁')
        return businessError('该玩家就是房间主人，无法封禁', request)
      }

      // 先落盘再踢：写盘失败就整个失败，不留「人踢了但没拉黑」的半成品状态。
      // 落盘也保证重启后仍然拒绝该玩家。
      let entries: PlayerListEntry[]
      try {
        const current = getPlayerList(resolved.instance, 'block')
        const alreadyBanned = current.entries.some(
          entry => entry.kuId.toLowerCase() === kuId.toLowerCase(),
        )
        entries = alreadyBanned
          ? current.entries
          : savePlayerListForInstance(resolved.instance, 'block', [...current.entries, { kuId }]).entries
      }
      catch (error) {
        const message = error instanceof Error ? error.message : '写入黑名单失败'
        return businessError(message, request)
      }

      // 房间没运行（或面板写不进命令）：名单已生效，重启后才会拦住他
      if (!probe.alive) {
        return success({
          isSuccess: true,
          verified: false,
          message: '已加入黑名单，重启房间后才会生效',
          entries: await attachProfileNames(instanceId, entries),
        }, request)
      }

      const cursor = currentLogCursor(instanceId)

      // 即时封禁固定发给地上世界：封禁名单由主世界管理，发到洞穴分片没有意义
      await sendInstanceContainerCommand(instanceId, buildBanCommand(kuId), 'master')

      /**
       * 踢出这一步要把人在的分片都覆盖到。
       *
       * 人在哪个世界有时判不出来（某个分片没答上来），那就对每个运行中的分片都踢一次：
       * 多发一条命令的代价远小于「封了但人还在服里」。
       */
      const shardsToKick = location.status === 'online' && location.shard
        ? [location.shard]
        : plans.filter(plan => plan.running).map(plan => plan.shard)
      for (const shard of shardsToKick) {
        await sendInstanceContainerCommand(instanceId, buildKickCommand(kuId), shard)
      }

      // 这段等待给封禁与踢出命令留出生效时间
      await delay(RECHECK_DELAY_MS)

      const after = await queryOnlineSnapshots(instanceId, plans, RECHECK_TIMEOUT_MS)
      const current = resolvePlayerLocation(after, kuId)
      logPlayerAction(request, instanceId, {
        action: 'ban',
        kuId,
        shard: 'master',
        sinceId: cursor,
        outcome: current.status,
      })
      const outcome = describePlayerActionOutcome({
        stillOnline: current.status === 'online' ? true : current.status === 'offline' ? false : null,
        action: 'ban',
      })
      return success({
        isSuccess: true,
        verified: outcome.verified,
        message: outcome.message,
        entries: await attachProfileNames(instanceId, entries),
      }, request)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : '封禁失败'
      // 黑名单已经写好：如实说明「名单已生效、踢出这一步没成」，不让管理员以为整个操作白做
      return businessError(`已写入黑名单，但踢出房间失败：${message}`, request)
    }
  })
}

/** 这次要查哪些分片、各自是否在运行 */
async function planShardQueries(instance: ResolvedLocalDstInstance): Promise<PlayerRosterShardPlan[]> {
  const cavesConfigured = isCavesShardConfigured(instance.installPath)
  const shards: PlayerShard[] = cavesConfigured ? ['master', 'caves'] : ['master']
  return Promise.all(shards.map(async shard => ({
    shard,
    configured: shard === 'master' ? true : cavesConfigured,
    // 容器状态问不出来时按「没运行」处理：踢人前的探测不该因为一次容器查询失败就整单报错
    running: await isInstanceContainerRunning(instance.id, shard).catch(() => false),
  })))
}

/**
 * 查询各分片在线玩家。
 *
 * 未运行的分片直接记为空数组（进程都没了，里面不可能有人），只有「运行着却查不到」
 * 才算未知——后者会让上层提示名单可能不全，而不是当成没人在线。
 */
async function queryOnlineSnapshots(
  instanceId: string,
  plans: PlayerRosterShardPlan[],
  timeoutMs: number,
): Promise<DstShardOnlineSnapshot[]> {
  const runningShards = plans.filter(plan => plan.running).map(plan => plan.shard)
  const queried = runningShards.length > 0
    ? await queryShardsOnlinePlayers(instanceId, runningShards, { timeoutMs })
    : []
  return plans.map((plan) => {
    const found = queried.find(item => item.shard === plan.shard)
    // 未运行的分片按「确实没人在线」处理（进程都没了）；count 也用 0 与之对齐
    return found ?? { shard: plan.shard, players: [], count: 0 }
  })
}

/** 名单条目补上档案里的名字与备注 */
async function attachProfileNames(instanceId: string, entries: PlayerListEntry[]): Promise<PlayerListEntry[]> {
  if (entries.length === 0) {
    return entries
  }
  const profiles = await findPlayerProfilesByKuIds(instanceId, entries.map(entry => entry.kuId))
  return entries.map((entry) => {
    const profile = profiles.get(entry.kuId.toLowerCase())
    return {
      kuId: entry.kuId,
      name: profile?.name ?? '',
      note: profile?.note ?? '',
    }
  })
}

/**
 * 把这次看到的在线玩家名记进档案。
 *
 * 踢人与封禁常常是面板最后一次见到某个人（下一秒他就被踢下线了），
 * 所以探测到的名字要立刻落库，否则名单里只剩一串 ID。
 */
async function rememberOnlineNames(instanceId: string, snapshots: DstShardOnlineSnapshot[]): Promise<void> {
  // 只记 Klei 账号：离线 / 局域网的临时 ID 每次进服都会变，写进档案只会留下
  // 永远对不上人的垃圾条目，还会污染「按游戏名搜索」的结果
  const players = snapshots
    .flatMap(snapshot => snapshot.players ?? [])
    .filter(player => player.kleiAccount && player.kuId.length > 0)
  if (players.length === 0) {
    return
  }
  await upsertPlayerProfiles(instanceId, players.map(player => ({
    kuId: player.kuId,
    name: player.name,
  }))).catch(() => 0)
}

/**
 * 从日志里补玩家名。
 *
 * 覆盖两种日志来源：
 * - 面板自己采集的控制台日志：里面有面板注入的 `GSH_PLAYER_LIST_ITEM:...` 标记行，
 *   这是最可靠的名字来源（制表符分隔、由面板生成）；
 * - 游戏自己写的 server_log.txt：部分版本会打印 `Client authenticated: (KU_x) 名字`。
 *
 * 游戏日志里的 `Received (KU_x) from TokenPurpose` 之类的行不含名字，
 * 解析器会忽略它们，不会把日志后半句写进档案。
 */
async function syncProfilesFromLogs(instance: ResolvedLocalDstInstance): Promise<PlayerProfileSyncResult> {
  const panelLines = getActiveConsoleLogFile()?.readTail(instance.id, 2000)?.split(/\r?\n/) ?? []
  const hints = mergePlayerNameHints([
    parsePlayerNameHints(panelLines),
    collectPlayerNameHintsFromGameLogs(instance.installPath),
  ])
  const applied = await upsertPlayerProfiles(instance.id, hints.map(hint => ({
    kuId: hint.kuId,
    name: hint.name,
  })))
  return { hints: hints.length, applied }
}

/** 同一实例多久之内只自动扫一次日志：打开名单页会连发几个请求，不该每个都去读盘 */
const PROFILE_LOG_SYNC_INTERVAL_MS = 30_000
const profileLogSyncAt = new Map<string, number>()

/**
 * 打开名单时顺手补档（带节流）。
 *
 * 历史名单条目与"加人时玩家不在线"的条目一开始没有名字，等玩家上线再补太慢；
 * 面板日志里通常已经留下了标记行，页面一打开就能把名字补上。
 */
async function syncProfilesFromLogsIfStale(instance: ResolvedLocalDstInstance): Promise<void> {
  const last = profileLogSyncAt.get(instance.id) ?? 0
  if (Date.now() - last < PROFILE_LOG_SYNC_INTERVAL_MS) {
    return
  }
  profileLogSyncAt.set(instance.id, Date.now())
  await syncProfilesFromLogs(instance).catch(() => undefined)
}

interface ConsoleProbe {
  /** 面板写进游戏的控制台输入被执行了（自检有回声） */
  alive: boolean
  /** 房间主人（专用服务器自己那条 [Host] 连接）的账号；游戏没答上来时为 null */
  hostUserId: string | null
}

/**
 * 通道自检：往游戏里写一条最短的 print，确认它真的被执行了。
 *
 * 「面板写不进游戏」与「游戏不执行踢出」在界面上都表现为「点了没反应」，
 * 但一个要重启面板、另一个要换踢出方式，必须先分开。自检走的是和踢出同一条通路，
 * 所以它没回声时，再发多少条踢出命令都是白费。
 *
 * 顺手带回房间主人的账号：集群令牌用的就是房间里某个玩家的账号时，
 * 服务器那条 [Host] 占位连接会与那个玩家撞上同一个 userid，
 * 踢他会踢到假连接，封他更会把房间主人自己写进黑名单——动手前必须知道这件事。
 */
async function probeConsole(instanceId: string, shard: PlayerShard): Promise<ConsoleProbe> {
  const cursor = currentLogCursor(instanceId)
  const token = createConsoleToken()
  // 静默下发：这是面板自己的探针，不该在管理员的控制台里留一行回显
  const sent = await sendInstanceContainerCommand(instanceId, buildConsoleProbeCommand(token), shard, { silent: true })
  if (!sent.ok) {
    return { alive: false, hostUserId: null }
  }
  const deadline = Date.now() + PING_TIMEOUT_MS
  while (Date.now() < deadline) {
    const lines = readActionLogLines(instanceId, shard, cursor)
    if (hasConsolePing(lines, token)) {
      return { alive: true, hostUserId: parseConsoleHostUserId(lines, token) }
    }
    await delay(ACTION_FEEDBACK_POLL_MS)
  }
  return { alive: false, hostUserId: null }
}

/**
 * 踢不掉时把游戏的连接表抄一份到面板日志。
 *
 * 这种失败往往不是「命令没发出去」，而是「这条 ID 在游戏里对应的是另一条连接」
 * （例如专用服务器自己那条 [Host]）。表格留在日志里，下一次排查不必再让管理员
 * 手敲诊断命令。
 */
async function dumpClientTable(request: FastifyRequest, instanceId: string, shard: PlayerShard): Promise<void> {
  const cursor = currentLogCursor(instanceId)
  const token = createConsoleToken()
  const sent = await sendInstanceContainerCommand(instanceId, buildClientTableCommand(token), shard, { silent: true })
  if (!sent.ok) {
    return
  }
  const deadline = Date.now() + PING_TIMEOUT_MS
  let rows = parseClientRows(readActionLogLines(instanceId, shard, cursor), token)
  while (rows.length === 0 && Date.now() < deadline) {
    await delay(ACTION_FEEDBACK_POLL_MS)
    rows = parseClientRows(readActionLogLines(instanceId, shard, cursor), token)
  }
  request.log.warn({ instanceId, shard, clients: rows }, '踢出未生效，游戏当前的连接表')
}

function readActionLogLines(instanceId: string, shard: PlayerShard, afterId: number): string[] {
  return instanceConsoleLogStore
    .listLogs(instanceId, afterId)
    .filter(line => line.shard === shard)
    .map(line => line.text)
}

/**
 * 把这次操作落到面板日志里。
 *
 * 界面上只留一句人话，所以「命令发给了哪个分片、游戏有没有报错、复查看到什么」
 * 必须落在日志里——否则踢不掉时，除了再点一次没有别的办法。
 */
function logPlayerAction(
  request: FastifyRequest,
  instanceId: string,
  detail: { action: PlayerActionKind, kuId: string, shard: PlayerShard, sinceId: number, outcome: string },
): void {
  const gameError = findPlayerActionError(readActionLogLines(instanceId, detail.shard, detail.sinceId))
  request.log.info({
    instanceId,
    action: detail.action,
    kuId: detail.kuId,
    shard: detail.shard,
    recheck: detail.outcome,
    gameError,
  }, '玩家操作已复查')
}

/** 命令窗口的起点：每次下发前取一次，且只活在这一次请求里，避免并发操作互相串行 */
function currentLogCursor(instanceId: string): number {
  const logs = instanceConsoleLogStore.listLogs(instanceId)
  return logs.length > 0 ? logs[logs.length - 1].id : 0
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
