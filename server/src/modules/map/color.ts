/**
 * 颜色小工具。
 *
 * 单独成文件，是为了让「只有数据的色板目录」（`terrain-catalog.ts`）与「只有绘制的渲染器」
 * （`terrain-render.ts`）都不必为对方负责：目录要能查到颜色，渲染要能把颜色调暗、转成
 * CSS 用的十六进制，两者都只需要这几个纯函数。
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** 线性混合：`t=0` 取 `a`，`t=1` 取 `b`；`t` 会被钳到 0–1 */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const ratio = Math.min(1, Math.max(0, t))
  return {
    r: Math.round(a.r + (b.r - a.r) * ratio),
    g: Math.round(a.g + (b.g - a.g) * ratio),
    b: Math.round(a.b + (b.b - a.b) * ratio),
  }
}

/** 调暗：`amount=0` 原色，`amount=1` 全黑 */
export function darken(color: Rgb, amount: number): Rgb {
  return mix(color, { r: 0, g: 0, b: 0 }, amount)
}

/** 转 `#rrggbb`；图例要把颜色直接交给 CSS，必须带前导零 */
export function toHexColor(color: Rgb): string {
  const part = (value: number) => Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, '0')
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`
}

/**
 * HSL → RGB。
 *
 * 只有"给没收录的地块派生一个颜色"这一处用它，所以不做色域映射之类的高级处理，
 * 按标准公式算就行。
 */
function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation
  const h = ((hue % 360) + 360) % 360 / 60
  const x = c * (1 - Math.abs((h % 2) - 1))
  const [r1, g1, b1] = h < 1
    ? [c, x, 0]
    : h < 2
      ? [x, c, 0]
      : h < 3
        ? [0, c, x]
        : h < 4
          ? [0, x, c]
          : h < 5
            ? [x, 0, c]
            : [c, 0, x]
  const m = lightness - c / 2
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  }
}

/**
 * 地块 ID 段的类别基调。
 *
 * 用途只有一个：**未收录地块的派生色按它所属的色系走**，而不是自由散色相。
 * 起因是真机上那三个未收录地块（#263 / #269 / #272）——它们面积都很小，混在成片海洋里，
 * 自由散色相会把它们涂成与海面毫无关系的高饱和色块，一眼看去像渲染坏了；
 * 而它们本该是"海面里几块陌生的东西"。
 *
 * `hue` 取自 `terrain-catalog.ts` 里该段已收录地块的实际色相，所以基调与真实色板同源，不是另立一套。
 *
 * **257–288 这一段必须拆成两截**，不能合成一个"岸线"段：色板里这一段同时住着两种色系——
 * 257 猴岛沙滩是黄的（色相 43.6），264 浮冰是蓝的（色相 201.4）。按一个基调处理，要么把浮冰涂成沙滩黄、
 * 要么把沙滩涂成海蓝，两种都错。261 起给它海洋的基调：真机上那三个未收录号（263 / 269 / 272）
 * 就落在这一侧，游戏报回的名字（Ice Floe / Moon Crater / Rocky Beach）也都是水面地貌。
 */
export const TILE_TINTS: readonly { from: number, to: number, hue: number, saturation: number, lightness: number, tone: string }[] = [
  { from: 200, to: 256, hue: 210, saturation: 0.55, lightness: 0.46, tone: '海洋' },
  { from: 257, to: 260, hue: 35, saturation: 0.34, lightness: 0.72, tone: '沙滩' },
  { from: 261, to: 288, hue: 205, saturation: 0.34, lightness: 0.58, tone: '海洋（新增段）' },
]

/**
 * 给未收录地块挑一个类别基调；落在所有区段之外时返回 null（按自由散色相处理）。
 *
 * 为什么不给"陆地"也定一段：陆地的 ID 在 1–50 之间密集排列、色相跨度极大（草绿到沙漠土到岩石灰），
 * 一个基调色反而会比散色相更误导。只有这几段**同色系大面积铺开**的水面地貌里，
 * 混进去一个异色地块最刺眼，也最值得收敛。
 */
function tileTintFor(id: number): { hue: number, saturation: number, lightness: number } | null {
  const tint = TILE_TINTS.find(item => id >= item.from && id <= item.to)
  return tint ? { hue: tint.hue, saturation: tint.saturation, lightness: tint.lightness } : null
}

/**
 * 未收录地块的派生色。
 *
 * 为什么不是一律洋红：真机上遇到没收录的地块时（游戏新增了地块，面板还没跟上），
 * 洋红会把地图画得很难看，而用户真正需要的是"看得懂的地图 + 一条该补配色的提示"。
 * 这里按 ID 派生一个稳定颜色，保证不同 ID 分得开、同一个 ID 每次都一样；
 * 至于"这个地块还没收录"由**图例**去说，而不是靠把地图涂花来说。
 *
 * 派生规则分两支：
 * - 落在 `TILE_TINTS` 的段落里（海洋 / 岸线）→ **以该段基调色为基准**，只用黄金角在基调附近做小幅偏移，
 *   既与周围地形同一色系，又保持彼此可分；
 * - 其余 → 照旧按黄金角散色相。陆地的 ID 分布与色相跨度都不适合套一个基调。
 */
export function deriveTileColor(id: number): Rgb {
  const tint = tileTintFor(id)
  if (tint) {
    // 偏移量取 ±26 度以内：够让同类里的两三个地块分得开，又不足以跨出色系
    const offset = ((((Math.abs(id) * 137.508) % 52) + 26) % 52) - 26
    return hslToRgb(tint.hue + offset, tint.saturation, tint.lightness)
  }
  const hue = (Math.abs(id) * 137.508) % 360
  return hslToRgb(hue, 0.5, 0.6)
}
