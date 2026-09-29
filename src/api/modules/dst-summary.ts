import type {
  PlayerSummariesDto,
  RoomSummariesDto,
  WorldSummariesDto,
} from '../../../shared/contracts/dst-summary'
import type { InstanceListQuery } from '../../../shared/contracts/instance'
import api from '../index'

export type {
  DstPlayerSummaryDto,
  DstRoomSummaryDto,
  DstWorldShardSummaryDto,
  DstWorldSummaryDto,
  PlayerSummariesDto,
  RoomSummariesDto,
  WorldSummariesDto,
} from '../../../shared/contracts/dst-summary'

/**
 * DST 列表页的**按模块投影**接口。
 *
 * 三个列表页各有自己的读权限点，所以各有自己的接口：房间页 `room:read`、世界页 `world:read`、
 * 玩家页 `player:read`。共用一个要求 `instance:read` 的接口会让"看房间"被迫等于"能看实例管理"
 * （取消「查看实例」就会连带收走这些菜单）。每张投影只回自己那一列要用的字段。
 */
export default {
  getRoomSummaries: (data?: InstanceListQuery) => api.post('app/instance/room-summaries', data) as Promise<{
    data: RoomSummariesDto
  }>,
  getWorldSummaries: (data?: InstanceListQuery) => api.post('app/instance/world-summaries', data) as Promise<{
    data: WorldSummariesDto
  }>,
  getPlayerSummaries: (data?: InstanceListQuery) => api.post('app/instance/player-summaries', data) as Promise<{
    data: PlayerSummariesDto
  }>,
}
