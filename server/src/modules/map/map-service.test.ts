import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { MapService } from './map-service'
import { MAP_CHUNK_MARKER, MAP_EXPORT_DONE_MARKER, MAP_MARK_MARKER, MAP_NAME_MARKER } from './map-export'
import { encodeTileRuns, splitIntoChunks } from './terrain-rle'
import { readMapArtifacts, resolveMapImagePath } from './map-store'
import { readPngSize } from './png'
import { computeFilledRatio } from './terrain-stats'

const tempDirs: string[] = []

function createTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** 造一份地形：宽度 × 高度，内容可指定 */
function makeTiles(width: number, height: number, fill?: (index: number) => number): Uint8Array {
  const tiles = new Uint8Array(width * height)
  for (let index = 0; index < tiles.length; index += 1) {
    tiles[index] = fill ? fill(index) : (index % 5) + 1
  }
  return tiles
}

interface FakeGame {
  logs: string[]
  commands: string[]
  /** 由测试决定"游戏"怎么回应 */
  behaviour: 'ok' | 'error' | 'silent' | 'partial' | 'corrupt-rle'
  errorCode: string
  tiles: Uint8Array | Uint16Array
  width: number
  height: number
  chunkSize: number
  /** 只发前 N 块（模拟日志被刷屏冲掉） */
  emitParts?: number
  /** 地标段的已编码内容（`pigking@1,2;...`）；空串 = 世界本来就没有地标 */
  marks: string
  /** 标记段的状态：`null` 表示脚本压根没打标记段（旧脚本 / 日志被刷掉） */
  marksStatus: 'ok' | 'no-ents' | null
  markChunkSize: number
  /** 地块名行的内容（`263=Ice Floe,264=Ice Floe`）；空串 = 游戏没回报名字 */
  tileNames: string
}

interface Harness {
  service: MapService
  fake: FakeGame
  dbPath: string
}

function createHarness(overrides: {
  running?: boolean
  behaviour?: FakeGame['behaviour']
  errorCode?: string
  tiles?: Uint8Array | Uint16Array
  width?: number
  height?: number
  chunkSize?: number
  emitParts?: number
  sendOk?: boolean
  freshWindowMs?: number
  pollMaxAttempts?: number
  marks?: string
  marksStatus?: 'ok' | 'no-ents' | null
  markChunkSize?: number
  tileNames?: string
  renderScale?: number
} = {}): Harness {
  const root = createTempDir('bsp-map-svc-')
  const dbPath = path.join(root, 'bubblesharkpanel.sqlite')
  const width = overrides.width ?? 4
  const height = overrides.height ?? 3

  const fake: FakeGame = {
    logs: [],
    commands: [],
    behaviour: overrides.behaviour ?? 'ok',
    errorCode: overrides.errorCode ?? 'no-map',
    tiles: overrides.tiles ?? makeTiles(width, height),
    width,
    height,
    chunkSize: overrides.chunkSize ?? 12,
    marks: overrides.marks ?? '',
    marksStatus: overrides.marksStatus === undefined ? 'ok' : overrides.marksStatus,
    markChunkSize: overrides.markChunkSize ?? 24,
    tileNames: overrides.tileNames ?? '',
    ...(overrides.emitParts === undefined ? {} : { emitParts: overrides.emitParts }),
  }

  const service = new MapService({
    dbPath,
    isShardRunning: async () => overrides.running ?? true,
    sendCommand: async (_instanceId, _shard, command) => {
      fake.commands.push(command)
      if (overrides.sendOk === false) {
        return { ok: false, message: '命令下发被拒绝' }
      }
      const token = new RegExp(`${MAP_EXPORT_DONE_MARKER}([0-9a-f]+):end`).exec(command)?.[1] ?? 'unknown'
      // 模拟游戏侧：把分块逐行打到控制台（真机上这是唯一可用的通道）
      setImmediate(() => {
        if (fake.behaviour === 'silent') {
          return
        }
        if (fake.behaviour === 'error') {
          fake.logs.push(`${MAP_EXPORT_DONE_MARKER}${fake.errorCode}`)
          fake.logs.push(`${MAP_EXPORT_DONE_MARKER}${token}:end`)
          return
        }
        const payload = fake.behaviour === 'corrupt-rle'
          ? 'zzzz'
          : encodeTileRuns(fake.tiles)
        const chunks = splitIntoChunks(payload, fake.chunkSize)
        const total = chunks.length
        fake.logs.push(
          `${MAP_EXPORT_DONE_MARKER}head:master:${fake.width}x${fake.height}:1608382646:${total}`,
        )
        const limit = fake.emitParts ?? total
        for (let index = 0; index < Math.min(total, limit); index += 1) {
          fake.logs.push(`${MAP_CHUNK_MARKER}${token}:${index}/${total}:${chunks[index]}`)
        }
        // 地块名与标记段永远紧跟在地形之后，与真实脚本一致
        if (fake.tileNames !== '') {
          fake.logs.push(`${MAP_NAME_MARKER}${fake.tileNames}`)
        }
        if (fake.marksStatus === 'no-ents') {
          fake.logs.push(`${MAP_MARK_MARKER}head:no-ents:0`)
        }
        else if (fake.marksStatus === 'ok') {
          const markChunks = fake.marks === '' ? [] : splitIntoChunks(fake.marks, fake.markChunkSize)
          fake.logs.push(`${MAP_MARK_MARKER}head:ok:${markChunks.length}`)
          for (let index = 0; index < markChunks.length; index += 1) {
            fake.logs.push(`${MAP_MARK_MARKER}${index}/${markChunks.length}:${markChunks[index]}`)
          }
        }
        fake.logs.push(`${MAP_EXPORT_DONE_MARKER}${token}:end`)
      })
      return { ok: true }
    },
    readLogLines: (_instanceId, afterId) => fake.logs.slice(afterId),
    currentLogId: () => fake.logs.length,
    sleep: async () => { await new Promise(resolve => setImmediate(resolve)) },
  }, {
    freshWindowMs: overrides.freshWindowMs ?? 3 * 60 * 1000,
    pollIntervalMs: 1,
    pollMaxAttempts: overrides.pollMaxAttempts ?? 5,
    ...(overrides.renderScale === undefined ? {} : { renderScale: overrides.renderScale }),
  })

  return { service, fake, dbPath }
}

describe('getState 初始状态', () => {
  it('没有图时是 idle 并给出下一步提示', () => {
    const { service } = createHarness()
    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'idle')
    assert.equal(state.imagePath, null)
    assert.match(state.message ?? '', /还没有这个分片的地形图/)
  })
})

describe('refresh 前置校验', () => {
  it('分片未运行时不下发命令，状态落到 failed', async () => {
    const { service, fake } = createHarness({ running: false })
    const result = service.refresh({ instanceId: 'inst-1', shard: 'master' })
    assert.equal(result.accepted, true)
    await service.waitForIdle('inst-1')
    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'failed')
    assert.match(state.message ?? '', /未运行/)
    assert.equal(fake.commands.length, 0)
  })

  it('命令下发失败时如实落到 failed', async () => {
    const { service } = createHarness({ sendOk: false })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'failed')
    assert.match(state.message ?? '', /命令下发被拒绝/)
  })
})

describe('成功路径：从控制台收块并出图', () => {
  it('收到头行与全部分块后渲染出图，元信息正确', async () => {
    const { service } = createHarness()
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')

    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'ready')
    assert.equal(state.width, 4)
    assert.equal(state.height, 3)
    assert.equal(state.seed, '1608382646')
    assert.equal(typeof state.ageSeconds, 'number')
    assert.match(state.imagePath ?? '', /^app\/instance\/map\/image\?/)
  })

  it('产出的是一张真正的 PNG，尺寸是"网格 × 渲染倍率"', async () => {
    const { service, dbPath } = createHarness({ width: 6, height: 5 })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')

    const size = readPngSize(fs.readFileSync(resolveMapImagePath(dbPath, 'inst-1', 'master')))
    assert.ok(size)
    // 默认 3 倍：出图分辨率高于显示尺寸，浏览器缩小显示，细节不丢
    assert.equal(size.width, 6 * 3)
    assert.equal(size.height, 5 * 3)
    const state = service.getState('inst-1', 'master')
    assert.equal(state.renderScale, 3)
    assert.equal(state.width, 6, 'DTO 里的尺寸是网格尺寸，不是像素尺寸')
  })

  it('渲染倍率可注入（真机上调清晰度只改一个数）', async () => {
    const { service, dbPath } = createHarness({ width: 2, height: 2, renderScale: 5 })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    const size = readPngSize(fs.readFileSync(resolveMapImagePath(dbPath, 'inst-1', 'master')))
    assert.equal(size?.width, 10)
    assert.equal(service.getState('inst-1', 'master').renderScale, 5)
  })

  it('分块很多时也能拼齐（模拟大世界）', async () => {
    const width = 40
    const height = 30
    const { service } = createHarness({
      width,
      height,
      tiles: makeTiles(width, height),
      chunkSize: 10,
    })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')

    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'ready')
    assert.equal(state.width, width)
    assert.equal(state.filledRatio, computeFilledRatio(makeTiles(width, height)))
  })

  it('下发的是单条 loadstring 命令，且不含写文件调用', async () => {
    const { service, fake } = createHarness()
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    const command = fake.commands[0]!
    assert.match(command, /^loadstring\("/)
    assert.equal(command.includes('\n'), false)
    assert.equal(command.includes('io.open'), false, '真机上 io.open 不可用')
    assert.equal(command.length < 4096, true)
  })
})

describe('失败与异常形态', () => {
  it('游戏回报失败码时翻译成人话', async () => {
    const { service } = createHarness({ behaviour: 'error', errorCode: 'no-map' })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'failed')
    assert.match(state.message ?? '', /还没有可读取的世界地图/)
    assert.equal(state.imagePath, null)
  })

  it('游戏不回应时按超时处理', async () => {
    const { service } = createHarness({ behaviour: 'silent' })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'failed')
    assert.match(state.message ?? '', /导出超时/)
  })

  it('**只收到部分分块时报不完整，绝不拼一张错位的地图**', async () => {
    const width = 40
    const height = 30
    const { service, dbPath } = createHarness({
      width,
      height,
      tiles: makeTiles(width, height),
      chunkSize: 10,
      emitParts: 2,
    })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')

    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'failed')
    assert.match(state.message ?? '', /地形数据不完整|导出超时/)
    assert.equal(fs.existsSync(resolveMapImagePath(dbPath, 'inst-1', 'master')), false, '不该产出图')
    assert.equal(readMapArtifacts(dbPath, 'inst-1', 'master'), null, '不该写元信息')
  })

  it('数据坏掉时报失败，不产出图', async () => {
    const { service, dbPath } = createHarness({ behaviour: 'corrupt-rle' })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'failed')
    /**
     * 坏数据的表现取决于坏在哪一步：
     * - 分块内容不是十六进制时，那些块收不齐 → 报"不完整/超时"；
     * - 收齐了但 RLE 结构坏 → 报解码失败。
     * 两种都必须走到 failed 且**不出图**，这才是要锁的行为。
     */
    assert.match(state.message ?? '', /地形数据不完整|导出超时|不是 8 的倍数|不是十六进制|不完整|超出预期/)
    assert.equal(fs.existsSync(resolveMapImagePath(dbPath, 'inst-1', 'master')), false)
  })

  it('失败后重新 refresh 会清掉上一次的失败信息', async () => {
    const harness = createHarness({ behaviour: 'error' })
    harness.service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await harness.service.waitForIdle('inst-1')
    assert.equal(harness.service.getState('inst-1', 'master').status, 'failed')

    harness.fake.behaviour = 'ok'
    harness.service.refresh({ instanceId: 'inst-1', shard: 'master', force: true })
    await harness.service.waitForIdle('inst-1')
    assert.equal(harness.service.getState('inst-1', 'master').status, 'ready')
  })
})

describe('新鲜窗口与并发', () => {
  it('窗口内重复 refresh 直接复用缓存，不再打扰游戏', async () => {
    const { service, fake } = createHarness()
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    assert.equal(fake.commands.length, 1)

    const second = service.refresh({ instanceId: 'inst-1', shard: 'master' })
    assert.equal(second.accepted === true ? second.status : '', 'ready')
    await service.waitForIdle('inst-1')
    assert.equal(fake.commands.length, 1, '窗口内不应再下发命令')
  })

  it('force 跳过新鲜窗口', async () => {
    const { service, fake } = createHarness()
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    service.refresh({ instanceId: 'inst-1', shard: 'master', force: true })
    await service.waitForIdle('inst-1')
    assert.equal(fake.commands.length, 2)
  })

  it('图过期后自动重新导出', async () => {
    const { service, fake, dbPath } = createHarness({ freshWindowMs: 1 })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')

    const artifacts = readMapArtifacts(dbPath, 'inst-1', 'master')!
    fs.writeFileSync(
      path.join(path.dirname(resolveMapImagePath(dbPath, 'inst-1', 'master')), 'result.json'),
      JSON.stringify({ ...artifacts, exportedAt: new Date(Date.now() - 60_000).toISOString() }),
      'utf8',
    )
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    assert.equal(fake.commands.length, 2)
  })

  it('同一实例并发 refresh 只跑一次', async () => {
    const { service, fake } = createHarness()
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    assert.equal(fake.commands.length, 1)
  })

  it('不同分片互不影响', async () => {
    const { service, fake } = createHarness()
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    service.refresh({ instanceId: 'inst-1', shard: 'caves', force: true })
    await service.waitForIdle('inst-1')
    assert.equal(fake.commands.length, 2)
  })
})

describe('clear', () => {
  it('清空后回到 idle，失败记录一并清掉', async () => {
    const { service } = createHarness({ behaviour: 'error' })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    assert.equal(service.getState('inst-1', 'master').status, 'failed')

    service.clear('inst-1')
    assert.equal(service.getState('inst-1', 'master').status, 'idle')
  })
})

describe('地标与图例', () => {
  it('收到地标时画进图、计入元信息、并出现在图例里', async () => {
    const { service } = createHarness({
      width: 8,
      height: 8,
      // 世界 (0,0) 在 8×8 地图上是网格 (4,4)——图内；地标坐标由脚本给出
      marks: 'pigking@0,0;cave_entrance@8,0',
    })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')

    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'ready')
    assert.equal(state.landmarkCount, 2)

    const landmarkEntries = state.legend.filter(entry => entry.kind === 'landmark')
    assert.deepEqual(landmarkEntries.map(entry => entry.label).sort(), ['洞穴入口', '猪王'])
    for (const entry of landmarkEntries) {
      assert.equal(entry.ratio, null, '地标没有"占比"这回事')
      assert.match(entry.color, /^#[0-9a-f]{6}$/)
      assert.equal(entry.count, 1)
    }
  })

  it('图例的地形项按占比降序，占比之和为 1，颜色与色板同源', async () => {
    const width = 4
    const height = 4
    // 一半草地、一半森林
    const tiles = new Uint8Array(width * height)
    for (let index = 0; index < tiles.length; index += 1) {
      tiles[index] = index < tiles.length / 2 ? 6 : 7
    }
    const { service } = createHarness({ width, height, tiles })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')

    const terrain = service.getState('inst-1', 'master').legend.filter(entry => entry.kind === 'terrain')
    assert.equal(terrain.length, 2)
    assert.equal(terrain[0]!.count, 8)
    assert.equal(terrain[0]!.ratio, 0.5)
    assert.equal(terrain[1]!.ratio, 0.5)
    assert.equal(terrain.reduce((sum, entry) => sum + (entry.ratio ?? 0), 0), 1)
    assert.equal(terrain[0]!.key, 'terrain:6', '计数相同时按 key 排，保证顺序稳定')
  })

  it('图例只列这张图上真实出现过的地块', async () => {
    const { service } = createHarness({ width: 3, height: 3, tiles: new Uint8Array(9).fill(6) })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    const terrain = service.getState('inst-1', 'master').legend.filter(entry => entry.kind === 'terrain')
    assert.deepEqual(terrain.map(entry => entry.key), ['terrain:6'])
    assert.equal(terrain[0]!.label, '草地')
  })

  it('白名单外的 prefab 被丢掉（脚本过滤之外的兜底）', async () => {
    // beefalo 是真实存在的实体，但不在关键地标白名单里——图上不该冒出一堆牛
    const { service } = createHarness({ width: 8, height: 8, marks: 'beefalo@0,0;pigking@0,0' })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    assert.equal(service.getState('inst-1', 'master').landmarkCount, 1)
  })

  it('脚本回传的地块名会用进图例：没收录的地块不再只有一个数字', async () => {
    const width = 4
    const height = 4
    // 263 是真机上出现过、但面板还没收录的地块
    const tiles = new Uint16Array(width * height).fill(263)
    const { service } = createHarness({ width, height, tiles, tileNames: '263=Ice Floe' })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')

    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'ready')
    const [entry] = state.legend.filter(item => item.kind === 'terrain')
    assert.ok(entry)
    assert.equal(entry.known, false)
    assert.equal(entry.label, 'Ice Floe（未收录）')
    // 未收录的地块要排在最前面：它通常面积极小，按占比排会沉到最底下，而它恰恰是要处理的那一项
    assert.equal(state.legend[0]!.key, 'terrain:263')
    assert.match(state.message ?? '', /未收录/)
  })

  it('游戏没给名字时退回"未收录地块 #N"，不会崩也不会空着', async () => {
    const width = 4
    const height = 4
    const { service } = createHarness({ width, height, tiles: new Uint16Array(width * height).fill(263) })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    const [entry] = service.getState('inst-1', 'master').legend.filter(item => item.kind === 'terrain')
    assert.equal(entry?.label, '未收录地块 #263')
  })

  it('图外的地标不画也不计数（图例不能出现图上找不到的项）', async () => {
    const { service } = createHarness({ width: 4, height: 3, marks: 'pigking@0,0;pigking@99999,99999' })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    assert.equal(service.getState('inst-1', 'master').landmarkCount, 1)
  })

  it('同一格里的多处地标只算一处（图上本来就是一个点）', async () => {
    const { service } = createHarness({ width: 8, height: 8, marks: 'pigking@0,0;pigking@1,1' })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    assert.equal(service.getState('inst-1', 'master').landmarkCount, 1)
  })

  it('标记分块跨块也能拼齐', async () => {
    const marks = ['pigking@0,0', 'cave_entrance@8,0', 'resurrectionstone@-8,0'].join(';')
    const { service } = createHarness({ width: 8, height: 8, marks, markChunkSize: 8 })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    assert.equal(service.getState('inst-1', 'master').landmarkCount, 3)
  })

  it('世界本来就没有地标时一切照常，不报警', async () => {
    const { service } = createHarness({ marks: '' })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'ready')
    assert.equal(state.landmarkCount, 0)
    assert.equal(state.message, null)
  })

  it('脚本没回标记段时只是没有地标，不影响这次导出', async () => {
    const { service } = createHarness({ marksStatus: null })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'ready', '增值信息缺失不该让整次导出失败')
    assert.equal(state.landmarkCount, 0)
  })

  it('实体表读不到时如实说明，而不是假装世界没有地标', async () => {
    const { service } = createHarness({ marksStatus: 'no-ents' })
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')
    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'ready')
    assert.match(state.message ?? '', /实体表|地标/)
  })

  it('重新生成后说明跟着更新（不会挂着上一次的提示）', async () => {
    const harness = createHarness({ marksStatus: 'no-ents' })
    harness.service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await harness.service.waitForIdle('inst-1')
    assert.match(harness.service.getState('inst-1', 'master').message ?? '', /实体表|地标/)

    harness.fake.marksStatus = 'ok'
    harness.service.refresh({ instanceId: 'inst-1', shard: 'master', force: true })
    await harness.service.waitForIdle('inst-1')
    assert.equal(harness.service.getState('inst-1', 'master').message, null)
  })

  it('旧版本的产物（没有 legend 字段）仍能读出来，只是没有图例', async () => {
    const { service, dbPath } = createHarness()
    service.refresh({ instanceId: 'inst-1', shard: 'master' })
    await service.waitForIdle('inst-1')

    // 模拟上一版面板写下的 result.json：没有 legend / renderScale
    const resultPath = path.join(path.dirname(resolveMapImagePath(dbPath, 'inst-1', 'master')), 'result.json')
    const stored = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, unknown>
    delete stored.legend
    delete stored.renderScale
    fs.writeFileSync(resultPath, JSON.stringify(stored), 'utf8')

    const state = service.getState('inst-1', 'master')
    assert.equal(state.status, 'ready', '读到旧产物不该当成"没有地图"')
    assert.deepEqual(state.legend, [])
    assert.equal(state.renderScale, 1, '旧产物是一格一像素渲染的')
  })
})

describe('computeFilledRatio', () => {
  it('空数组为 0，全非零为 1，按比例计算', () => {
    assert.equal(computeFilledRatio(new Uint8Array(0)), 0)
    assert.equal(computeFilledRatio(new Uint8Array([0, 0, 0, 0])), 0)
    assert.equal(computeFilledRatio(new Uint8Array([1, 1, 1, 1])), 1)
    assert.equal(computeFilledRatio(new Uint8Array([0, 1, 0, 1])), 0.5)
  })
})
