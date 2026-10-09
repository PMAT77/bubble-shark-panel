import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { ClusterConfigDto } from '../../../../shared/contracts/cluster.ts'
import type { ShardListDto } from '../../../../shared/contracts/shard.ts'
import {
  buildInstanceStartGuideContext,
  buildStartGuideParagraphs,
  buildStartGuidePositiveText,
  INSTALL_DEFAULT_CLUSTER_DESCRIPTION,
  INSTALL_DEFAULT_MASTER_WORLDGEN_PRESET,
  getStartGuideSkipStorageKey,
  isRoomSettingsCustomized,
  isStartGuideSkipped,
  isWorldSettingsCustomized,
  setStartGuideSkipped,
} from './instanceStartGuide.ts'
import {
  buildInstallResultNotification,
  collectInstallResultNotifications,
  shouldShowPostCreateInstallGuide,
} from './instanceInstallGuide.ts'

function baseCluster(overrides: Partial<ClusterConfigDto> = {}): ClusterConfigDto {
  return {
    instanceId: 'inst-1',
    instanceName: 'My DST',
    instanceStatus: 'stopped',
    networkMode: 'offline',
    clusterName: 'My DST',
    clusterDescription: INSTALL_DEFAULT_CLUSTER_DESCRIPTION,
    clusterPassword: '',
    gameMode: 'survival',
    maxPlayers: 6,
    pvp: false,
    pauseWhenEmpty: true,
    voteEnabled: true,
    clusterIntention: 'cooperative',
    tickRate: 15,
    maxSnapshots: 6,
    shardEnabled: false,
    bindIp: '127.0.0.1',
    masterIp: '127.0.0.1',
    masterPort: 10888,
    clusterKey: 'key',
    steamGroupOnly: false,
    steamGroupId: '0',
    steamGroupAdmins: false,
    clusterTokenConfigured: false,
    clusterTokenMasked: null,
    panelRoomSaved: false,
    configDirty: false,
    effectiveHints: [],
    warnings: [],
    ...overrides,
  }
}

function baseShardList(overrides: Partial<ShardListDto> = {}): ShardListDto {
  return {
    instanceId: 'inst-1',
    instanceName: 'My DST',
    instanceStatus: 'stopped',
    clusterShardEnabled: false,
    shards: [
      {
        id: 'master',
        displayName: '主世界（地表）',
        configured: true,
        containerStatus: 'not_created',
        serverPort: 10999,
        steamAuthPort: 8766,
        steamMasterPort: 12346,
        worldgenPreset: INSTALL_DEFAULT_MASTER_WORLDGEN_PRESET,
        overrides: null,
        worldGenerated: false,
        isMaster: true,
        panelSaved: false,
        configDirty: false,
      },
    ],
    effectiveHints: [],
    warnings: [],
    ...overrides,
  }
}

describe('instanceStartGuide', () => {
  it('isWorldSettingsCustomized detects leveldata overrides', () => {
    const list = baseShardList({
      shards: [
        {
          ...baseShardList().shards[0]!,
          overrides: { world_size: 'medium' },
        },
      ],
    })
    assert.equal(isWorldSettingsCustomized(list), true)
    assert.equal(isRoomSettingsCustomized(baseCluster()), false)
  })

  it('world-only customized uses current-config copy and button', () => {
    const cluster = baseCluster()
    const shardList = baseShardList({
      shards: [
        {
          ...baseShardList().shards[0]!,
          overrides: { day: 'longer' },
        },
      ],
    })
    const ctx = buildInstanceStartGuideContext(
      { id: 'inst-1', name: 'My DST' },
      cluster,
      shardList,
    )
    assert.equal(ctx.worldCustomized, true)
    assert.equal(ctx.roomCustomized, false)
    assert.equal(buildStartGuidePositiveText(ctx), '按当前配置启动')
    const paragraphs = buildStartGuideParagraphs(ctx)
    assert.ok(paragraphs.some(p => p.includes('世界设置')))
    assert.ok(!paragraphs.some(p => p.includes('还没在面板里设置过「房间」和「地上世界」')))
  })

  it('neither customized offers default start button', () => {
    const ctx = buildInstanceStartGuideContext(
      { id: 'inst-1', name: 'My DST' },
      baseCluster(),
      baseShardList(),
    )
    assert.equal(buildStartGuidePositiveText(ctx), '用默认配置启动')
  })

  it('public without token blocks default start', () => {
    const ctx = buildInstanceStartGuideContext(
      { id: 'inst-1', name: 'My DST' },
      baseCluster({ networkMode: 'public' }),
      baseShardList(),
    )
    assert.equal(buildStartGuidePositiveText(ctx), '去配置房间')
  })

  it('panel save flags detect install-time presets with default values', () => {
    const ctx = buildInstanceStartGuideContext(
      { id: 'inst-1', name: '饥荒联机' },
      baseCluster({ instanceName: '饥荒联机', panelRoomSaved: true }),
      baseShardList({
        shards: [
          {
            ...baseShardList().shards[0]!,
            panelSaved: true,
          },
        ],
      }),
    )
    assert.equal(ctx.roomCustomized, true)
    assert.equal(ctx.worldCustomized, true)
    assert.equal(buildStartGuidePositiveText(ctx), '按当前配置启动')
    const paragraphs = buildStartGuideParagraphs(ctx)
    assert.ok(paragraphs.some(p => p.includes('已保存房间与地上世界设置')))
    assert.ok(!paragraphs.some(p => p.includes('还没在面板里设置过「房间」和「地上世界」')))
  })

  it('room + world customized is one merged sentence', () => {
    const ctx = buildInstanceStartGuideContext(
      { id: 'inst-1', name: '饥荒联机#1' },
      baseCluster({ instanceName: '饥荒联机#1', panelRoomSaved: true }),
      baseShardList({
        shards: [
          {
            ...baseShardList().shards[0]!,
            panelSaved: true,
          },
        ],
      }),
    )
    const paragraphs = buildStartGuideParagraphs(ctx)
    const merged = paragraphs.filter(p => p.includes('已保存房间与地上世界设置'))
    assert.equal(merged.length, 1)
    const sentence = merged[0]!
    assert.ok(sentence.includes('地图尚未生成'))
    assert.ok(sentence.includes('现在启动将按当前配置生成地图'))
    // 一句话：只有一个句末标点
    assert.equal(sentence.match(/。/g)?.length, 1)
    assert.ok(sentence.endsWith('。'))
  })
})

/** 内存版 Storage，供跳过标记用例注入（Node 默认没有 Web Storage） */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key)
    },
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
  } as Storage
}

describe('start guide skip storage', () => {
  const originalLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const originalSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')

  function installStorage() {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    })
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    })
  }

  afterEach(() => {
    for (const [name, descriptor] of [['localStorage', originalLocal], ['sessionStorage', originalSession]] as const) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor)
      }
      else {
        delete (globalThis as Record<string, unknown>)[name]
      }
    }
  })

  it('remembers the skip across browser sessions (localStorage)', () => {
    installStorage()
    const key = getStartGuideSkipStorageKey('inst-skip')
    assert.equal(isStartGuideSkipped('inst-skip'), false)
    setStartGuideSkipped('inst-skip')
    assert.equal(localStorage.getItem(key), '1')
    assert.equal(isStartGuideSkipped('inst-skip'), true)
  })

  it('migrates the legacy sessionStorage flag', () => {
    installStorage()
    const key = getStartGuideSkipStorageKey('inst-skip')
    sessionStorage.setItem(key, '1')
    assert.equal(isStartGuideSkipped('inst-skip'), true)
    assert.equal(localStorage.getItem(key), '1')
    assert.equal(sessionStorage.getItem(key), null)
  })
})

describe('instanceInstallGuide', () => {
  it('does not announce stopped as success, and notifies a fast accepted task once', () => {
    assert.equal(buildInstallResultNotification({ name: 'DST', status: 'stopped', lastErrorPhase: null }), null)
    const pending = new Map([['id', 'new-task']])
    const row = { id: 'id', name: 'DST', status: 'stopped', lastErrorPhase: null, installTaskId: 'new-task', installLogStatus: 'success' } as Parameters<typeof collectInstallResultNotifications>[0][number]
    assert.equal(collectInstallResultNotifications([{ ...row, installTaskId: 'old-task' }], pending).length, 0)
    assert.equal(pending.get('id'), 'new-task')
    assert.equal(collectInstallResultNotifications([row], pending)[0]?.type, 'success')
    assert.equal(collectInstallResultNotifications([row], pending).length, 0)
    const cancelled = buildInstallResultNotification({ ...row, installLogStatus: 'cancelled' })
    assert.equal(cancelled?.type, 'info')
    assert.match(cancelled!.content, /已取消/)
  })
  it('shows post-create guide only for DST during install statuses', () => {
    assert.equal(shouldShowPostCreateInstallGuide({ gameCode: '343050', status: 'pending_install' }), true)
    assert.equal(shouldShowPostCreateInstallGuide({ gameCode: '343050', status: 'installing' }), true)
    assert.equal(shouldShowPostCreateInstallGuide({ gameCode: '343050', status: 'stopped' }), false)
    assert.equal(shouldShowPostCreateInstallGuide({ gameCode: '570', status: 'installing' }), false)
  })

  it('builds top-right install terminal notifications with 5s duration', () => {
    assert.deepEqual(
      buildInstallResultNotification({ name: 'My DST', status: 'stopped', lastErrorPhase: null, installLogStatus: 'success' }),
      {
        type: 'success',
        title: '实例安装完成',
        content: '「My DST」安装完成，可以启动实例',
        durationMs: 5000,
      },
    )
    assert.deepEqual(
      buildInstallResultNotification({ name: 'My DST', status: 'error', lastErrorPhase: 'install' }),
      {
        type: 'error',
        title: '实例安装失败',
        content: '「My DST」安装失败：请查看安装日志',
        durationMs: 5000,
      },
    )
    // 安装就绪后启动失败也落在 error：那不是安装的结果，不该弹「安装失败」
    assert.equal(
      buildInstallResultNotification({ name: 'My DST', status: 'error', lastErrorPhase: 'runtime' }),
      null,
    )
    assert.equal(buildInstallResultNotification({ name: 'My DST', status: 'installing', lastErrorPhase: null }), null)
  })
})
