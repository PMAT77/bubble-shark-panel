import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { migrationExportResultSchema } from '../../../../shared/contracts/backup'
import { registerAuthModule } from '../auth/index'
import { registerInstanceModule } from './index'
import { addUserInstanceGrants, closeDatabase, createGameInstance, findUserByAccount, initDatabase } from '../../shared/db/index'

/**
 * 迁移包导出的路由层测试。
 *
 * 这条链路的产物会被交到**另一台机器**上导入，所以测试盯的不是「接口返回 200」，
 * 而是三件会真正坑到人的事：
 *   1. 包内顶层必须就是集群目录（面板导入侧的识别口径），否则客户拿到一个导不进去的包；
 *   2. 没开过服的实例必须被明确拒绝，而不是导出空目录或顺手造一个集群目录；
 *   3. 报告里不能出现集群令牌与房间密码——报告会被贴进群里或发给客户。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-migration-export-'))
const dbFilePath = path.join(workDir, 'game-server-hub.sqlite')
const exportRoot = path.join(workDir, 'migration-exports')
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

process.env.DB_PATH = dbFilePath
process.env.GSH_MIGRATION_EXPORT_ROOT = exportRoot

const READY_INSTANCE_ID = `inst-${randomUUID()}`
const FRESH_INSTANCE_ID = `inst-${randomUUID()}`

interface ApiEnvelope<T> {
  status: 0 | 1
  error: string
  code: string
  data: T
}

let app: FastifyInstance
let token = ''

function parseBody<T>(body: string): ApiEnvelope<T> {
  return JSON.parse(body) as ApiEnvelope<T>
}

/** 系统 tar 不可用时（极少数 Windows 环境）跳过打包相关断言，其余用例照跑 */
function tarAvailable(): boolean {
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true })
  return probe.status === 0
}

/** 造一个「已经开过服」的实例目录：集群目录 + 两个分片 + 一份存档 */
function seedCluster(installPath: string): string {
  const clusterRoot = path.join(installPath, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1')
  fs.mkdirSync(path.join(clusterRoot, 'Master', 'save', 'session', 'KleiSession'), { recursive: true })
  fs.mkdirSync(path.join(clusterRoot, 'Caves', 'save', 'session'), { recursive: true })
  fs.writeFileSync(path.join(clusterRoot, 'cluster.ini'), [
    '[NETWORK]',
    'cluster_name = 迁移导出测试房',
    'cluster_password = secret-should-never-appear',
    'max_players = 6',
    '',
    '[GAMEPLAY]',
    'game_mode = survival',
    '',
  ].join('\n'))
  fs.writeFileSync(path.join(clusterRoot, 'cluster_token.txt'), 'pds-token-should-never-appear\n')
  fs.writeFileSync(path.join(clusterRoot, 'whitelist.txt'), 'KU_test-1\n')
  fs.writeFileSync(path.join(clusterRoot, 'Master', 'server.ini'), '[SHARD]\nis_master = true\nname = Master\n\n[NETWORK]\nserver_port = 10999\n')
  fs.writeFileSync(path.join(clusterRoot, 'Caves', 'server.ini'), '[SHARD]\nis_master = false\nname = Caves\n\n[NETWORK]\nserver_port = 11000\n')
  fs.writeFileSync(path.join(clusterRoot, 'Master', 'modoverrides.lua'), 'return {\n  ["workshop-123456"] = { enabled = true },\n}\n')
  fs.writeFileSync(path.join(clusterRoot, 'Master', 'save', 'session', 'KleiSession', 'world.txt'), 'world-data')
  return clusterRoot
}

/** 造一个「还没开过服」的实例目录：有安装目录，但没有集群配置 */
function seedFreshInstall(installPath: string): void {
  fs.mkdirSync(path.join(installPath, 'bin'), { recursive: true })
}

describe('migration export routes', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder, {
      adminUsername: 'superadmin',
      adminPassword: '123456',
      seedDevelopmentUsers: false,
    })

    const readyInstallPath = path.join(workDir, 'instances', READY_INSTANCE_ID)
    fs.mkdirSync(readyInstallPath, { recursive: true })
    seedCluster(readyInstallPath)
    fs.mkdirSync(path.join(readyInstallPath, 'steamapps'), { recursive: true })
    fs.mkdirSync(path.join(readyInstallPath, 'bin64'), { recursive: true })
    fs.writeFileSync(path.join(readyInstallPath, 'steamapps', 'appmanifest_343050.acf'), '"buildid" "25540104"')
    fs.writeFileSync(path.join(readyInstallPath, 'bin64', 'dontstarve_dedicated_server_nullrenderer_x64'), 'binary')
    fs.writeFileSync(path.join(readyInstallPath, 'version.txt'), '747465')
    await createGameInstance({
      id: READY_INSTANCE_ID,
      nodeId: 'local-node',
      name: '迁移导出测试实例',
      gameCode: '343050',
      status: 'stopped',
      installPath: readyInstallPath,
    })

    const freshInstallPath = path.join(workDir, 'instances', FRESH_INSTANCE_ID)
    seedFreshInstall(freshInstallPath)
    await createGameInstance({
      id: FRESH_INSTANCE_ID,
      nodeId: 'local-node',
      name: '尚未开服的实例',
      gameCode: '343050',
      status: 'stopped',
      installPath: freshInstallPath,
    })

    app = Fastify({ logger: false })
    registerAuthModule(app)
    registerInstanceModule(app)
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
    // FRESH_INSTANCE_ID 是"存在但还没开过服"的夹具：不授权就走不到业务分支
    await addUserInstanceGrants(admin.id, [READY_INSTANCE_ID, FRESH_INSTANCE_ID], null)
  })

  after(async () => {
    await app.close()
    closeDatabase()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('未登录时拒绝', async () => {
    for (const [url, payload] of [
      ['/app/instance/migration/report', { instanceId: READY_INSTANCE_ID }],
      ['/app/instance/migration/export', { instanceId: READY_INSTANCE_ID }],
      ['/app/instance/migration/download', { instanceId: READY_INSTANCE_ID, fileName: 'x.tar.gz' }],
    ] as const) {
      const response = await app.inject({ method: 'POST', url, payload })
      assert.equal(parseBody<unknown>(response.body).status, 0, `${url} 未登录时应当被拒`)
    }
  })

  it('实例不存在时给出业务错误', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/app/instance/migration/report',
      headers: { token },
      payload: { instanceId: 'not-exist' },
    })
    const body = parseBody<unknown>(response.body)
    assert.equal(body.status, 1)
    // 未授权与不存在返回同一种错误，这是有意的：不泄露某个实例 ID 是否存在
    assert.match(body.error, /(实例不存在|没有该实例的访问权限)/)
  })

  it('还没开过服的实例被明确拒绝，且不会顺手创建集群目录', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/app/instance/migration/report',
      headers: { token },
      payload: { instanceId: FRESH_INSTANCE_ID },
    })
    const body = parseBody<unknown>(response.body)
    assert.equal(body.status, 1)
    assert.match(body.error, /房间配置文件/)
    // 关键：拒绝之后不能留下一个空集群目录，否则下次就变成「可以导出空包」
    const clusterRoot = path.join(workDir, 'instances', FRESH_INSTANCE_ID, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1')
    assert.equal(fs.existsSync(path.join(clusterRoot, 'cluster.ini')), false)
  })

  describe('POST /app/instance/migration/report', () => {
    it('返回迁移报告：含分片端口、Mod 与名单，且不含令牌与密码', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/app/instance/migration/report',
        headers: { token },
        payload: { instanceId: READY_INSTANCE_ID },
      })
      const body = parseBody<unknown>(response.body)
      assert.equal(body.status, 1, `报告接口应成功：${response.body}`)
      const parsed = migrationExportResultSchema.safeParse(body.data)
      assert.equal(parsed.success, true, `响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
      const data = parsed.data!

      assert.equal(data.packaged, false)
      // 文件名只用 ASCII 安全字符；中文房间名出现在报告正文里
      assert.match(data.fileName, /^migration-[0-9a-zA-Z]+-Cluster_1\.tar\.gz$/)
      assert.match(data.reportText, /迁移导出测试房/)
      assert.match(data.reportText, /10999/)
      assert.match(data.reportText, /11000/)
      assert.match(data.reportText, /workshop-123456/)
      assert.match(data.reportText, /whitelist\.txt/)
      assert.match(data.reportText, /导入识别自检/)
      assert.match(data.reportText, /识别通过/)

      // 报告会被贴进群里、发给客户，凭据绝不能出现
      assert.doesNotMatch(data.reportText, /secret-should-never-appear/)
      assert.doesNotMatch(data.reportText, /pds-token-should-never-appear/)
      assert.doesNotMatch(response.body, /secret-should-never-appear/)
      assert.doesNotMatch(response.body, /pds-token-should-never-appear/)
    })
  })

  describe('POST /app/instance/migration/export', () => {
    it('产出包内顶层就是集群目录的 tar.gz，并写入校验和与报告', async (t) => {
      if (!tarAvailable()) {
        t.skip('系统 tar 不可用，跳过打包用例')
        return
      }
      const response = await app.inject({
        method: 'POST',
        url: '/app/instance/migration/export',
        headers: { token },
        payload: { instanceId: READY_INSTANCE_ID },
      })
      assert.equal(response.statusCode, 200, `导出应当成功，实际响应：${response.body?.slice(0, 500)}`)
      assert.match(response.headers['content-type'] ?? '', /application\/gzip/)
      const disposition = String(response.headers['content-disposition'] ?? '')
      assert.match(disposition, /attachment/)
      const fileName = /filename="([^"]+)"/.exec(disposition)?.[1]
      assert.ok(fileName, `响应头里应当有文件名：${disposition}`)

      // gzip 魔数：1f 8b（用 Buffer 断言，避免把二进制当文本比较）
      const raw = response.rawPayload
      assert.ok(raw.length > 0, '响应体不应为空')
      assert.equal(raw[0], 0x1f)
      assert.equal(raw[1], 0x8b)

      // 包内结构必须能被面板导入侧识别：顶层就是集群目录
      const archivePath = path.join(exportRoot, fileName)
      assert.equal(fs.existsSync(archivePath), true, '导出包应落在导出目录下')
      const listing = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8', windowsHide: true })
      assert.equal(listing.status, 0, `列包失败：${listing.stderr}`)
      const entries = listing.stdout.split('\n').map(line => line.trim()).filter(Boolean)
      assert.ok(entries.every(entry => entry.startsWith('Cluster_1/')), `包内顶层应当只有集群目录：${entries.slice(0, 5).join(', ')}`)
      assert.ok(entries.includes('Cluster_1/cluster.ini'), '包内必须含 cluster.ini')
      assert.ok(entries.includes('Cluster_1/Master/server.ini'))
      assert.ok(entries.every(entry => !/appmanifest_|version\.txt|dontstarve_dedicated_server/.test(entry)))

      assert.equal(fs.existsSync(`${archivePath}.sha256`), true, '应当写入同名 .sha256')
      const sha = fs.readFileSync(`${archivePath}.sha256`, 'utf8')
      assert.match(sha, /^[0-9a-f]{64}\s+/i)
    })

    it('导出目录里的包可被下载接口重新取回', async (t) => {
      if (!tarAvailable()) {
        t.skip('系统 tar 不可用，跳过打包用例')
        return
      }
      const exportResponse = await app.inject({
        method: 'POST',
        url: '/app/instance/migration/export',
        headers: { token },
        payload: { instanceId: READY_INSTANCE_ID },
      })
      const fileName = /filename="([^"]+)"/.exec(String(exportResponse.headers['content-disposition'] ?? ''))?.[1]
      assert.ok(fileName)

      const download = await app.inject({
        method: 'POST',
        url: '/app/instance/migration/download',
        headers: { token },
        payload: { instanceId: READY_INSTANCE_ID, fileName },
      })
      assert.equal(download.statusCode, 200)
      assert.ok(download.rawPayload.length > 0)
    })

    it('文件名带路径穿越时拒绝', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/app/instance/migration/download',
        headers: { token },
        payload: { instanceId: READY_INSTANCE_ID, fileName: '../../etc/passwd' },
      })
      assert.equal(response.statusCode, 400)
      assert.match(parseBody<unknown>(response.body).error, /文件名无效/)
    })

    it('包不存在时给出「重新导出」的明确提示', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/app/instance/migration/download',
        headers: { token },
        payload: { instanceId: READY_INSTANCE_ID, fileName: 'migration-deadbeef-Cluster_1.tar.gz' },
      })
      assert.equal(response.statusCode, 404)
      assert.match(parseBody<unknown>(response.body).error, /重新导出/)
    })
  })
})
