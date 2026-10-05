import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { closeDatabase, createGameInstance, initDatabase } from '../shared/db/index'
import { createPluginRuntime } from './host'
import type { PluginRuntime } from './host'
import { loadPluginDirectory } from './manifest'
import { readPluginAudit, resolvePluginAuditRoot, summarizeAuditParams } from './audit-store'

/**
 * 插件进程生命周期的集成测试（真实起进程）。
 *
 * 这里不 mock 子进程：插件与宿主之间的约定全在「环境变量 + 回环 HTTP + 一次性令牌」上，
 * mock 掉就等于把要验的东西全绕过去了。测试会在临时目录里生成一个最小插件脚本，
 * 它调用已声明的能力、故意调用未声明的能力、然后把结果写回自己的目录。
 *
 * 覆盖三件事：
 * 1. 启用的插件真的被拉起来（有 PID、状态 running）；
 * 2. 能力按声明授予——声明过的能调通，没声明的被拒（403）；
 * 3. 停用/关闭时进程被真正终止，不留孤儿进程。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-plugin-host-'))
const pluginsRoot = path.join(workDir, 'plugins')
const auditRoot = path.join(workDir, 'plugin-audit')
const dbFilePath = path.join(workDir, 'bubblesharkpanel.sqlite')
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle')

process.env.DB_PATH = dbFilePath
process.env.BSP_PLUGINS_ROOT = pluginsRoot
process.env.BSP_PLUGIN_AUDIT_ROOT = auditRoot

/**
 * 最小插件脚本：读环境变量 → 调 capability → 写 result.json → 退出。
 * 退出码 0 表示"做完了"，宿主不会把它当成崩溃重启。
 */
const MINIMAL_PLUGIN_SOURCE = `
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const pluginId = process.env.BSP_PLUGIN_ID ?? ''
const baseUrl = process.env.BSP_CAPABILITY_URL ?? ''
const token = process.env.BSP_PLUGIN_TOKEN ?? ''
const pluginDir = process.env.BSP_PLUGIN_DIR ?? process.cwd()

async function call(pathname, body = {}) {
  const response = await fetch(baseUrl + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bsp-plugin-token': token },
    body: JSON.stringify({ pluginId, ...body }),
  })
  return { status: response.status, body: await response.json() }
}

async function main() {
  const allowed = await call('/capabilities/instances')
  const denied = await call('/capabilities/console', { instanceId: 'x' })
  const noToken = await fetch(baseUrl + '/capabilities/instances', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pluginId }),
  })
  fs.writeFileSync(path.join(pluginDir, 'result.json'), JSON.stringify({
    allowedStatus: allowed.status,
    instanceCount: Array.isArray(allowed.body?.data) ? allowed.body.data.length : -1,
    deniedStatus: denied.status,
    deniedError: denied.body?.error ?? null,
    noTokenStatus: noToken.status,
    apiVersion: process.env.BSP_PLUGIN_API_VERSION ?? null,
  }), 'utf8')
  process.exit(0)
}

main().catch((error) => {
  fs.writeFileSync(path.join(pluginDir, 'result.json'), JSON.stringify({ error: String(error) }), 'utf8')
  process.exit(1)
})
`

/** 一个会立刻崩溃的插件，用于验证退避重启与最终 crashed */
const CRASHING_PLUGIN_SOURCE = `
process.exit(3)
`

function seedPlugin(directory: string, options: {
  id: string
  source: string
  capabilities: string[]
}): string {
  const pluginDir = path.join(pluginsRoot, directory)
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), `${JSON.stringify({
    id: options.id,
    name: `测试插件 ${options.id}`,
    version: '1.0.0',
    apiVersion: 1,
    kind: 'community',
    entry: 'plugin.mjs',
    capabilities: options.capabilities,
  }, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(pluginDir, 'plugin.mjs'), options.source, 'utf8')
  return pluginDir
}

function writeEnabledState(ids: string[]): void {
  fs.mkdirSync(pluginsRoot, { recursive: true })
  fs.writeFileSync(path.join(pluginsRoot, 'plugins.state.json'), `${JSON.stringify({ version: 1, enabled: ids }, null, 2)}\n`, 'utf8')
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

let runtime: PluginRuntime | null = null

before(async () => {
  await initDatabase(dbFilePath, migrationsFolder, {
    adminUsername: 'superadmin',
    adminPassword: '123456',
    seedDevelopmentUsers: false,
  })
  await createGameInstance({
    id: 'inst-plugin-test',
    nodeId: 'local-node',
    name: '插件测试实例',
    gameCode: '343050',
    status: 'stopped',
  })
})

after(async () => {
  await runtime?.shutdown()
  closeDatabase()
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('plugin runtime', () => {
  it('启动已启用的插件进程，并按声明授予能力', async () => {
    seedPlugin('demo', {
      id: 'demo-plugin',
      source: MINIMAL_PLUGIN_SOURCE,
      capabilities: ['instances:read'],
    })
    writeEnabledState(['demo-plugin'])

    runtime = await createPluginRuntime({ hostApiVersion: 1 })
    runtime.sync()

    const resultPath = path.join(pluginsRoot, 'demo', 'result.json')
    const produced = await waitFor(() => fs.existsSync(resultPath))
    assert.equal(produced, true, `插件应当产出 result.json；日志：${readPluginLog('demo')}`)

    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    // 声明过的能力：调通，并看到宿主里的实例
    assert.equal(result.allowedStatus, 200)
    assert.equal(result.instanceCount, 1)
    // 未声明的能力：拒
    assert.equal(result.deniedStatus, 403, `未声明的能力应当被拒，实际响应：${JSON.stringify(result)}`)
    assert.match(String(result.deniedError), /未授予能力/)
    // 没有令牌：拒
    assert.equal(result.noTokenStatus, 401)
    // 宿主注入的接口版本可读
    assert.equal(result.apiVersion, '1')
  })

  it('插件状态里能看到进程信息与最近错误', async () => {
    const statuses = runtime?.listStatus() ?? []
    const demo = statuses.find(item => item.pluginId === 'demo-plugin')
    assert.ok(demo, '应当有 demo-plugin 的状态记录')
    // result.json 先于退出事件到达，查询时可能仍在运行，也可能已正常完成。
    assert.ok(['running', 'finished'].includes(demo.state), `插件应当运行或正常完成，实际：${JSON.stringify(demo)}`)
    assert.ok(demo.startedAt, '应当保留插件启动时间')
    assert.equal(demo.restarts, 0, '正常完成的插件不应自动重启')
  })

  it('反复崩溃的插件最终停在 crashed，而不是无限重启', async () => {
    seedPlugin('crasher', {
      id: 'crashing-plugin',
      source: CRASHING_PLUGIN_SOURCE,
      capabilities: [],
    })
    writeEnabledState(['crashing-plugin'])
    const localRuntime = await createPluginRuntime({
      hostApiVersion: 1,
      // 测试里不等待真实的 1s/2s/4s… 退避，仍然经过完整的重启计数逻辑
      restartBaseDelayMs: 5,
      onLog: () => {},
    })
    localRuntime.sync()

    /**
     * 判定「用满重启预算」不能只看 state：崩溃瞬间 state 就已经是 crashed，
     * 而"已停止重启"的结论是在调度器判定预算耗尽后才写进 lastError 的。
     */
    const reachedLimit = await waitFor(() => {
      const status = localRuntime.listStatus().find(item => item.pluginId === 'crashing-plugin')
      return status?.state === 'crashed' && (status.lastError ?? '').includes('连续')
    }, 20000)
    const status = localRuntime.listStatus().find(item => item.pluginId === 'crashing-plugin')
    assert.equal(reachedLimit, true, `应当最终停在「已停止重启」，当前：${JSON.stringify(status)}`)
    assert.match(String(status?.lastError), /连续/)
    assert.match(String(status?.lastError), /已停止重启/)
    assert.ok((status?.restarts ?? 0) >= 5, `重启次数应当达到上限，实际 ${status?.restarts}`)
    await localRuntime.shutdown()
  })

  it('停用插件会真正终止进程，不留孤儿', async () => {
    const localRuntime = await createPluginRuntime({ hostApiVersion: 1 })
    // 造一个不退出的插件：验证 kill 生效
    seedPlugin('longrun', {
      id: 'longrun-plugin',
      source: 'setInterval(() => {}, 1000)\n',
      capabilities: [],
    })
    writeEnabledState(['longrun-plugin'])
    localRuntime.sync()

    const running = await waitFor(() => localRuntime.listStatus().find(item => item.pluginId === 'longrun-plugin')?.state === 'running')
    assert.equal(running, true, '应当先跑起来')
    const pid = localRuntime.listStatus().find(item => item.pluginId === 'longrun-plugin')?.pid
    assert.ok(pid && pid > 0)

    localRuntime.stop('longrun-plugin')
    const stopped = await waitFor(() => {
      const status = localRuntime.listStatus().find(item => item.pluginId === 'longrun-plugin')
      return status?.state === 'stopped' && status.pid === null
    })
    assert.equal(stopped, true, '停用后状态应为 stopped 且 pid 为空')
    await localRuntime.shutdown()
  })

  it('每次能力调用都留下审计记录，越权尝试记为 denied', async () => {
    const records = readPluginAudit({ pluginId: 'demo-plugin', limit: 50 })
    assert.ok(records.length >= 2, `应当至少记录读取与越权两次调用，实际 ${records.length}`)

    const allowed = records.find(record => record.action === 'instances:list')
    assert.ok(allowed, '应当有 instances:list 的记录')
    assert.equal(allowed?.outcome, 'ok')
    assert.equal(allowed?.capability, 'instances:read')

    const denied = records.find(record => record.outcome === 'denied')
    assert.ok(denied, '越权调用必须留痕：这是插件行为唯一不受插件自己控制的证据')
    assert.equal(denied?.capability, 'console:read')
    assert.equal(denied?.pluginId, 'demo-plugin')
    assert.ok((denied?.durationMs ?? -1) >= 0)

    // 审计文件是 NDJSON，管理员可以直接看
    assert.equal(fs.existsSync(resolvePluginAuditRoot()), true)
  })

  it('审计里的参数摘要剔除敏感键、截断长值与嵌套结构', () => {
    const summary = summarizeAuditParams({
      instanceId: 'inst-1',
      token: 'should-not-appear',
      clusterPassword: 'should-not-appear',
      apiKey: 'should-not-appear',
      longText: 'x'.repeat(500),
      nested: { a: 1, b: 2 },
      list: [1, 2, 3],
      enabled: true,
    })
    assert.equal(summary.instanceId, 'inst-1')
    assert.equal(summary.token, '[已隐去]')
    assert.equal(summary.clusterPassword, '[已隐去]')
    assert.equal(summary.apiKey, '[已隐去]')
    assert.ok(String(summary.longText).length <= 201, '长值必须截断')
    assert.equal(summary.nested, '{2 个字段}')
    assert.equal(summary.list, '[3 项]')
    assert.equal(summary.enabled, true)
    // 整份摘要里不能出现被隐去的原值
    assert.doesNotMatch(JSON.stringify(summary), /should-not-appear/)
  })

  /**
   * 仓库里的示例插件（`examples/plugins/audit-reporter`）必须真的能跑。
   * 示例是最容易被写坏又没人发现的东西：它不参与构建，读的人也多半直接复制。
   * 这条用例把示例当普通插件装载、启用、启动，并检查它产出的结果文件。
   */
  it('仓库里的示例插件可以装载、启用并跑出结果', async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
    const exampleSource = path.join(repoRoot, 'examples', 'plugins', 'audit-reporter')
    assert.equal(fs.existsSync(path.join(exampleSource, 'plugin.json')), true, '示例插件应当存在于仓库中')

    const target = path.join(pluginsRoot, 'audit-reporter')
    fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(exampleSource, target, { recursive: true })
    fs.rmSync(path.join(target, 'summary.json'), { force: true })

    const loaded = loadPluginDirectory(target)
    assert.equal(loaded.ok, true, loaded.ok ? '' : `示例插件装载失败：${loaded.message}`)

    writeEnabledState(['example-audit-reporter'])
    const exampleRuntime = await createPluginRuntime({ hostApiVersion: 1, onLog: () => {} })
    exampleRuntime.sync()

    const summaryPath = path.join(target, 'summary.json')
    const produced = await waitFor(() => fs.existsSync(summaryPath), 10000)
    assert.equal(
      produced,
      true,
      `示例插件应当产出 summary.json；日志：${fs.existsSync(path.join(target, 'plugin.log')) ? fs.readFileSync(path.join(target, 'plugin.log'), 'utf8').slice(0, 300) : '(无)'}`,
    )

    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    assert.equal(summary.instanceCount, 1)
    assert.equal(summary.hostApiVersion, '1')
    // 它顺带调用了 /capabilities/audit，说明审计接口对插件可用
    assert.equal(summary.auditStatus, 200)
    assert.ok(Array.isArray(summary.recentCalls) && summary.recentCalls.length > 0)

    const exampleAudits = readPluginAudit({ pluginId: 'example-audit-reporter', limit: 20 })
    assert.ok(exampleAudits.some(record => record.action === 'instances:list' && record.outcome === 'ok'))
    assert.ok(exampleAudits.some(record => record.action === 'audit:self' && record.outcome === 'ok'))

    await exampleRuntime.shutdown()
  })
})

function readPluginLog(directory: string): string {
  try {
    return fs.readFileSync(path.join(pluginsRoot, directory, 'plugin.log'), 'utf8').slice(0, 400)
  }
  catch {
    return '(无日志)'
  }
}
