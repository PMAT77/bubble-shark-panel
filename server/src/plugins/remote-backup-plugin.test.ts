import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as signWithKey } from 'node:crypto'
import fs from 'node:fs'
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
import { closeDatabase, createBackupRecord, createGameInstance, initDatabase } from '../shared/db/index'
import { clearLicenseCache } from '../shared/license/index'
import { createPluginRuntime } from './host'
import { loadPluginDirectory } from './manifest'
import { readPluginAudit } from './audit-store'
import { setPluginEnabled } from './registry'

/**
 * Pro 插件「异地与云备份」的端到端验证。
 *
 * 这是第一个真实的商业插件，所以测试要一次把整条链路走通：
 * **商业插件签名 → 授权门槛 → 启用 → 进程启动 → 读备份列表 → 上传 → 审计留痕**。
 * 上传用一个本地目录当"远端"（插件支持 directory 目标），既能验证流式复制的正确性，
 * 又不需要在测试里搭 WebDAV 服务；WebDAV 与预签名 PUT 走的是同一段 htt p 上传代码。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-remote-backup-'))
const pluginsRoot = path.join(workDir, 'plugins')
const auditRoot = path.join(workDir, 'plugin-audit')
const backupsRoot = path.join(workDir, 'backups')
const remoteDir = path.join(workDir, 'remote')
const dbFilePath = path.join(workDir, 'bubblesharkpanel.sqlite')
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle')

process.env.DB_PATH = dbFilePath
process.env.BSP_PLUGINS_ROOT = pluginsRoot
process.env.BSP_PLUGIN_AUDIT_ROOT = auditRoot
process.env.BSP_BACKUPS_ROOT = backupsRoot

const { privateKey, publicKey } = generateKeyPairSync('ed25519')

/** 造一份带 remote-backup 能力的授权，写入默认的许可文件位置 */
function writeActiveLicense(): void {
  const payload: LicensePayload = {
    version: 1,
    customer: '测试客户',
    capabilities: ['remote-backup'],
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

/** 把仓库里的 Pro 插件示例复制到插件根，并按清单签名 */
function installRemoteBackupPlugin(options: { sign: boolean, licenseIdMismatch?: boolean }): string {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  const source = path.join(repoRoot, 'examples', 'plugins', 'remote-backup')
  const target = path.join(pluginsRoot, 'remote-backup')
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(source, target, { recursive: true })

  // 预置配置：目标用本地目录，间隔设长，避免测试期间反复跑
  fs.writeFileSync(path.join(target, 'config.json'), `${JSON.stringify({
    intervalSeconds: 3600,
    keepRemote: 7,
    target: { kind: 'directory', dir: remoteDir, url: '', putUrlTemplate: '', username: '', password: '' },
    alertWebhook: '',
    requestTimeoutSeconds: 60,
  }, null, 2)}\n`, 'utf8')

  if (options.sign) {
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'plugin.json'), 'utf8')) as PluginManifest
    const signature = signWithKey(
      null,
      Buffer.from(canonicalizePluginManifest(manifest), 'utf8'),
      privateKey,
    ).toString('base64')
    fs.writeFileSync(path.join(target, 'plugin.signature.json'), `${JSON.stringify({
      version: 1,
      pluginId: options.licenseIdMismatch ? 'someone-else' : manifest.id,
      publisher: 'gsh-official',
      signedAt: new Date().toISOString(),
      signature,
    }, null, 2)}\n`, 'utf8')
  }
  return target
}

async function waitFor(check: () => boolean, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) {
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

const INSTANCE_ID = 'inst-remote-backup-test'

before(async () => {
  fs.mkdirSync(backupsRoot, { recursive: true })
  fs.mkdirSync(remoteDir, { recursive: true })
  await initDatabase(dbFilePath, migrationsFolder, {
    adminUsername: 'superadmin',
    adminPassword: '123456',
    seedDevelopmentUsers: false,
  })
  await createGameInstance({
    id: INSTANCE_ID,
    nodeId: 'local-node',
    name: '异地备份测试实例',
    gameCode: '343050',
    status: 'stopped',
  })

  // 造一份"已完成的备份"：真实文件 + 数据库记录（插件读的是记录里的路径）
  const backupFile = path.join(backupsRoot, '20260922-120000-manual.tar.gz')
  fs.writeFileSync(backupFile, 'fake-archive-content-for-upload-test', 'utf8')
  await createBackupRecord({
    id: 'backup-remote-1',
    instanceId: INSTANCE_ID,
    filePath: backupFile,
    sizeBytes: fs.statSync(backupFile).size,
    kind: 'manual',
    status: 'completed',
    note: '异地备份测试',
    createdBy: 'test',
  })

  process.env.BSP_LICENSE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  writeActiveLicense()
})

after(() => {
  closeDatabase()
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('remote backup pro plugin', () => {
  it('商业插件缺少签名时无法装载，说明文件由发布方提供', () => {
    const target = installRemoteBackupPlugin({ sign: false })
    const loaded = loadPluginDirectory(target)
    assert.equal(loaded.ok, false)
    if (!loaded.ok) {
      assert.match(loaded.message, /plugin\.signature\.json/)
    }
  })

  it('签名里的插件标识与清单不一致时拒绝装载', () => {
    const target = installRemoteBackupPlugin({ sign: true, licenseIdMismatch: true })
    const loaded = loadPluginDirectory(target)
    assert.equal(loaded.ok, false)
    if (!loaded.ok) {
      assert.match(loaded.message, /不一致/)
    }
  })

  it('签名正确时装载成功，并标记为商业插件与已签名', () => {
    const target = installRemoteBackupPlugin({ sign: true })
    const loaded = loadPluginDirectory(target)
    assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.message)
    if (loaded.ok) {
      assert.equal(loaded.manifest.kind, 'commercial')
      assert.equal(loaded.signed, true)
      assert.equal(loaded.publisher, 'gsh-official')
      assert.deepEqual(loaded.manifest.capabilities, [
        'backups:read',
        'backups:write',
        'backups:delete',
        'network:outbound',
        'storage:kv',
      ])
    }
  })

  it('没有授权时启用被拒，并说明缺的是「异地与云备份」', () => {
    const licensePath = path.join(path.dirname(dbFilePath), 'license.json')
    const saved = fs.readFileSync(licensePath, 'utf8')
    fs.rmSync(licensePath, { force: true })
    clearLicenseCache()
    try {
      const result = setPluginEnabled({ pluginId: 'pro-remote-backup', enabled: true, acknowledgeDangerous: true })
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.match(result.message, /商业插件/)
        assert.match(result.message, /异地与云备份/)
      }
    }
    finally {
      fs.writeFileSync(licensePath, saved, 'utf8')
      clearLicenseCache()
    }
  })

  it('有授权时启用成功，插件把本机备份上传到远端并留下审计', async () => {
    const result = setPluginEnabled({ pluginId: 'pro-remote-backup', enabled: true, acknowledgeDangerous: true })
    assert.equal(result.ok, true, result.ok ? '' : result.message)

    const runtime = await createPluginRuntime({ hostApiVersion: 1, onLog: () => {} })
    runtime.sync()
    try {
      const remoteFile = path.join(remoteDir, '20260922-120000-manual.tar.gz')
      const uploaded = await waitFor(() => fs.existsSync(remoteFile))
      const pluginLogPath = path.join(pluginsRoot, 'remote-backup', 'plugin.log')
      const pluginLog = fs.existsSync(pluginLogPath) ? fs.readFileSync(pluginLogPath, 'utf8') : '(无日志)'
      assert.equal(uploaded, true, `远端应当出现上传的备份；插件日志：\n${pluginLog.slice(-1200)}`)

      // 内容逐字节一致：流式复制不能悄悄截断
      assert.equal(
        fs.readFileSync(remoteFile, 'utf8'),
        fs.readFileSync(path.join(backupsRoot, '20260922-120000-manual.tar.gz'), 'utf8'),
      )

      // 状态文件记录了上传结果，便于人工对账与避免重复上传
      const state = JSON.parse(fs.readFileSync(path.join(pluginsRoot, 'remote-backup', 'state.json'), 'utf8'))
      assert.equal(state.lastError, null)
      assert.ok(state.uploaded['backup-remote-1'])

      // 宿主侧审计：读列表 + 上传前的能力调用都在
      const audits = readPluginAudit({ pluginId: 'pro-remote-backup', limit: 50 })
      assert.ok(audits.some(record => record.action === 'backups:list' && record.outcome === 'ok'))
      assert.ok(audits.every(record => record.pluginId === 'pro-remote-backup'))
    }
    finally {
      await runtime.shutdown()
    }
  })

  it('上传失败时状态里留下错误，而不是静默成功', async () => {
    // 把远端目录换成一个必然失败的位置（指向一个文件而非目录）
    const configPath = path.join(pluginsRoot, 'remote-backup', 'config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const blockedTarget = path.join(workDir, 'blocked-target')
    fs.writeFileSync(blockedTarget, 'this is a file, not a directory', 'utf8')
    config.target.dir = blockedTarget
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    fs.rmSync(path.join(pluginsRoot, 'remote-backup', 'state.json'), { force: true })

    const runtime = await createPluginRuntime({ hostApiVersion: 1, onLog: () => {} })
    runtime.sync()
    try {
      const statePath = path.join(pluginsRoot, 'remote-backup', 'state.json')
      const failed = await waitFor(() => {
        if (!fs.existsSync(statePath)) {
          return false
        }
        try {
          return Boolean(JSON.parse(fs.readFileSync(statePath, 'utf8')).lastError)
        }
        catch {
          return false
        }
      })
      assert.equal(failed, true, '上传失败必须写进 state.json 的 lastError，而不是当作成功')
    }
    finally {
      await runtime.shutdown()
    }
  })
})
