/**
 * 真实 HTTP 冒烟：起真服务器 + 真数据库 + 真 PNG，用 fetch 打三个地图接口。
 *
 * 与 `map-routes.test.ts` 的区别：那个走 `app.inject`（进程内直接调 handler，不经过网络栈）。
 * 这个脚本真的监听一个端口、发真的 HTTP 请求，覆盖的是"路由挂上了吗、Content-Type 与
 * 二进制响应经网络传回来还对吗"这一类只有真跑起来才暴露的问题。
 *
 * 用法（在仓库根目录）：
 *   pnpm exec tsx server/scripts/map-http-smoke.ts
 *
 * 它会在临时目录建库、造一条实例记录与一份地图产物，跑完自己清理，不碰仓库里的 data/。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-map-smoke-'))
const dbPath = path.join(workDir, 'bubblesharkpanel.sqlite')
const migrationsFolder = path.join(repoRoot, 'server', 'drizzle')
const instanceId = `smoke-${randomUUID()}`
const installPath = path.join(workDir, 'instances', instanceId)

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  const mark = ok ? '✔' : '✖'
  if (!ok) {
    failures += 1
  }
  process.stdout.write(`${mark} ${label}${detail ? ` —— ${detail}` : ''}\n`)
}

async function main() {
  // 面板数据目录由 DB_PATH 推导，必须在建库前指好
  process.env.DB_PATH = dbPath

  const { initDatabase, createGameInstance, closeDatabase } = await import('../src/shared/db/index')
  const { registerAuthModule } = await import('../src/modules/auth/index')
  const { registerMapModule } = await import('../src/modules/map/index')
  const { writeMapImage, writeMapArtifacts } = await import('../src/modules/map/map-store')
  const { encodePng, readPngSize } = await import('../src/modules/map/png')
  const { DEFAULT_TILE_PALETTE, renderTerrain } = await import('../src/modules/map/terrain-render')
  const { buildLegend } = await import('../src/modules/map/terrain-legend')

  fs.mkdirSync(installPath, { recursive: true })
  await initDatabase(dbPath, migrationsFolder, {
    adminUsername: 'superadmin',
    adminPassword: '123456',
    seedDevelopmentUsers: false,
  })
  await createGameInstance({
    id: instanceId,
    nodeId: 'local-node',
    name: '地图冒烟实例',
    gameCode: '343050',
    status: 'stopped',
    installPath,
  })

  // 造一份真实的产物：用官方地块 ID（6 草地 / 7 森林 / 201 近岸海）
  const width = 64
  const height = 48
  const renderScale = 3
  const tiles = new Uint8Array(width * height)
  for (let index = 0; index < tiles.length; index += 1) {
    const x = index % width
    const y = Math.floor(index / width)
    const isWater = x < 6 || y < 4 || x > width - 7 || y > height - 5
    tiles[index] = isWater ? 201 : (x + y) % 5 === 0 ? 7 : 6
  }
  writeMapImage(dbPath, instanceId, 'master', encodePng(renderTerrain({ width, height, tiles, scale: renderScale }), 6))
  writeMapArtifacts(dbPath, {
    instanceId,
    shard: 'master',
    exportedAt: new Date().toISOString(),
    width,
    height,
    renderScale,
    seed: '1204512110',
    landmarkCount: 0,
    legend: buildLegend({ tiles, palette: DEFAULT_TILE_PALETTE, landmarks: [] }),
    filledRatio: 1,
  })

  const app = Fastify({ logger: false })
  registerAuthModule(app)
  registerMapModule(app)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const base = `http://127.0.0.1:${port}`
  process.stdout.write(`服务器已起：${base}\n\n`)

  try {
    // 1) 登录拿令牌
    const login = await fetch(`${base}/app/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'superadmin', password: '123456' }),
    })
    const loginBody = await login.json() as { status: number, data?: { token?: string } }
    const token = loginBody.data?.token ?? ''
    check('登录拿到令牌', login.status === 200 && Boolean(token))

    // 2) 状态接口
    const state = await fetch(`${base}/app/instance/map?instanceId=${instanceId}&shard=master`, {
      headers: { token },
    })
    const stateBody = await state.json() as {
      status: number
      data: {
        status: string
        width: number
        height: number
        renderScale: number
        imagePath: string | null
        seed: string | null
        legend: Array<{ kind: string, label: string, color: string, ratio: number | null }>
      }
    }
    check('状态接口 HTTP 200', state.status === 200)
    check('状态为 ready', stateBody.data?.status === 'ready', `实际 ${stateBody.data?.status}`)
    check(
      '元信息正确',
      stateBody.data?.width === width && stateBody.data?.height === height && stateBody.data?.seed === '1204512110',
      `${stateBody.data?.width}x${stateBody.data?.height} seed=${stateBody.data?.seed}`,
    )
    check('给出取图地址', typeof stateBody.data?.imagePath === 'string' && stateBody.data.imagePath.length > 0)
    check('渲染倍率随元信息返回', stateBody.data?.renderScale === renderScale, `实际 ${stateBody.data?.renderScale}`)
    check(
      '**图例经网络传回且中文名与颜色齐全**',
      Array.isArray(stateBody.data?.legend) && stateBody.data.legend.length > 0
      && stateBody.data.legend.every(entry => entry.label.length > 0 && /^#[0-9a-f]{6}$/.test(entry.color)),
      `${stateBody.data?.legend?.length ?? 0} 项`,
    )

    // 3) 取图接口（走请求头令牌）
    const image = await fetch(`${base}/app/instance/map/image?instanceId=${instanceId}&shard=master`, {
      headers: { token },
    })
    const imageBytes = Buffer.from(await image.arrayBuffer())
    const size = readPngSize(imageBytes)
    check('取图 HTTP 200', image.status === 200)
    check('Content-Type 是 image/png', (image.headers.get('content-type') ?? '').includes('image/png'), image.headers.get('content-type') ?? '')
    check('声明不缓存', (image.headers.get('cache-control') ?? '').includes('no-store'))
    check('**经网络传回的字节仍是合法 PNG**', size !== null, size ? `${size.width}x${size.height}` : '不是 PNG')
    check('图片尺寸 = 网格 × 渲染倍率', size?.width === width * renderScale && size?.height === height * renderScale, `${size?.width}x${size?.height}`)
    check('字节数与落盘一致', imageBytes.length === fs.statSync(path.join(path.dirname(dbPath), 'maps', instanceId, 'master', 'map.png')).size)

    // 4) 取图接口（令牌放查询参数，模拟 <img src>）
    const viaQuery = await fetch(`${base}/app/instance/map/image?instanceId=${instanceId}&shard=master&token=${encodeURIComponent(token)}`)
    check('**查询参数传令牌也能取图**（<img src> 场景）', viaQuery.status === 200 && (await viaQuery.arrayBuffer()).byteLength > 0)

    // 5) 未登录被拒
    const anon = await fetch(`${base}/app/instance/map?instanceId=${instanceId}&shard=master`)
    const anonBody = await anon.json() as { status: number }
    check('未登录被拒（status=0）', anonBody.status === 0)

    // 6) 触发接口：实例未运行时给业务错误而不是 500
    const refresh = await fetch(`${base}/app/instance/map/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token },
      body: JSON.stringify({ instanceId, shard: 'master' }),
    })
    const refreshBody = await refresh.json() as { status: number, error: string }
    check('未运行时触发被明确拒绝', refresh.status === 200 && refreshBody.status === 1 && /未运行|未就绪/.test(refreshBody.error), refreshBody.error)

    // 7) 产物不落实例目录
    const leaked: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        }
        else if (/gsh_map_export|map\.png|result\.json/.test(entry.name)) {
          leaked.push(full)
        }
      }
    }
    if (fs.existsSync(installPath)) {
      walk(installPath)
    }
    check('实例目录里没有地图产物', leaked.length === 0, leaked.join(', '))
  }
  finally {
    await app.close()
    closeDatabase()
    fs.rmSync(workDir, { recursive: true, force: true })
  }

  process.stdout.write(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`冒烟失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
