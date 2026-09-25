import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { toHexColor } from './color'
import { LANDMARK_CATALOG } from './landmark-catalog'
import { DEFAULT_TILE_PALETTE, TILE_CATALOG, isKnownTile } from './terrain-catalog'
import { buildLandmarkLegend, buildTerrainLegend, buildLegend } from './terrain-legend'
import type { MapLandmark } from './terrain-render'

/**
 * 真机上出现过、但面板还没收录配色的三个地块。
 *
 * 它们是这一层最真实的用例：游戏版本新增地块后，面板不认识这些号。要求只有一条——
 * **三个都要各自处理，不能只认第一个**：各自有独立的派生色、各自单独成项、各自带「未收录」。
 */
const REAL_UNCATALOGUED_IDS = [263, 269, 272]

describe('地形图例', () => {
  it('按格数降序，占比之和为 1', () => {
    const tiles = new Uint16Array([7, 7, 7, 6])
    const legend = buildTerrainLegend(tiles, DEFAULT_TILE_PALETTE)
    assert.deepEqual(legend.map(entry => entry.key), ['terrain:7', 'terrain:6'])
    assert.equal(legend[0]!.count, 3)
    assert.equal(legend[0]!.ratio, 0.75)
    assert.equal(legend[1]!.ratio, 0.25)
    assert.equal(legend.reduce((sum, entry) => sum + (entry.ratio ?? 0), 0), 1)
  })

  it('只列这张图上真实出现过的地块', () => {
    const legend = buildTerrainLegend(new Uint16Array([6, 6, 6]), DEFAULT_TILE_PALETTE)
    assert.deepEqual(legend.map(entry => entry.key), ['terrain:6'])
  })

  it('空地形得到空图例（世界还没生成时不该报错）', () => {
    assert.deepEqual(buildTerrainLegend(new Uint16Array(0), DEFAULT_TILE_PALETTE), [])
  })

  it('三个没收录的地块各自成项、各有独立颜色，且都排在最前面', () => {
    // 真机上的实际情形：这三种地块面积都很小，混在一堆海洋里
    const tiles = new Uint16Array(1000).fill(203)
    tiles[0] = 263
    tiles[1] = 263
    tiles[2] = 269
    tiles[3] = 272

    const legend = buildTerrainLegend(tiles, DEFAULT_TILE_PALETTE)
    const uncatalogued = legend.filter(entry => entry.key.startsWith('terrain:') && !entry.known)
    assert.deepEqual(
      uncatalogued.map(entry => entry.key),
      ['terrain:263', 'terrain:269', 'terrain:272'],
      '三个都要出现，一个都不能漏',
    )
    // 各自独立成项 = 各自独立颜色，否则图上三块分不开
    const colors = new Set(uncatalogued.map(entry => entry.color))
    assert.equal(colors.size, 3, `三个未收录地块应当是三种颜色，实际：${[...colors].join(', ')}`)
    // 按占比排的话它们会沉到最底下（各只占 0.1%），而那恰恰是要处理的三项
    assert.deepEqual(
      legend.slice(0, 3).map(entry => entry.key),
      ['terrain:263', 'terrain:269', 'terrain:272'],
    )
    // 占比仍然照实给：排序提前不代表可以虚报数字
    assert.equal(legend[0]!.ratio, 0.002)
  })

  it('游戏报回来的名字会替代"未收录地块 #N"', () => {
    const tiles = new Uint16Array([263, 269, 272])
    const gameNames = new Map([[263, 'Ice Floe'], [269, 'Moon Crater'], [272, 'Rocky Beach']])
    const legend = buildTerrainLegend(tiles, DEFAULT_TILE_PALETTE, gameNames)
    assert.deepEqual(
      legend.map(entry => entry.label),
      ['Ice Floe（未收录）', 'Moon Crater（未收录）', 'Rocky Beach（未收录）'],
    )
  })

  it('游戏没给名字时退回带 ID 的说法，而不是空字符串', () => {
    const legend = buildTerrainLegend(new Uint16Array([269]), DEFAULT_TILE_PALETTE)
    assert.equal(legend[0]!.label, '未收录地块 #269')
  })

  it('游戏只报了其中一部分名字时，其余仍然有说法', () => {
    const legend = buildTerrainLegend(
      new Uint16Array([263, 269, 272]),
      DEFAULT_TILE_PALETTE,
      new Map([[269, 'Moon Crater']]),
    )
    const labels = legend.filter(entry => !entry.known).map(entry => entry.label)
    assert.equal(labels.includes('Moon Crater（未收录）'), true)
    assert.equal(labels.includes('未收录地块 #263'), true)
    assert.equal(labels.includes('未收录地块 #272'), true)
  })

  it('收录过的地块不会被打上"未收录"', () => {
    const tiles = new Uint16Array([6, 7, 201, 42])
    const legend = buildTerrainLegend(tiles, DEFAULT_TILE_PALETTE)
    assert.equal(legend.every(entry => entry.known), true)
    for (const entry of legend) {
      assert.equal(entry.label.includes('未收录'), false)
    }
  })

  it('图例颜色与图上用的完全同源', () => {
    // 收录的用地板色，没收录的用派生色；两者都必须与 renderTerrain 取到的一致
    const tiles = new Uint16Array([6, 263])
    const legend = buildTerrainLegend(tiles, DEFAULT_TILE_PALETTE)
    assert.equal(legend.find(entry => entry.key === 'terrain:6')!.color, toHexColor(DEFAULT_TILE_PALETTE[6]!))
    // 派生色不进色板，但两次生成必须一致
    const again = buildTerrainLegend(tiles, DEFAULT_TILE_PALETTE)
    assert.equal(again.find(entry => entry.key === 'terrain:263')!.color, legend.find(entry => entry.key === 'terrain:263')!.color)
  })

  it('地形项没有形状，占比之外还带 known', () => {
    const legend = buildTerrainLegend(new Uint16Array([6]), DEFAULT_TILE_PALETTE)
    assert.equal(legend[0]!.kind, 'terrain')
    assert.equal(legend[0]!.shape, null)
    assert.equal(typeof legend[0]!.known, 'boolean')
  })
})

describe('地标图例', () => {
  const mark = (key: string, x = 0, z = 0): MapLandmark => ({ key, x, z })

  it('按分类键分组计数（同一种地标可能有好几处）', () => {
    const legend = buildLandmarkLegend([mark('cave_entrance'), mark('cave_entrance'), mark('pigking')])
    assert.equal(legend.length, 2)
    const cave = legend.find(entry => entry.key === 'landmark:cave_entrance')!
    assert.equal(cave.label, '洞穴入口')
    assert.equal(cave.count, 2)
    assert.equal(cave.ratio, null, '地标没有"占比"这回事')
  })

  it('每类地标各有自己的颜色，不再按"分类"共用一种', () => {
    // 真机反馈：洞穴入口与复活石同属"通道"，用同一种青色时用户分不出来
    const legend = buildLandmarkLegend([mark('cave_entrance'), mark('resurrectionstone'), mark('atrium_gate')])
    const colors = new Set(legend.map(entry => entry.color))
    assert.equal(colors.size, 3, `同类地标也要颜色分得开，实际：${[...colors].join(', ')}`)
  })

  it('形状按分类给：通道圆点、建筑方块、巢穴菱形', () => {
    const legend = buildLandmarkLegend([mark('cave_entrance'), mark('pigking'), mark('dragonfly')])
    const shapeOf = (key: string) => legend.find(entry => entry.key === `landmark:${key}`)!.shape
    assert.equal(shapeOf('cave_entrance'), 'circle')
    assert.equal(shapeOf('pigking'), 'square')
    assert.equal(shapeOf('dragonfly'), 'diamond')
  })

  it('目录里查不到的 key 也有名字与颜色，不会出现空色块', () => {
    const legend = buildLandmarkLegend([mark('some_new_thing')])
    assert.equal(legend[0]!.label, 'some_new_thing')
    assert.match(legend[0]!.color, /^#[0-9a-f]{6}$/)
    assert.equal(legend[0]!.known, true, '地标不存在"未收录"的说法，脚本的名单就是白名单')
  })

  it('没有地标时这一栏整个不出现', () => {
    assert.deepEqual(buildLandmarkLegend([]), [])
  })

  it('目录里每个地标都有独立颜色（19 类两两不撞）', () => {
    const colors = LANDMARK_CATALOG.map(spec => `${spec.color.r},${spec.color.g},${spec.color.b}`)
    assert.equal(new Set(colors).size, colors.length, '有两个地标用了同一个颜色')
  })
})

describe('合并图例', () => {
  it('地形在前、地标在后，且两者都带上', () => {
    const legend = buildLegend({
      tiles: new Uint16Array([6, 7]),
      palette: DEFAULT_TILE_PALETTE,
      landmarks: [{ key: 'pigking', x: 0, z: 0 }],
    })
    assert.deepEqual(legend.map(entry => entry.kind), ['terrain', 'terrain', 'landmark'])
  })

  it('目录与色板对得上：收录的地块一定查得到', () => {
    for (const spec of TILE_CATALOG) {
      assert.equal(isKnownTile(spec.id), true)
      assert.ok(DEFAULT_TILE_PALETTE[spec.id], `地块 ${spec.id} 有目录项却没有颜色`)
    }
  })

  it('真机那三个地块目前仍是"未收录"（补录后这条要跟着改）', () => {
    // 注意：这三个号的**着色**已经收敛到所属 ID 段的基调色系（见 terrain-render.test.ts 的
    // 「未收录地块的派生色」），但"有没有收录"这件事与着色无关——本条钉的是图例上的「未收录」标记。
    for (const id of REAL_UNCATALOGUED_IDS) {
      assert.equal(
        isKnownTile(id),
        false,
        `地块 ${id} 已经补进色板了——把本文件里依赖"未收录"的用例换成合成 ID（例如 60001/60002/60003）再跑`,
      )
    }
  })
})
