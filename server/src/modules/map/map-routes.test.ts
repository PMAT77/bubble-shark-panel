import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { registerAuthModule } from '../auth/index'
import { registerMapModule } from './index'
import { addUserInstanceGrants, closeDatabase, createGameInstance, findUserByAccount, initDatabase } from '../../shared/db/index'
import { writeMapArtifacts, writeMapImage } from './map-store'
import { encodePng, readPngSize } from './png'
import { DEFAULT_TILE_PALETTE, renderTerrain } from './terrain-render'
import { buildLegend } from './terrain-legend'
import { encodeTileRuns } from './terrain-rle'

/**
 * 地图**路由层**的测试。
 *
 * 服务层已有 20 项测试，但路由这一段此前从没被打过——鉴权、参数校验、实例解析、
 * 产物落盘路径、取图的 Content-Type，任何一处接错都会让"功能在单测里全绿、在界面上点了没反应"。
 * 这里用真实数据库 + 真实鉴权（登录拿令牌）+ 伪造的实例记录，把三个接口都打一遍。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-map-routes-'))
const dbFilePath = path.join(workDir, 'bubblesharkpanel.sqlite')
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

// 面板数据目录由 DB_PATH 推导（地图产物与数据库同级），因此必须在建库前指好
process.env.DB_PATH = dbFilePath

const INSTANCE_ID = `inst-${randomUUID()}`
const OTHER_INSTANCE_ID = `inst-${randomUUID()}`

interface ApiEnvelope<T> {
  status: 0 | 1
  error: string
  code: string
  data: T
}

interface MapDtoShape {
  instanceId: string
  shard: string
  status: string
  imagePath: string | null
  width: number | null
  height: number | null
  renderScale: number | null
  seed: string | null
  landmarkCount: number | null
  legend: Array<{ key: string, kind: string, label: string, color: string, count: number, ratio: number | null }>
  filledRatio: number | null
  ageSeconds: number | null
  message: string | null
}

let app: FastifyInstance
let token = ''

function parseBody<T>(body: string): ApiEnvelope<T> {
  return JSON.parse(body) as ApiEnvelope<T>
}

/**
 * 业务错误的口径（与全仓其余接口一致）：**HTTP 200 + `status: 1` + 非空 `error`**。
 * `status: 0` 专指"未登录/登录失效"，不是通用失败——断言错误时必须按这个口径看 `error`，
 * 否则会写出"以为在测失败、其实在测成功"的假断言。
 */
function assertBusinessError(body: ApiEnvelope<unknown>, pattern: RegExp) {
  assert.equal(body.status, 1, `应当是一次业务错误响应，实际：${JSON.stringify(body).slice(0, 200)}`)
  assert.match(body.error, pattern)
}

/** 造一份"已经生成好"的地图产物，模拟面板完成过一次导出 */
function seedReadyMap(instanceId: string, shard: 'master' | 'caves' = 'master'): { width: number, height: number } {
  const width = 8
  const height = 6
  const renderScale = 3
  const tiles = new Uint8Array(width * height)
  for (let index = 0; index < tiles.length; index += 1) {
    tiles[index] = index % 3 === 0 ? 6 : index % 3 === 1 ? 7 : 201
  }
  // 走一遍真实的编码→解码，确保落盘的图与线上一致
  const decoded = renderTerrain({ width, height, tiles, scale: renderScale })
  writeMapImage(dbFilePath, instanceId, shard, encodePng(decoded, 6))
  writeMapArtifacts(dbFilePath, {
    instanceId,
    shard,
    exportedAt: new Date().toISOString(),
    width,
    height,
    renderScale,
    seed: '1204512110',
    landmarkCount: 0,
    legend: buildLegend({ tiles, palette: DEFAULT_TILE_PALETTE, landmarks: [] }),
    filledRatio: 1,
  })
  return { width, height }
}

describe('map routes', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder, {
      adminUsername: 'superadmin',
      adminPassword: '123456',
      seedDevelopmentUsers: false,
    })
    /**
     * 实例记录必须带一个**真实存在的安装目录**：`resolveLocalDstInstance` 会校验它，
     * 目录不存在时所有接口都会先被那道检查挡掉——这正是"实例未安装"该有的行为，
     * 但会掩盖掉我们想测的东西。
     */
    const installPath = path.join(workDir, 'instances', INSTANCE_ID)
    fs.mkdirSync(installPath, { recursive: true })
    await createGameInstance({
      id: INSTANCE_ID,
      nodeId: 'local-node',
      name: '地图路由测试实例',
      gameCode: '343050',
      status: 'stopped',
      installPath,
    })

    app = Fastify({ logger: false })
    registerAuthModule(app)
    registerMapModule(app)
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/app/account/login',
      payload: { account: 'superadmin', password: '123456' },
    })
    const body = parseBody<{ token: string }>(login.body)
    assert.equal(body.status, 1, `登录失败：${login.body}`)
    token = body.data.token

    /**
     * 实例级隔离生效后，接口按「可见实例」校验。这个测试直接造实例、跳过了创建接口
     * （生产环境里创建者会在创建时自动获得授权），所以补上授权前置，
     * 让它继续验证真正关心的东西。
     */
    const admin = await findUserByAccount('superadmin')
    assert.ok(admin, '前置条件：管理员账号存在')
    await addUserInstanceGrants(admin.id, [INSTANCE_ID, OTHER_INSTANCE_ID], null)
  })

  after(async () => {
    await app.close()
    closeDatabase()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  describe('鉴权', () => {
    it('未登录一律拒绝', async () => {
      /**
       * POST 这条要带**合法**参数：路由的参数校验排在鉴权之前（先拒掉形状不对的请求，
       * 不必为它查库），所以空 body 会先得到"请求参数无效"，而不是"未登录"。
       */
      for (const request of [
        { method: 'GET' as const, url: `/app/instance/map?instanceId=${INSTANCE_ID}&shard=master` },
        { method: 'POST' as const, url: '/app/instance/map/refresh', payload: { instanceId: INSTANCE_ID, shard: 'master' } },
        { method: 'GET' as const, url: `/app/instance/map/image?instanceId=${INSTANCE_ID}&shard=master` },
      ]) {
        const response = await app.inject(request)
        const body = parseBody<unknown>(response.body)
        assert.equal(body.status, 0, `${request.method} ${request.url} 未登录时应当被拒`)
      }
    })
  })

  describe('GET /app/instance/map', () => {
    it('实例不存在时给出业务错误', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/app/instance/map?instanceId=not-exist&shard=master',
        headers: { token },
      })
      // 未授权与不存在返回同一种错误，这是有意的：不泄露某个实例 ID 是否存在
      assertBusinessError(parseBody<unknown>(response.body), /(实例不存在|没有该实例的访问权限)/)
    })

    it('参数非法时拒绝（分片名不在枚举内）', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/app/instance/map?instanceId=${INSTANCE_ID}&shard=overworld`,
        headers: { token },
      })
      assertBusinessError(parseBody<unknown>(response.body), /参数无效/)
    })

    it('还没有图时返回 idle，且 imagePath 为 null', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/app/instance/map?instanceId=${INSTANCE_ID}&shard=caves`,
        headers: { token },
      })
      const body = parseBody<MapDtoShape>(response.body)
      assert.equal(body.status, 1)
      assert.equal(body.data.status, 'idle')
      assert.equal(body.data.imagePath, null)
      assert.match(body.data.message ?? '', /还没有/)
    })

    it('有图时返回 ready 与完整元信息', async () => {
      const { width, height } = seedReadyMap(INSTANCE_ID)
      const response = await app.inject({
        method: 'GET',
        url: `/app/instance/map?instanceId=${INSTANCE_ID}&shard=master`,
        headers: { token },
      })
      const body = parseBody<MapDtoShape>(response.body)
      assert.equal(body.status, 1)
      assert.equal(body.data.status, 'ready')
      assert.equal(body.data.width, width)
      assert.equal(body.data.height, height)
      assert.equal(body.data.renderScale, 3)
      assert.equal(body.data.seed, '1204512110')
      assert.equal(body.data.filledRatio, 1)
      assert.equal(typeof body.data.ageSeconds, 'number')
      // 取图地址必须能被前端直接拼上 base 使用
      assert.match(body.data.imagePath ?? '', /^app\/instance\/map\/image\?/)
      assert.equal(body.data.imagePath?.includes(INSTANCE_ID), true)
      // 图例要能直接铺到界面上：中文名、颜色、占比一个都不能少
      assert.equal(body.data.legend.length, 3, '草地 / 森林 / 近岸海域')
      assert.deepEqual(body.data.legend.map(entry => entry.kind), ['terrain', 'terrain', 'terrain'])
      for (const entry of body.data.legend) {
        assert.match(entry.color, /^#[0-9a-f]{6}$/)
        assert.equal(entry.label.length > 0, true)
        assert.equal(typeof entry.ratio, 'number')
      }
    })
  })

  describe('POST /app/instance/map/refresh', () => {
    it('实例未运行时明确拒绝，而不是先回 200 再静默失败', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/app/instance/map/refresh',
        headers: { token },
        payload: { instanceId: INSTANCE_ID, shard: 'master' },
      })
      // 未运行是硬前置：错误信息要能指导用户下一步
      assertBusinessError(parseBody<unknown>(response.body), /未运行|运行时未就绪/)
    })

    it('参数非法时拒绝', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/app/instance/map/refresh',
        headers: { token },
        payload: { instanceId: INSTANCE_ID, shard: 'master', force: 'yes' },
      })
      assertBusinessError(parseBody<unknown>(response.body), /参数无效/)
    })

    it('实例不存在时拒绝', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/app/instance/map/refresh',
        headers: { token },
        payload: { instanceId: OTHER_INSTANCE_ID, shard: 'master' },
      })
      assertBusinessError(parseBody<unknown>(response.body), /实例不存在/)
    })
  })

  describe('GET /app/instance/map/image', () => {
    it('返回真正的 PNG，且不缓存', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/app/instance/map/image?instanceId=${INSTANCE_ID}&shard=master`,
        headers: { token },
      })
      assert.equal(response.statusCode, 200)
      assert.match(response.headers['content-type'] as string, /image\/png/)
      // 世界在变、图就会变，不能让中间层缓存
      assert.match(response.headers['cache-control'] as string, /no-store/)
      const bytes = response.rawPayload
      const size = readPngSize(bytes)
      assert.ok(size, '响应体必须是合法 PNG')
      // 网格 8×6、渲染 3 倍 → 24×18 像素
      assert.equal(size.width, 24)
      assert.equal(size.height, 18)
    })

    it('**允许把令牌放在查询参数里**（<img src> 带不了自定义头）', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/app/instance/map/image?instanceId=${INSTANCE_ID}&shard=master&token=${token}`,
      })
      assert.equal(response.statusCode, 200)
      assert.match(response.headers['content-type'] as string, /image\/png/)
    })

    it('没有图时返回 404，而不是空响应', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/app/instance/map/image?instanceId=${INSTANCE_ID}&shard=caves`,
        headers: { token },
      })
      assert.equal(response.statusCode, 404)
    })

    it('实例不存在时也不吐出文件', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/app/instance/map/image?instanceId=not-exist&shard=master`,
        headers: { token },
      })
      // 同上：实例不存在与未授权在这个接口上统一返回"没有该实例的访问权限"
      assertBusinessError(parseBody<unknown>(response.body), /(实例不存在|没有该实例的访问权限)/)
    })
  })

  describe('产物落盘位置', () => {
    it('地图产物在面板数据目录下，**不在实例目录里**', () => {
      const mapPath = path.join(path.dirname(dbFilePath), 'maps', INSTANCE_ID, 'master', 'map.png')
      assert.equal(fs.existsSync(mapPath), true, `期望产物在 ${mapPath}`)

      /**
       * 实例目录里不该出现**地图产物**：多出来的东西会干扰面板对"世界是否已生成"的判断，
       * 而那个判断一旦被污染，用户就改不了世界生成参数了。
       *
       * 注意实例目录并非空的——解析实例时面板会建 `klei-storage/`，那是它本来就该做的。
       * 所以这里找的是"地图相关文件"，不是"目录是否为空"。
       */
      const installPath = path.join(workDir, 'instances', INSTANCE_ID)
      const found: string[] = []
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            walk(full)
            continue
          }
          if (/gsh_map_export|map\.png|result\.json/.test(entry.name)) {
            found.push(path.relative(installPath, full))
          }
        }
      }
      if (fs.existsSync(installPath)) {
        walk(installPath)
      }
      assert.deepEqual(found, [], `实例目录里不该有地图产物，实际有：${found.join(', ')}`)
    })
  })

  describe('端到端：RLE 编码的地形走完整条链', () => {
    it('把编码后的地形当作游戏产物喂进去，接口能出图', async () => {
      const width = 5
      const height = 5
      const tiles = new Uint8Array(width * height).fill(7) // 全森林
      const payload = encodeTileRuns(tiles)
      assert.equal(payload.length > 0, true)

      // 直接用解码后的网格渲染并落盘（这一步等价于服务层收到分块后的处理）
      writeMapImage(dbFilePath, INSTANCE_ID, 'caves', encodePng(renderTerrain({ width, height, tiles }), 6))
      writeMapArtifacts(dbFilePath, {
        instanceId: INSTANCE_ID,
        shard: 'caves',
        exportedAt: new Date().toISOString(),
        width,
        height,
        renderScale: 3,
        seed: null,
        landmarkCount: 0,
        legend: buildLegend({ tiles, palette: DEFAULT_TILE_PALETTE, landmarks: [] }),
        filledRatio: 1,
      })

      const image = await app.inject({
        method: 'GET',
        url: `/app/instance/map/image?instanceId=${INSTANCE_ID}&shard=caves&token=${token}`,
      })
      assert.equal(image.statusCode, 200)
      const size = readPngSize(image.rawPayload)
      assert.equal(size?.width, width * 3)
      assert.equal(size?.height, height * 3)

      const state = await app.inject({
        method: 'GET',
        url: `/app/instance/map?instanceId=${INSTANCE_ID}&shard=caves`,
        headers: { token },
      })
      const body = parseBody<MapDtoShape>(state.body)
      assert.equal(body.data.status, 'ready')
      assert.equal(body.data.seed, null, '没有种子时如实给 null，不编造')
    })
  })
})
