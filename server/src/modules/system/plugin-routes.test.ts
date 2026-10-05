import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { PluginListResult } from '../../../../shared/contracts/plugin'
import { pluginListResultSchema } from '../../../../shared/contracts/plugin'
import { registerAuthModule } from '../auth/index'
import { registerSystemModule } from './index'
import { closeDatabase, initDatabase } from '../../shared/db/index'

/**
 * 插件管理接口的测试。
 *
 * 接口本身很薄，但它决定「谁能看、谁能改」：插件列表含能力与签名信息（属运维信息，
 * 只读权限可见），而启用/停用与导入插件包都会直接影响面板行为，必须管理权限。
 * 这里的用例把这条边界钉住。
 *
 * 导入用例盯的是**校验先于落盘**：签名不对或被篡改的包必须被拒绝，
 * 而且不能在任何位置留下残留目录——否则插件列表里会出现一个只能人工去删的条目。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-plugin-routes-'))
const dbFilePath = path.join(workDir, 'bubblesharkpanel.sqlite')
const pluginsRoot = path.join(workDir, 'plugins')
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

process.env.DB_PATH = dbFilePath
process.env.BSP_PLUGINS_ROOT = pluginsRoot
// 导入上传的临时目录也落在用例自己的目录里，不污染系统临时目录（与存档导入测试同一套做法）
process.env.BSP_SAVE_IMPORT_ROOT = path.join(workDir, 'save-import')

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

/**
 * 业务失败与未登录在这个项目里是两种信封，别混：
 * - 业务失败：`status: 1` + `error` 有内容（HTTP 200，前端拦截器按 `error` 判定失败）；
 * - 未登录/登录失效：`status: 0`。
 * 所以「导入被拒绝」的断言要看 `error`，不能看 `status`——写成 `status === 0`
 * 会让一个真的被拒绝的请求看起来像通过了。
 */
function expectBusinessError(responseBody: string, pattern: RegExp): void {
  const body = parseBody<unknown>(responseBody)
  assert.equal(body.status, 1, `业务失败不应改变 status，实际响应：${responseBody}`)
  assert.ok(body.error.length > 0, `业务失败必须给出原因，实际响应：${responseBody}`)
  assert.match(body.error, pattern)
}

function seedPlugin(directory: string, manifest: Record<string, unknown>): void {
  const pluginDir = path.join(pluginsRoot, directory)
  fs.mkdirSync(path.join(pluginDir, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(pluginDir, 'bin', 'plugin.js'), 'console.log("plugin")\n', 'utf8')
}

/**
 * 当场打一个 zip 插件包。
 *
 * 不用磁盘上的固定夹具：插件包的形状（有没有签名、清单对不对）正是这些用例要变的量，
 * 夹具文件一旦被谁手工改了就再也没人看得出来。`fflate` 已经是项目依赖。
 */
function buildZip(files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(files)) {
    entries[name] = new TextEncoder().encode(content)
  }
  return Buffer.from(zipSync(entries))
}

describe('plugin routes', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder, {
      adminUsername: 'superadmin',
      adminPassword: '123456',
      seedDevelopmentUsers: false,
    })
    fs.mkdirSync(pluginsRoot, { recursive: true })
    seedPlugin('demo-plugin', {
      id: 'demo-plugin',
      name: '演示插件',
      version: '1.0.0',
      apiVersion: 1,
      kind: 'community',
      entry: 'bin/plugin.js',
      capabilities: ['instances:read'],
      description: '仅用于测试',
    })
    // 少一层目录的坏插件：必须出现在列表里并给出原因，而不是让接口失败
    fs.mkdirSync(path.join(pluginsRoot, 'broken-dir'), { recursive: true })

    app = Fastify({ logger: false })
    registerAuthModule(app)
    registerSystemModule(app)
    await app.ready()

    const login = await app.inject({
      method: 'POST',
      url: '/app/account/login',
      payload: { account: 'superadmin', password: '123456' },
    })
    const body = parseBody<{ token: string }>(login.body)
    assert.equal(body.status, 1, `登录失败：${login.body}`)
    token = body.data.token
  })

  after(async () => {
    await app.close()
    closeDatabase()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('未登录时拒绝', async () => {
    const list = await app.inject({ method: 'GET', url: '/app/system/plugins' })
    assert.equal(parseBody<unknown>(list.body).status, 0)

    const toggle = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/toggle',
      payload: { pluginId: 'demo-plugin', enabled: true },
    })
    assert.equal(parseBody<unknown>(toggle.body).status, 0)
  })

  it('列表返回契约结构、宿主接口版本与插件根路径', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/app/system/plugins',
      headers: { token },
    })
    const body = parseBody<unknown>(response.body)
    assert.equal(body.status, 1, `接口应成功：${response.body}`)
    const parsed = pluginListResultSchema.safeParse(body.data)
    assert.equal(parsed.success, true, `响应不符合契约：${JSON.stringify(parsed.error?.issues)}`)
    const data = parsed.data!
    assert.equal(data.hostApiVersion, 1)
    assert.equal(data.pluginsRoot, pluginsRoot)
    assert.ok(data.items.some(item => item.id === 'demo-plugin' && item.state === 'disabled'))
    assert.ok(data.items.some(item => item.id === 'broken-dir' && item.state === 'invalid'))
  })

  it('启用与停用插件会改变状态', async () => {
    const enable = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/toggle',
      headers: { token },
      payload: { pluginId: 'demo-plugin', enabled: true },
    })
    const enableBody = parseBody<{ message: string }>(enable.body)
    assert.equal(enableBody.status, 1, `启用应成功：${enable.body}`)
    // 提示只说动作本身：「不影响运行中的实例」常驻在页面说明里，不在这里重复
    assert.match(enableBody.data.message, /已启用「演示插件」/)
    assert.doesNotMatch(enableBody.data.message, /独立进程/)

    const afterEnable = parseBody<{ items: Array<{ id: string, state: string }> }>((await app.inject({
      method: 'GET',
      url: '/app/system/plugins',
      headers: { token },
    })).body)
    assert.equal(afterEnable.data.items.find(item => item.id === 'demo-plugin')?.state, 'ready')

    const disable = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/toggle',
      headers: { token },
      payload: { pluginId: 'demo-plugin', enabled: false },
    })
    assert.equal(parseBody<{ message: string }>(disable.body).status, 1)
  })

  it('参数非法与插件不存在时给出业务错误', async () => {
    const badId = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/toggle',
      headers: { token },
      payload: { pluginId: 'Bad_ID', enabled: true },
    })
    assert.equal(parseBody<unknown>(badId.body).status, 1)
    assert.match(parseBody<unknown>(badId.body).error, /参数无效/)

    const missing = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/toggle',
      headers: { token },
      payload: { pluginId: 'not-installed', enabled: true },
    })
    assert.match(parseBody<unknown>(missing.body).error, /未找到插件/)
  })

  it('列表带上商店目录：未安装的官方插件也出现，且标记为未安装', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/app/system/plugins',
      headers: { token },
    })
    const data = parseBody<PluginListResult>(response.body).data

    // 本机装着的：installed 为 true
    const demo = data.items.find(item => item.id === 'demo-plugin')
    assert.equal(demo?.installed, true)

    // 目录里尚未安装的：也要出现，否则空目录时页面空无一物
    const shelf = data.items.find(item => item.id === 'pro-remote-backup')
    assert.ok(shelf, '官方目录里的插件应当出现在列表里')
    assert.equal(shelf.installed, false)
    assert.equal(shelf.directory, '', '未安装的条目不能给出一个猜测的目录名')
    assert.equal(shelf.store?.access.state, 'obtainable')
    assert.equal(shelf.store?.licenseSatisfied, false, '没有许可时应当如实报告缺授权')

    assert.ok(data.storeNotice.length > 0, '货架说明不能为空')
  })

  it('导入插件包分两步：先校验、后落位，导入后默认停用', async () => {
    const manifest = {
      id: 'pro-import-demo',
      name: '导入演示插件',
      version: '1.0.0',
      apiVersion: 1,
      kind: 'community',
      entry: 'plugin.js',
      capabilities: ['instances:read'],
      description: '用于导入测试',
    }
    const archive = buildZip({
      'plugin.json': JSON.stringify(manifest, null, 2),
      'plugin.js': 'console.log("imported")\n',
    })

    // 第一步：校验（要求管理权限）
    const inspectUnauthorized = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/import/inspect',
      headers: { 'content-type': 'application/x-bsp-plugin-package' },
      payload: archive,
    })
    assert.equal(parseBody<unknown>(inspectUnauthorized.body).status, 0, '未登录时应当拒绝')

    const inspect = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/import/inspect',
      headers: { token, 'content-type': 'application/x-bsp-plugin-package' },
      payload: archive,
    })
    const inspected = parseBody<{ uploadId: string, analysis: { pluginId: string, name: string } }>(inspect.body)
    assert.equal(inspected.status, 1, `校验应当成功：${inspect.body}`)
    assert.ok(inspected.data.uploadId, '第一步必须给出 uploadId，否则第二步无法认领这次上传')
    assert.equal(inspected.data.analysis.pluginId, 'pro-import-demo')
    // 校验阶段不写插件目录
    assert.equal(fs.existsSync(path.join(pluginsRoot, 'pro-import-demo')), false, '校验阶段不能落盘')

    // 第二步：凭 uploadId 落位
    const importResult = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/import',
      headers: { token },
      payload: { uploadId: inspected.data.uploadId },
    })
    const imported = parseBody<{ pluginId: string, state: string, message: string }>(importResult.body)
    assert.equal(imported.status, 1, `导入应当成功：${importResult.body}`)
    assert.equal(imported.data.state, 'disabled', '导入后必须保持停用')
    assert.ok(fs.existsSync(path.join(pluginsRoot, 'pro-import-demo', 'plugin.json')))

    // 导入后只出现在「已安装」里，不再以未获取的形态重复出现
    const after = parseBody<PluginListResult>((await app.inject({
      method: 'GET',
      url: '/app/system/plugins',
      headers: { token },
    })).body).data
    const matches = after.items.filter(item => item.id === 'pro-import-demo')
    assert.equal(matches.length, 1)
    assert.equal(matches[0]!.installed, true)
    assert.equal(matches[0]!.enabled, false)
  })

  it('签名被改动过的商业插件包会被拒绝，且不留下残留目录', async () => {
    const manifest = {
      id: 'pro-tampered',
      name: '被改过的插件',
      version: '1.0.0',
      apiVersion: 1,
      kind: 'commercial',
      entry: 'plugin.js',
      capabilities: ['instances:read'],
    }
    const archive = buildZip({
      'plugin.json': JSON.stringify(manifest, null, 2),
      'plugin.js': 'console.log("x")\n',
      // 签名是编造的：装载校验必须拒绝，而不是放行
      'plugin.signature.json': JSON.stringify({
        version: 1,
        pluginId: 'pro-tampered',
        publisher: 'gsh-official',
        signedAt: new Date().toISOString(),
        signature: Buffer.from('not-a-real-signature').toString('base64'),
      }),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/import/inspect',
      headers: { token, 'content-type': 'application/x-bsp-plugin-package' },
      payload: archive,
    })
    expectBusinessError(response.body, /签名|公钥/)
    assert.equal(fs.existsSync(path.join(pluginsRoot, 'pro-tampered')), false, '被拒的包不能污染插件目录')
  })

  it('不是压缩包的上传会被明确拒绝', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/import/inspect',
      headers: { token, 'content-type': 'application/x-bsp-plugin-package' },
      payload: Buffer.from('这不是一个压缩包'),
    })
    expectBusinessError(response.body, /解压|压缩包/)
  })

  it('压缩包里缺少 manifest 时说明该给什么', async () => {
    // 刻意换一个插件 id：前面的用例已经把 pro-import-demo 装进了目录，
    // 复用同一个 id 会让「目录已存在」先命中，测不到这条路径
    const archive = buildZip({ 'readme.txt': '这里没有 plugin.json\n' })
    const response = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/import/inspect',
      headers: { token, 'content-type': 'application/x-bsp-plugin-package' },
      payload: archive,
    })
    expectBusinessError(response.body, /找不到 plugin\.json/)
  })

  it('重复导入同一个插件会被拒绝，并说明要先停用或删目录', async () => {
    const manifest = {
      id: 'pro-import-demo',
      name: '导入演示插件',
      version: '1.0.0',
      apiVersion: 1,
      kind: 'community',
      entry: 'plugin.js',
      capabilities: ['instances:read'],
      description: '用于导入测试',
    }
    const archive = buildZip({
      'plugin.json': JSON.stringify(manifest, null, 2),
      'plugin.js': 'console.log("again")\n',
    })
    const response = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/import/inspect',
      headers: { token, 'content-type': 'application/x-bsp-plugin-package' },
      payload: archive,
    })
    expectBusinessError(response.body, /已经有/)
  })

  it('导入请求的 uploadId 非法时给出业务错误', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/import',
      headers: { token },
      payload: { uploadId: '../../etc' },
    })
    expectBusinessError(response.body, /导入记录无效|不存在|已清理/)
  })

  /**
   * 启用状态（`plugins.state.json`）与插件目录是两份数据，可能不一致：
   * 停用后手工删掉目录、过一阵再导入同一个插件，状态文件里可能还留着启用记录。
   * 那种情况下导入的包会被宿主立刻拉起来，而用户还没看过这份代码——
   * 「导入后默认停用」的承诺就此失效。
   */
  it('残留的启用记录不会让新导入的插件被直接拉起来', async () => {
    const pluginsRootDir = path.resolve(pluginsRoot)
    const manifest = {
      id: 'pro-stale-enabled',
      name: '残留启用记录演示',
      version: '1.0.0',
      apiVersion: 1,
      kind: 'community',
      entry: 'plugin.js',
      capabilities: ['instances:read'],
    }
    const archive = buildZip({
      'plugin.json': JSON.stringify(manifest, null, 2),
      'plugin.js': 'console.log("stale")\n',
    })

    // 伪造一份「该插件曾启用、目录却不存在」的状态文件
    fs.writeFileSync(
      path.join(pluginsRootDir, 'plugins.state.json'),
      `${JSON.stringify({ version: 1, enabled: ['pro-stale-enabled'] }, null, 2)}\n`,
      'utf8',
    )

    const inspect = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/import/inspect',
      headers: { token, 'content-type': 'application/x-bsp-plugin-package' },
      payload: archive,
    })
    const inspected = parseBody<{ uploadId: string }>(inspect.body)
    assert.equal(inspected.status, 1, `校验应当成功：${inspect.body}`)

    const imported = await app.inject({
      method: 'POST',
      url: '/app/system/plugins/import',
      headers: { token },
      payload: { uploadId: inspected.data.uploadId },
    })
    const body = parseBody<{ state: string }>(imported.body)
    assert.equal(body.status, 1, `导入应当成功：${imported.body}`)
    assert.equal(body.data.state, 'disabled')

    const list = parseBody<PluginListResult>((await app.inject({
      method: 'GET',
      url: '/app/system/plugins',
      headers: { token },
    })).body).data
    const item = list.items.find(entry => entry.id === 'pro-stale-enabled')
    assert.ok(item, '导入的插件应当出现在列表里')
    assert.equal(item.enabled, false, '残留的启用记录必须被清掉，导入后默认停用')

    // 清掉造的这份状态文件，避免影响后续用例
    fs.rmSync(path.join(pluginsRootDir, 'plugins.state.json'), { force: true })
  })
})
