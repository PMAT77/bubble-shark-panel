import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { darken, deriveTileColor, mix } from './color'
import { TILE_CATALOG, tileLabel } from './terrain-catalog'
import {
  DEFAULT_TILE_PALETTE,
  DEFAULT_WORLD_TO_TILE,
  LANDMARK_COLOR,
  renderTerrain,
  worldToTile,
} from './terrain-render'

function pixelAt(image: { width: number, pixels: Buffer }, x: number, y: number) {
  const offset = (y * image.width + x) * 3
  return { r: image.pixels[offset]!, g: image.pixels[offset + 1]!, b: image.pixels[offset + 2]! }
}

/** RGB → HSL 色相；只用于比较"是不是同一个色系" */
function hueOf(color: { r: number, g: number, b: number }): number {
  const r = color.r / 255
  const g = color.g / 255
  const b = color.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) {
    return 0
  }
  const raw = max === r
    ? ((g - b) / delta) % 6
    : max === g
      ? (b - r) / delta + 2
      : (r - g) / delta + 4
  return ((raw * 60) % 360 + 360) % 360
}

/** 两个色相之间的最短夹角（0–180） */
function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360
  return diff > 180 ? 360 - diff : diff
}

describe('renderTerrain 基本渲染', () => {
  it('按要求尺寸出图，并按色板着色', () => {
    // 用真实的官方地块 ID：1 Impassable / 3 Rocky / 5 Savanna / 7 Forest
    const tiles = new Uint8Array([1, 3, 5, 7])
    // scale 1：这一组要验的是"网格 → 像素"的对应关系，放大倍率另有专门用例
    const image = renderTerrain({ width: 2, height: 2, tiles, scale: 1 })
    assert.equal(image.width, 2)
    assert.equal(image.height, 2)
    assert.deepEqual(pixelAt(image, 0, 0), DEFAULT_TILE_PALETTE[1])
    assert.deepEqual(pixelAt(image, 1, 0), DEFAULT_TILE_PALETTE[3])
    assert.deepEqual(pixelAt(image, 0, 1), DEFAULT_TILE_PALETTE[5])
    assert.deepEqual(pixelAt(image, 1, 1), DEFAULT_TILE_PALETTE[7])
  })

  it('行优先：索引 = y * width + x', () => {
    // 只有 (1,0) 是岩石地，验证不是按列优先摆的
    const tiles = new Uint8Array([5, 3, 5, 5])
    const image = renderTerrain({ width: 2, height: 2, tiles, scale: 1 })
    assert.deepEqual(pixelAt(image, 1, 0), DEFAULT_TILE_PALETTE[3])
    assert.deepEqual(pixelAt(image, 0, 1), DEFAULT_TILE_PALETTE[5])
  })

  it('没收录的地块按 ID 派生颜色：稳定、可区分，而不是留黑或一律洋红', () => {
    /**
     * 真机上确实会碰到面板还没收录的地块（游戏新增了地块）。此时的取舍是
     * "地图要能看"而不是"把地图涂花来报警"——缺配色这件事由图例与状态提示去说。
     */
    const draw = (tile: number) => pixelAt(
      renderTerrain({ width: 1, height: 1, tiles: new Uint16Array([tile]), scale: 1 }),
      0,
      0,
    )
    const first = draw(263)
    assert.notDeepEqual(first, { r: 0, g: 0, b: 0 }, '不能是黑块')
    assert.deepEqual(draw(263), first, '同一个 ID 每次都要是同一个颜色')
    assert.notDeepEqual(draw(258), first, '两个没收录的地块不能撞成同一个颜色')
  })

  it('自定义色板生效', () => {
    const tiles = new Uint8Array([7])
    const image = renderTerrain({
      width: 1,
      height: 1,
      tiles,
      scale: 1,
      palette: { 7: { r: 1, g: 2, b: 3 } },
    })
    assert.deepEqual(pixelAt(image, 0, 0), { r: 1, g: 2, b: 3 })
  })

  it('超过 255 的地块 ID 能正常取色（不是被截断成另一个 ID）', () => {
    // 264 = 浮冰；若某处又按 1 字节处理，这里会取到 8（沼泽）的颜色
    const tiles = new Uint16Array([264])
    const image = renderTerrain({ width: 1, height: 1, tiles, scale: 1 })
    assert.deepEqual(pixelAt(image, 0, 0), DEFAULT_TILE_PALETTE[264])
    assert.notDeepEqual(pixelAt(image, 0, 0), DEFAULT_TILE_PALETTE[8])
  })
})

describe('renderTerrain 校验', () => {
  it('尺寸非法时报错', () => {
    assert.throws(() => renderTerrain({ width: 0, height: 3, tiles: new Uint8Array(0) }), /尺寸非法/)
    assert.throws(() => renderTerrain({ width: 2.5, height: 3, tiles: new Uint8Array(0) }), /尺寸非法/)
  })

  it('地形数据长度不符时报错（绝不用半份数据出图）', () => {
    assert.throws(
      () => renderTerrain({ width: 2, height: 2, tiles: new Uint8Array(3) }),
      /长度不符：期望 4，实际 3/,
    )
  })
})

describe('放大渲染', () => {
  it('默认放大 3 倍：输出像素 = 网格 × 3', () => {
    const image = renderTerrain({ width: 4, height: 2, tiles: new Uint8Array(8).fill(6) })
    assert.equal(image.width, 12)
    assert.equal(image.height, 6)
    assert.equal(image.pixels.length, 12 * 6 * 3)
  })

  it('每一格被填成 scale × scale 的色块', () => {
    const tiles = new Uint8Array([6, 7])
    const image = renderTerrain({ width: 2, height: 1, tiles, scale: 4, outline: false })
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        assert.deepEqual(pixelAt(image, x, y), DEFAULT_TILE_PALETTE[6], `(${x},${y}) 应属于第一格`)
        assert.deepEqual(pixelAt(image, x + 4, y), DEFAULT_TILE_PALETTE[7], `(${x + 4},${y}) 应属于第二格`)
      }
    }
  })

  it('放大倍率被钳在 1–6，非法值回落默认', () => {
    assert.equal(renderTerrain({ width: 1, height: 1, tiles: new Uint8Array([6]), scale: 99 }).width, 6)
    assert.equal(renderTerrain({ width: 1, height: 1, tiles: new Uint8Array([6]), scale: 0 }).width, 1)
    assert.equal(renderTerrain({ width: 1, height: 1, tiles: new Uint8Array([6]), scale: Number.NaN }).width, 3)
  })
})

describe('地块边界描边', () => {
  it('相邻地块不同时，交界处画的是调暗后的颜色', () => {
    const tiles = new Uint8Array([6, 7])
    const image = renderTerrain({ width: 2, height: 1, tiles, scale: 3 })
    // 第 0 格的右边缘（列 1–2，宽 = round(3/2) = 2）被调暗
    assert.deepEqual(pixelAt(image, 0, 0), DEFAULT_TILE_PALETTE[6])
    assert.deepEqual(pixelAt(image, 1, 0), darken(DEFAULT_TILE_PALETTE[6]!, 0.35))
    assert.deepEqual(pixelAt(image, 2, 0), darken(DEFAULT_TILE_PALETTE[6]!, 0.35))
  })

  it('同质地形不描任何线（否则整张图会被网格吃的）', () => {
    const image = renderTerrain({ width: 3, height: 3, tiles: new Uint8Array(9).fill(6), scale: 3, gridStep: 0 })
    const colors = new Set<string>()
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const pixel = pixelAt(image, x, y)
        colors.add(`${pixel.r},${pixel.g},${pixel.b}`)
      }
    }
    assert.deepEqual([...colors], [`${DEFAULT_TILE_PALETTE[6]!.r},${DEFAULT_TILE_PALETTE[6]!.g},${DEFAULT_TILE_PALETTE[6]!.b}`])
  })

  it('outline:false 时边界保持原色', () => {
    const tiles = new Uint8Array([6, 7])
    const image = renderTerrain({ width: 2, height: 1, tiles, scale: 3, outline: false })
    assert.deepEqual(pixelAt(image, 1, 0), DEFAULT_TILE_PALETTE[6])
  })

  it('scale 为 1 时不描边（1 像素的线会把整格吃掉）', () => {
    const tiles = new Uint8Array([6, 7])
    const image = renderTerrain({ width: 2, height: 1, tiles, scale: 1 })
    assert.deepEqual(pixelAt(image, 0, 0), DEFAULT_TILE_PALETTE[6])
    assert.deepEqual(pixelAt(image, 1, 0), DEFAULT_TILE_PALETTE[7])
  })
})

describe('坐标网格', () => {
  it('按间隔画中性灰线，且不改动其它像素', () => {
    const image = renderTerrain({ width: 3, height: 1, tiles: new Uint8Array(3).fill(6), scale: 3, gridStep: 2 })
    const base = DEFAULT_TILE_PALETTE[6]!
    // 第 2 格（tileX=2）左边缘的 2 像素是网格线
    assert.deepEqual(pixelAt(image, 3, 0), base, 'tileX=1 的范围内不该有网格线')
    assert.deepEqual(pixelAt(image, 4, 0), mix(base, { r: 128, g: 128, b: 128 }, 0.35))
    assert.deepEqual(pixelAt(image, 5, 0), mix(base, { r: 128, g: 128, b: 128 }, 0.35))
  })

  it('gridStep 为 0 时完全不画网格', () => {
    const image = renderTerrain({ width: 4, height: 4, tiles: new Uint8Array(16).fill(6), scale: 3, gridStep: 0 })
    assert.deepEqual(pixelAt(image, 11, 0), DEFAULT_TILE_PALETTE[6])
  })

  it('网格线不会越出图外（最后一格之后不画）', () => {
    // 3 格、间隔 5：一条线都不该有
    const image = renderTerrain({ width: 3, height: 3, tiles: new Uint8Array(9).fill(6), scale: 3, gridStep: 5 })
    assert.deepEqual(pixelAt(image, 0, 0), DEFAULT_TILE_PALETTE[6])
    assert.deepEqual(pixelAt(image, 8, 8), DEFAULT_TILE_PALETTE[6])
  })
})

describe('worldToTile', () => {
  it('以地图中心为原点换算', () => {
    // 425×425 的世界，每格 4 单位：世界原点落在网格中心
    const transform = { unitsPerTile: 4 }
    assert.deepEqual(worldToTile(0, 0, 425, 425, transform), { tileX: 212, tileZ: 212 })
    assert.deepEqual(worldToTile(8, -12, 425, 425, transform), { tileX: 214, tileZ: 209 })
  })

  it('地图尺寸变了，同一个世界坐标落到不同格（原点不是写死的 0）', () => {
    assert.deepEqual(worldToTile(0, 0, 100, 100), { tileX: 50, tileZ: 50 })
    assert.deepEqual(worldToTile(0, 0, 200, 200), { tileX: 100, tileZ: 100 })
  })

  it('默认变换可用且是有限值', () => {
    assert.equal(Number.isFinite(DEFAULT_WORLD_TO_TILE.unitsPerTile), true)
    assert.equal(DEFAULT_WORLD_TO_TILE.unitsPerTile > 0, true)
  })

  it('每格单位数非法时回落到默认值，不产生 NaN 坐标', () => {
    const tile = worldToTile(4, 4, 10, 10, { unitsPerTile: 0 })
    assert.equal(Number.isFinite(tile.tileX), true)
    assert.deepEqual(tile, { tileX: 6, tileZ: 6 })
  })
})

describe('色板覆盖：真机数据回归', () => {
  /**
   * 这份 ID 列表来自 2026-09-21 在真机上对一座 425×425 主世界逐格采样得到的实际分布
   * （25 种地块）。它是一次真机快照，所以既是"色板必须覆盖"的回归清单，
   * 也是"新版本游戏多了地块"时的对照基准。
   */
  const REAL_WORLD_TILE_IDS = [
    203, 201, 204, 7, 6, 1, 5, 202, 3, 8, 31, 43, 30, 4, 42, 208, 205, 207, 44, 11, 2, 10, 12, 16, 13,
  ]

  it('真机上出现过的每种地块都有颜色，不会掉进回退色', () => {
    const missing = REAL_WORLD_TILE_IDS.filter(id => DEFAULT_TILE_PALETTE[id] === undefined)
    assert.deepEqual(missing, [], `这些地块 ID 缺映射，会在图上显示成回退色：${missing.join(', ')}`)
  })

  it('真机上出现过的每种地块都有中文名（图例靠它说话）', () => {
    const unnamed = REAL_WORLD_TILE_IDS.filter(id => tileLabel(id).includes('未识别'))
    assert.deepEqual(unnamed, [], `这些地块 ID 没有中文名：${unnamed.join(', ')}`)
  })

  it('真机上出现过的每种地块用的都是收录色，不是派生色', () => {
    const tiles = new Uint8Array(REAL_WORLD_TILE_IDS)
    const image = renderTerrain({ width: REAL_WORLD_TILE_IDS.length, height: 1, tiles, scale: 1 })
    for (let x = 0; x < REAL_WORLD_TILE_IDS.length; x += 1) {
      const id = REAL_WORLD_TILE_IDS[x]!
      assert.deepEqual(
        pixelAt(image, x, 0),
        DEFAULT_TILE_PALETTE[id],
        `地块 ${id} 用了派生色，说明它其实没被色板收录`,
      )
    }
  })

  it('海洋与陆地颜色分得开（海是蓝的、陆不是）', () => {
    const ocean = DEFAULT_TILE_PALETTE[201]!
    const land = DEFAULT_TILE_PALETTE[6]!
    // 海：蓝分量最高且明显高于红；陆：绿分量最高
    assert.equal(ocean.b > ocean.r + 40, true, '海洋应当偏蓝')
    assert.equal(land.g > land.b, true, '草地应当偏绿')
  })

  it('目录本身没有重复 ID', () => {
    const ids = TILE_CATALOG.map(spec => spec.id)
    assert.equal(new Set(ids).size, ids.length, '有 ID 被写了两次，后者会覆盖前者')
  })
})

describe('未收录地块的派生色', () => {
  it('真机那三个未收录地块落在海洋色系里，而不是散成三种无关颜色', () => {
    // 起因（2026-09-21 真机）：#263 / #269 / #272 面积都很小、混在成片海洋（203/204）里，
    // 自由散色相会把它们涂成与海面毫无关系的高饱和色块，看起来像渲染坏了。
    // 实测色相距离：263 → 15.0°、269 → 7.6°、272 → 4.3°。
    const oceanHue = hueOf(DEFAULT_TILE_PALETTE[203]!)
    for (const id of [263, 269, 272]) {
      const distance = hueDistance(hueOf(deriveTileColor(id)), oceanHue)
      assert.ok(
        distance <= 30,
        `地块 ${id} 的派生色与海洋色相差 ${distance.toFixed(1)}°，应当落在海洋色系内（≤30°）`,
      )
    }
  })

  it('257 一带的沙滩与 261 起的海洋新增段不共用基调', () => {
    // 这一段不能合成一个"岸线"段：色板里 257（猴岛沙滩，色相 43.6）是黄的、264（浮冰，色相 201.4）是蓝的。
    // 按一个基调处理，要么把浮冰涂成沙滩黄、要么把沙滩涂成海蓝，两种都错——这条用例钉住拆分。
    const beachHue = hueOf(DEFAULT_TILE_PALETTE[257]!)
    const floeHue = hueOf(DEFAULT_TILE_PALETTE[264]!)
    assert.ok(
      hueDistance(beachHue, floeHue) > 90,
      '257 与 264 本身就是两种色系，色板数据变了这条用例的前提也就不成立了',
    )
    const nearBeach = deriveTileColor(258)
    const nearFloe = deriveTileColor(263)
    assert.ok(
      hueDistance(hueOf(nearBeach), beachHue) <= 30,
      `同段（257–260）的未收录地块应当贴近沙滩色系，实际差 ${hueDistance(hueOf(nearBeach), beachHue).toFixed(1)}°`,
    )
    assert.ok(
      hueDistance(hueOf(nearFloe), floeHue) <= 40,
      `同段（261–288）的未收录地块应当贴近浮冰/海洋色系，实际差 ${hueDistance(hueOf(nearFloe), floeHue).toFixed(1)}°`,
    )
    assert.ok(
      hueDistance(hueOf(nearBeach), beachHue) < hueDistance(hueOf(nearBeach), floeHue),
      '260 及之前的号应当更靠近沙滩而不是浮冰',
    )
  })

  it('同一段落里两个未收录地块仍然分得开', () => {
    // 收敛色系不等于涂成同一个颜色——真机上三块要能互相分辨
    const colors = new Set([263, 269, 272].map(id => {
      const c = deriveTileColor(id)
      return `${c.r},${c.g},${c.b}`
    }))
    assert.equal(colors.size, 3, `三个未收录地块应当是三种颜色，实际：${[...colors].join(' / ')}`)
  })

  it('不在任何段落里的 ID 仍按自由散色相处理', () => {
    // 陆地 ID 在 1–50 之间密集且色相跨度极大，套一个基调色会比散色相更误导
    const hues = [60001, 60002, 60003].map(id => Math.round(hueOf(deriveTileColor(id))))
    assert.equal(new Set(hues).size, 3, `段落外的 ID 应当各自拿到不同色相，实际：${hues.join(', ')}`)
  })

  it('同一个 ID 每次派生出同一个颜色', () => {
    for (const id of [263, 60001]) {
      assert.deepEqual(deriveTileColor(id), deriveTileColor(id))
    }
  })
})

describe('地标标注', () => {
  it('把地标画成"白衬底 + 分类色"的圆点', () => {
    const tiles = new Uint8Array(25).fill(3)
    const image = renderTerrain({
      width: 5,
      height: 5,
      tiles,
      scale: 3,
      landmarks: [{ key: 'pigking', x: 0, z: 0, color: { r: 10, g: 200, b: 30 } }],
    })
    // 世界 (0,0) 在 5 格地图上 → 网格 (2,2)，格中心像素 = 2*3 + 1 = 7
    assert.deepEqual(pixelAt(image, 7, 7), { r: 10, g: 200, b: 30 })
    // 半径 6 内是分类色，再往外一圈是白色衬底
    assert.deepEqual(pixelAt(image, 13, 7), { r: 10, g: 200, b: 30 })
    assert.deepEqual(pixelAt(image, 14, 7), { r: 255, g: 255, b: 255 })
    assert.deepEqual(pixelAt(image, 0, 0), DEFAULT_TILE_PALETTE[3], '标记外的地形不受影响')
  })

  it('没给颜色时用默认标记色', () => {
    const image = renderTerrain({
      width: 5,
      height: 5,
      tiles: new Uint8Array(25).fill(3),
      scale: 3,
      landmarks: [{ key: 'k', x: 0, z: 0 }],
    })
    assert.deepEqual(pixelAt(image, 7, 7), LANDMARK_COLOR)
  })

  it('图外的地标被裁剪，不抛错也不越界写', () => {
    const image = renderTerrain({
      width: 2,
      height: 2,
      tiles: new Uint8Array(4).fill(3),
      scale: 1,
      landmarks: [
        { key: 'far', x: 99999, z: 99999 },
        { key: 'negative', x: -99999, z: -99999 },
      ],
    })
    // 整张图应当只有地形色，没有任何标记色
    const hasMark = [...image.pixels].some((_, index) => {
      const offset = Math.floor(index / 3) * 3
      return image.pixels[offset] === LANDMARK_COLOR.r
        && image.pixels[offset + 1] === LANDMARK_COLOR.g
        && image.pixels[offset + 2] === LANDMARK_COLOR.b
    })
    assert.equal(hasMark, false)
  })

  it('标记半径可覆盖（真机上太小时要能调大）', () => {
    const image = renderTerrain({
      width: 9,
      height: 9,
      tiles: new Uint8Array(81).fill(3),
      scale: 3,
      markRadius: 8,
      landmarks: [{ key: 'k', x: 0, z: 0, color: { r: 10, g: 200, b: 30 } }],
    })
    // 9 格地图的世界原点在网格 (4,4)，中心像素 = 4*3 + 1 = 13
    assert.deepEqual(pixelAt(image, 21, 13), { r: 10, g: 200, b: 30 })
    assert.deepEqual(pixelAt(image, 22, 13), { r: 255, g: 255, b: 255 })
  })

  it('标记半径有下限：给 0 也不会退化成一个看不见的点', () => {
    // 地图缩到面板宽度显示时，太小的点会被降采样吃掉，所以下限比"0 就是 0"重要
    const image = renderTerrain({
      width: 5,
      height: 5,
      tiles: new Uint8Array(25).fill(3),
      scale: 3,
      markRadius: 0,
      landmarks: [{ key: 'k', x: 0, z: 0, color: { r: 10, g: 200, b: 30 } }],
    })
    assert.deepEqual(pixelAt(image, 10, 7), { r: 10, g: 200, b: 30 })
    assert.deepEqual(pixelAt(image, 11, 7), { r: 255, g: 255, b: 255 })
  })
})
