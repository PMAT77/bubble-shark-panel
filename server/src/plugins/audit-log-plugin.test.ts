import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as signWithKey } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import {
  canonicalizePluginManifest,
  type PluginManifest,
} from '../../../shared/contracts/plugin'
import {
  canonicalizeLicensePayload,
  type LicensePayload,
} from '../../../shared/contracts/license'
import { closeDatabase, initDatabase } from '../shared/db/index'
import { clearLicenseCache } from '../shared/license/index'
import { createPluginRuntime } from './host'
import { loadPluginDirectory } from './manifest'
import { readPluginAudit } from './audit-store'
import { setPluginEnabled } from './registry'
import { appendOperationAudit, readOperationAudit } from '../shared/audit/operation-audit'

/**
 * Pro 插件「操作审计日志」的验证。
 *
 * 面板本身已经能查操作审计，这个插件解决的是**留存与交付**：按天归档成可交付的文件、
 * 可选推送到与存档不同的一块盘、对敏感操作告警。用例盯的是「归档对不对」。
 *
 * 这里用真实进程 + 真实能力服务跑第一轮（证明插件真能拿到数据），
 * 归档格式的细节则通过 import `runOnce` 逐个覆盖——归档是纯逻辑，
 * 每个格式都起一遍进程会让测试慢十倍而覆盖不变。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-audit-log-plugin-'))
const pluginsRoot = path.join(workDir, 'plugins')
const pluginAuditRoot = path.join(workDir, 'plugin-audit')
const operationAuditRoot = path.join(workDir, 'operation-audit')
const remoteDir = path.join(workDir, 'remote-audit')
const dbFilePath = path.join(workDir, 'bubblesharkpanel.sqlite')
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle')

process.env.DB_PATH = dbFilePath
process.env.BSP_PLUGINS_ROOT = pluginsRoot
process.env.BSP_PLUGIN_AUDIT_ROOT = pluginAuditRoot
process.env.BSP_OPERATION_AUDIT_ROOT = operationAuditRoot

const { privateKey, publicKey } = generateKeyPairSync('ed25519')

function writeLicense(capabilities: LicensePayload['capabilities']): void {
  const payload: LicensePayload = {
    version: 1,
    customer: '测试客户',
    capabilities,
    issuedAt: new Date('2026-09-01T00:00:00.000Z').toISOString(),
    expiresAt: null,
    fingerprint: null,
  }
  const signature = signWithKey(null, Buffer.from(canonicalizeLicensePayload(payload), 'utf8'), privateKey).toString('base64')
  const licensePath = path.join(path.dirname(dbFilePath), 'license.json')
  fs.writeFileSync(licensePath, `${JSON.stringify({ payload, signature }, null, 2)}\n`, 'utf8')
  process.env.BSP_LICENSE_FILE = licensePath
  clearLicenseCache()
}

function installAuditLogPlugin(): string {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const source = path.join(repoRoot, 'examples', 'plugins', 'audit-log')
  const target = path.join(pluginsRoot, 'audit-log')
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(source, target, { recursive: true })
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'plugin.json'), 'utf8')) as PluginManifest
  const signature = signWithKey(null, Buffer.from(canonicalizePluginManifest(manifest), 'utf8'), privateKey).toString('base64')
  fs.writeFileSync(path.join(target, 'plugin.signature.json'), `${JSON.stringify({
    version: 1,
    pluginId: manifest.id,
    publisher: 'gsh-official',
    signedAt: new Date().toISOString(),
    signature,
  }, null, 2)}\n`, 'utf8')
  return target
}

interface PluginModule {
  runOnce: (config: Record<string, unknown>, state: Record<string, unknown>) => Promise<{
    ok: boolean
    message: string
    written: number
    sensitive: number
  }>
}

let pluginModule: PluginModule
let stubServer: http.Server | null = null

/**
 * 用真实的能力服务协议喂数据给插件：`/capabilities/operations` 返回
 * `{ ok, data: { records } }`，记录来自宿主真实的操作审计读取函数。
 * 这样测的是插件对真实响应的解析，而不是它对某个数组的假设。
 */
async function startCapabilityStub(): Promise<string> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      if (request.url?.startsWith('/capabilities/operations')) {
        let limit = 100
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { limit?: number }
          if (Number.isFinite(body.limit)) {
            limit = Number(body.limit)
          }
        }
        catch {
          // 用默认值
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          ok: true,
          data: { auditRoot: operationAuditRoot, records: readOperationAudit({ limit }) },
        }))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: '未知能力' }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  stubServer = server
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('存根服务启动失败')
  }
  return `http://127.0.0.1:${address.port}`
}

function auditConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fetchLimit: 500,
    format: 'ndjson',
    sensitivePathPatterns: ['/app/instance/backup/delete', '/app/instance/delete'],
    alertWebhook: '',
    remoteDir: '',
    ...overrides,
  }
}

let realRuntime: ReturnType<typeof createPluginRuntime> extends Promise<infer T> ? T : never

before(async () => {
  fs.mkdirSync(remoteDir, { recursive: true })
  await initDatabase(dbFilePath, migrationsFolder, {
    adminUsername: 'superadmin',
    adminPassword: '123456',
    seedDevelopmentUsers: false,
  })
  process.env.BSP_LICENSE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  writeLicense(['audit-log'])
  installAuditLogPlugin()

  // 真机路径：宿主启动能力服务 → 插件进程启动 → 调用 /capabilities/operations
  // 插件声明了 network:outbound（用于推送告警），属危险能力，管理员启用时需确认
  const enable = setPluginEnabled({ pluginId: 'pro-audit-log', enabled: true, acknowledgeDangerous: true })
  assert.equal(enable.ok, true, enable.ok ? '' : enable.message)
  realRuntime = await createPluginRuntime({ hostApiVersion: 1, onLog: () => {} })
  realRuntime.sync()

  const statePath = path.join(pluginsRoot, 'audit-log', 'state.json')
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && !fs.existsSync(statePath)) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  await realRuntime.shutdown()

  // 之后再补几条"人造"记录，覆盖敏感操作与被拒场景
  appendOperationAudit({
    account: 'alice', userId: 'u-1', method: 'POST', path: '/app/instance/backup/delete',
    body: { backupId: 'backup-9', token: 'should-not-appear' }, statusCode: 200, durationMs: 120, requestId: 'req-seed-1',
  })
  appendOperationAudit({
    account: 'bob', userId: 'u-2', method: 'POST', path: '/app/instance/restart',
    body: { id: 'inst-1' }, statusCode: 200, durationMs: 8000, requestId: 'req-seed-2',
  })
  appendOperationAudit({
    account: 'mallory', userId: null, method: 'POST', path: '/app/instance/delete',
    body: { id: 'inst-1' }, statusCode: 403, durationMs: 3, requestId: 'req-seed-3',
  })

  process.env.BSP_CAPABILITY_URL = await startCapabilityStub()
  process.env.BSP_PLUGIN_TOKEN = 'test-token'
  /**
   * 插件用 `BSP_PLUGIN_DIR` 定位自己的归档目录；测试里 import 插件时没有宿主注入，
   * 不设置它就会按 `process.cwd()` 写——归档会落到仓库根目录去。
   */
  process.env.BSP_PLUGIN_DIR = path.join(pluginsRoot, 'audit-log')
  // 插件是交付给用户的 .mjs，不带类型声明；这里按已知的导出形状收窄
  // @ts-expect-error 插件模块没有 .d.ts
  pluginModule = await import('../../../examples/plugins/audit-log/plugin.mjs') as unknown as PluginModule
})

after(async () => {
  await new Promise<void>(resolve => stubServer ? stubServer.close(() => resolve()) : resolve())
  closeDatabase()
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('audit log pro plugin', () => {
  it('插件声明了读取操作审计的能力，且装载通过签名校验', () => {
    const loaded = loadPluginDirectory(path.join(pluginsRoot, 'audit-log'))
    assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.message)
    if (loaded.ok) {
      assert.equal(loaded.manifest.kind, 'commercial')
      assert.ok(loaded.manifest.capabilities.includes('operations:read'))
      assert.equal(loaded.signed, true)
    }
  })

  it('授权不含 audit-log 时无法启用，并说明缺的是「操作审计日志」', () => {
    writeLicense(['remote-backup'])
    try {
      const result = setPluginEnabled({ pluginId: 'pro-audit-log', enabled: true, acknowledgeDangerous: true })
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.match(result.message, /操作审计日志/)
      }
    }
    finally {
      writeLicense(['audit-log'])
    }
  })

  it('真实进程启动后完成第一轮，宿主的插件审计记录了 operations:list', () => {
    const pluginDir = path.join(pluginsRoot, 'audit-log')
    /**
     * 这一轮的意义是「插件真的被宿主拉起来、真的调到了能力服务」，
     * 而不是"归档目录里有没有文件"——首轮运行时审计文件还是空的，
     * 没有记录可归档是正确行为（归档细节由后面的用例覆盖）。
     */
    assert.equal(fs.existsSync(path.join(pluginDir, 'state.json')), true, '插件应当完成第一轮并写下状态')
    const state = JSON.parse(fs.readFileSync(path.join(pluginDir, 'state.json'), 'utf8'))
    assert.equal(state.lastError, null, `首轮不该报错：${state.lastError}`)

    const audits = readPluginAudit({ pluginId: 'pro-audit-log', limit: 50 })
    assert.ok(
      audits.some(record => record.action === 'operations:list' && record.outcome === 'ok'),
      `应当有 operations:list 的成功记录，实际：${JSON.stringify(audits.map(item => `${item.action}:${item.outcome}`))}`,
    )
  })

  it('归档：按天写文件、只归档新记录、敏感操作被计数、参数已脱敏', async () => {
    const pluginDir = path.join(pluginsRoot, 'audit-log')
    // 清掉真机那轮的结果，从游标 0 重新归档，便于断言
    fs.rmSync(path.join(pluginDir, 'archive'), { recursive: true, force: true })
    const state: Record<string, unknown> = { lastSeenId: 0 }

    const first = await pluginModule.runOnce(auditConfig(), state)
    assert.equal(first.ok, true, `归档失败：${first.message}｜state=${JSON.stringify(state)}｜可用记录=${readOperationAudit({ limit: 5 }).length}｜capabilityUrl=${process.env.BSP_CAPABILITY_URL}`)
    assert.ok(first.written >= 3, `应当归档全部记录，实际 ${first.written}（${first.message}）`)
    assert.equal(first.sensitive, 2, '删除备份与被拒的删除都算敏感操作')

    const archiveDir = path.join(pluginDir, 'archive')
    const files = fs.readdirSync(archiveDir)
    assert.equal(files.length, 1, `应当只生成一个按天归档的文件，实际：${files.join('、')}`)
    assert.match(files[0]!, /^\d{4}-\d{2}-\d{2}\.ndjson$/)

    const archived = fs.readFileSync(path.join(archiveDir, files[0]!), 'utf8')
      .split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
    assert.ok(archived.some(record => record.account === 'alice' && record.path === '/app/instance/backup/delete'))
    assert.ok(archived.some(record => record.outcome === 'denied'))
    assert.equal(archived.find(record => record.account === 'alice')?.params?.token, '[已隐去]')
    assert.doesNotMatch(JSON.stringify(archived), /should-not-appear/)

    const second = await pluginModule.runOnce(auditConfig(), state)
    assert.equal(second.written, 0, '第二轮不该重复归档')
    assert.match(second.message, /没有新的审计记录/)
  })

  it('CSV 格式带表头，一条记录一行', async () => {
    const pluginDir = path.join(pluginsRoot, 'audit-log')
    fs.rmSync(path.join(pluginDir, 'archive'), { recursive: true, force: true })
    const state: Record<string, unknown> = { lastSeenId: 0 }
    const result = await pluginModule.runOnce(auditConfig({ format: 'csv', sensitivePathPatterns: [] }), state)
    assert.equal(result.ok, true, result.message)

    const files = fs.readdirSync(path.join(pluginDir, 'archive'))
    assert.match(files[0]!, /\.csv$/)
    const lines = fs.readFileSync(path.join(pluginDir, 'archive', files[0]!), 'utf8').trim().split('\n')
    assert.equal(lines.length, result.written + 1, '一行表头 + 每条记录一行')
    assert.match(lines[0]!, /^at,account,method,path,outcome,statusCode,durationMs,requestId,params$/)
    assert.match(lines[1]!, /"alice"|"bob"|"mallory"|"superadmin"/)
  })

  it('配置远端目录时推送归档，内容与本机逐字节一致且不留半成品', async () => {
    const pluginDir = path.join(pluginsRoot, 'audit-log')
    // 先清掉上一个用例留下的 CSV 归档，保证本轮本机与远端都是同一份 ndjson
    fs.rmSync(path.join(pluginDir, 'archive'), { recursive: true, force: true })
    fs.rmSync(remoteDir, { recursive: true, force: true })
    fs.mkdirSync(remoteDir, { recursive: true })

    const state: Record<string, unknown> = { lastSeenId: 0 }
    const result = await pluginModule.runOnce(auditConfig({ remoteDir, sensitivePathPatterns: [] }), state)
    assert.equal(result.ok, true, result.message)
    assert.match(result.message, /推送/)

    const archiveDir = path.join(pluginDir, 'archive')
    const localName = fs.readdirSync(archiveDir)[0]!
    assert.match(localName, /\.ndjson$/)
    const pushed = fs.readdirSync(remoteDir)
    assert.ok(pushed.includes(localName), `远端应当有 ${localName}，实际：${pushed.join('、')}`)
    assert.equal(
      fs.readFileSync(path.join(remoteDir, localName), 'utf8'),
      fs.readFileSync(path.join(archiveDir, localName), 'utf8'),
    )
    assert.ok(!pushed.some(name => name.endsWith('.part')), '不能留下半成品文件')
  })

  it('远端推送失败时如实报错，不谎报成功', async () => {
    const blocked = path.join(workDir, 'blocked-remote')
    fs.writeFileSync(blocked, 'this is a file, not a directory', 'utf8')
    const state: Record<string, unknown> = { lastSeenId: 0 }
    const result = await pluginModule.runOnce(auditConfig({ remoteDir: blocked, sensitivePathPatterns: [] }), state)
    assert.equal(result.ok, false)
    assert.match(result.message, /推送/)
  })

  it('能力服务不可达时报错而不是静默成功', async (t) => {
    /**
     * 插件在模块加载时就固化了能力服务地址，运行时改环境变量没用——
     * 这里直接把 fetch 打坏，模拟"宿主的能力服务挂了"。
     */
    const originalFetch = globalThis.fetch
    t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:1')
    })
    try {
      const result = await pluginModule.runOnce(auditConfig(), { lastSeenId: 0 })
      assert.equal(result.ok, false)
      assert.match(result.message, /读取操作审计失败/)
    }
    finally {
      t.mock.restoreAll()
      globalThis.fetch = originalFetch
    }
  })
})
