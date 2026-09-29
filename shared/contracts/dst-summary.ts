import { z } from 'zod'
import { clusterNetworkModeSchema } from './cluster'
import { instanceSummaryItemSchema } from './instance'
import { shardContainerStatusSchema } from './shard'

/**
 * DST 列表页的**按模块投影**。
 *
 * 为什么不是一份"全量摘要"：房间、世界、玩家三个列表页此前共用 `/app/instance/dst-summaries`
 * （要求 `instance:read`），于是「能看房间」被迫等于「能看实例管理」，取消「查看实例」会
 * 连带收走它们的菜单。现在每张投影一个接口、各自只需要本模块的读权限点，而且**只返回
 * 这一页真正要用的字段**——房间页拿不到分片细节，世界页拿不到房间配置；三个页面都拿不到
 * 安装路径、端口与节点。
 *
 * 实例标识部分统一用 `instanceSummaryItemSchema`（id/名称/状态/最近错误），不含安装路径与端口。
 * 可见范围仍然由实例授权（`instance_grants`）决定，投影不放松这一点。
 */

const nullableSummaryErrorSchema = z.string().nullable()

/** 房间投影：房间列表页要用的全部字段 */
export const dstRoomSummarySchema = z.object({
  clusterName: z.string().nullable(),
  networkMode: clusterNetworkModeSchema.nullable(),
  shardEnabled: z.boolean().nullable(),
  /**
   * 洞穴是否已配置。
   *
   * 单独放在房间投影里，而不是让房间页去读世界投影：列表里那一列（未开启 / 已开启 /
   * 配置异常）本来就需要它，跨投影取值会让"房间页只需要 room:read"这件事不成立。
   */
  cavesConfigured: z.boolean().nullable(),
  onlinePlayerCount: z.number().int().nonnegative().nullable(),
  maxPlayers: z.number().int().min(1).max(64).nullable(),
  error: nullableSummaryErrorSchema,
})
export type DstRoomSummaryDto = z.infer<typeof dstRoomSummarySchema>

/** 世界投影：分片配置与容器状态 */
export const dstWorldShardSummarySchema = z.object({
  configured: z.boolean(),
  containerStatus: shardContainerStatusSchema,
})
export type DstWorldShardSummaryDto = z.infer<typeof dstWorldShardSummarySchema>

export const dstWorldSummarySchema = z.object({
  clusterShardEnabled: z.boolean().nullable(),
  master: dstWorldShardSummarySchema.nullable(),
  caves: dstWorldShardSummarySchema.nullable(),
  error: nullableSummaryErrorSchema,
})
export type DstWorldSummaryDto = z.infer<typeof dstWorldSummarySchema>

/**
 * 玩家投影：房间名（哪个房间的玩家）+ 人数。
 *
 * 房间名在这里是**玩家上下文的标识**（列表里只有实例名的话，"这些玩家在哪个房间"就没了），
 * 不是房间配置本身；联网方式、洞穴开关这些真正的房间字段仍然只在房间投影里。
 * 上限（`maxPlayers`）是"在线 x / 上限 y"这个读数的分母，同样属于玩家视图。
 */
export const dstPlayerSummarySchema = z.object({
  clusterName: z.string().nullable(),
  onlinePlayerCount: z.number().int().nonnegative().nullable(),
  maxPlayers: z.number().int().min(1).max(64).nullable(),
  error: nullableSummaryErrorSchema,
})
export type DstPlayerSummaryDto = z.infer<typeof dstPlayerSummarySchema>

export const roomSummariesSchema = z.object({
  items: z.array(z.object({ instance: instanceSummaryItemSchema, room: dstRoomSummarySchema })),
  collectedAt: z.string(),
})
export type RoomSummariesDto = z.infer<typeof roomSummariesSchema>

export const worldSummariesSchema = z.object({
  items: z.array(z.object({ instance: instanceSummaryItemSchema, world: dstWorldSummarySchema })),
  collectedAt: z.string(),
})
export type WorldSummariesDto = z.infer<typeof worldSummariesSchema>

export const playerSummariesSchema = z.object({
  items: z.array(z.object({ instance: instanceSummaryItemSchema, player: dstPlayerSummarySchema })),
  collectedAt: z.string(),
})
export type PlayerSummariesDto = z.infer<typeof playerSummariesSchema>
