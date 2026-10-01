import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  playerSummariesSchema,
  roomSummariesSchema,
  worldSummariesSchema,
} from '../../../../shared/contracts/dst-summary'

/**
 * 三张投影的契约形状。
 *
 * 这里钉住的不是"能不能解析"，而是**每张投影只带自己那一列要用的字段**：它们是三个独立的
 * 接口，各自只需要本模块的读权限点，所以玩家投影里不该出现房间配置、房间投影里不该出现
 * 分片细节，三者都不带安装路径与端口（实例标识用的是 `instanceSummaryItemSchema`）。
 */

const instance = {
  id: 'instance-1',
  name: 'DST Server',
  gameCode: '343050',
  status: 'running',
  lastCommand: null,
  lastError: null,
  lastErrorPhase: null,
}

describe('DST 投影接口的契约', () => {
  it('房间投影：房间字段 + 洞穴是否已配置，不含分片细节', () => {
    const result = roomSummariesSchema.parse({
      collectedAt: '2026-01-01T00:00:00.000Z',
      items: [{
        instance,
        room: {
          clusterName: 'My Room',
          networkMode: 'public',
          shardEnabled: true,
          cavesConfigured: true,
          onlinePlayerCount: 2,
          maxPlayers: 6,
          error: null,
        },
      }],
    })
    assert.equal(result.items[0]?.room.onlinePlayerCount, 2)
    assert.equal(result.items[0]?.room.cavesConfigured, true)
    assert.equal('world' in (result.items[0] ?? {}), false, '房间投影不该带世界字段')
  })

  it('世界投影：只有分片配置与容器状态', () => {
    const result = worldSummariesSchema.parse({
      collectedAt: '2026-01-01T00:00:00.000Z',
      items: [{
        instance,
        world: {
          clusterShardEnabled: true,
          master: { configured: true, containerStatus: 'running' },
          caves: { configured: true, containerStatus: 'running' },
          error: null,
        },
      }],
    })
    assert.equal(result.items[0]?.world.caves?.containerStatus, 'running')
    assert.equal('room' in (result.items[0] ?? {}), false, '世界投影不该带房间字段')
  })

  it('玩家投影：房间名（上下文标识）+ 人数，不含联网方式等房间配置', () => {
    const result = playerSummariesSchema.parse({
      collectedAt: '2026-01-01T00:00:00.000Z',
      items: [{
        instance,
        player: {
          clusterName: 'My Room',
          onlinePlayerCount: 3,
          maxPlayers: 6,
          error: null,
        },
      }],
    })
    assert.equal(result.items[0]?.player.onlinePlayerCount, 3)
    assert.equal(result.items[0]?.player.maxPlayers, 6)
  })

  it('实例标识不含安装路径与端口', () => {
    const parsed = roomSummariesSchema.parse({
      collectedAt: '2026-01-01T00:00:00.000Z',
      items: [{
        instance: { ...instance, installPath: '/srv/dst' },
        room: {
          clusterName: null,
          networkMode: null,
          shardEnabled: null,
          cavesConfigured: null,
          onlinePlayerCount: null,
          maxPlayers: null,
          error: '实例尚未完成安装',
        },
      }],
    })
    assert.deepEqual(
      Object.keys(parsed.items[0]!.instance).sort(),
      ['gameCode', 'id', 'lastCommand', 'lastError', 'lastErrorPhase', 'name', 'status'],
      '实例标识只该有这几个字段：多一个就说明安装路径/端口这类信息又漏出来了',
    )
  })

  it('未安装的实例作为行级原因给出', () => {
    assert.equal(roomSummariesSchema.safeParse({
      collectedAt: '2026-01-01T00:00:00.000Z',
      items: [{
        instance: { ...instance, status: 'pending_install' },
        room: {
          clusterName: null,
          networkMode: null,
          shardEnabled: null,
          cavesConfigured: null,
          onlinePlayerCount: null,
          maxPlayers: null,
          error: '实例尚未完成安装',
        },
      }],
    }).success, true)
  })
})
