import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as signWithKey } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  canonicalizePluginManifest,
  type PluginManifest,
} from '../../../shared/contracts/plugin'
import { loadPluginDirectory, summarizePluginCapabilities } from './manifest'
import { resolvePluginsRoot, scanPlugins, setPluginEnabled } from './registry'

/**
 * 插件装载与启用状态的测试。
 *
 * 测试重点是**拒绝路径**：插件是第三方代码，宿主的第一责任不是"让插件跑起来"，
 * 而是「不在清单不合法、签名不对、版本不匹配的情况下放行」。另外要守住一条底线：
 * 插件目录里出现任何损坏内容，插件列表接口都必须照常返回，而不是整体 500 ——
 * 否则一个坏插件会让管理员连禁用按钮都点不到。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-plugin-test-'))
const pluginsRoot = path.join(workDir, 'plugins')

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

function buildManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'demo-plugin',
    name: '演示插件',
    version: '1.0.0',
    apiVersion: 1,
    kind: 'community',
    entry: 'bin/plugin.js',
    capabilities: ['instances:read'],
    ...overrides,
  }
}

/** 在插件根下造一个插件目录，返回它的路径 */
function seedPlugin(directory: string, manifest: PluginManifest | object, options: {
  withEntry?: boolean
  signature?: object | null
} = {}): string {
  const pluginDir = path.join(pluginsRoot, directory)
  fs.mkdirSync(path.join(pluginDir, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  if (options.withEntry !== false) {
    fs.writeFileSync(path.join(pluginDir, 'bin', 'plugin.js'), '#!/usr/bin/env node\nconsole.log("plugin")\n', 'utf8')
  }
  if (options.signature) {
    fs.writeFileSync(path.join(pluginDir, 'plugin.signature.json'), `${JSON.stringify(options.signature, null, 2)}\n`, 'utf8')
  }
  return pluginDir
}

function signManifest(manifest: PluginManifest, overrides: Record<string, unknown> = {}): object {
  return {
    version: 1,
    pluginId: manifest.id,
    publisher: 'gsh-official',
    signedAt: new Date('2026-09-01T00:00:00.000Z').toISOString(),
    signature: signWithKey(null, Buffer.from(canonicalizePluginManifest(manifest), 'utf8'), privateKey).toString('base64'),
    ...overrides,
  }
}

before(() => {
  process.env.BSP_PLUGINS_ROOT = pluginsRoot
  process.env.BSP_LICENSE_PUBLIC_KEY = publicPem
})

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('loadPluginDirectory', () => {
  it('社区插件无需签名即可装载，并如实标记为未签名', () => {
    const manifest = buildManifest({ id: 'community-one' })
    const pluginDir = seedPlugin('community-one', manifest)
    const loaded = loadPluginDirectory(pluginDir)
    assert.equal(loaded.ok, true)
    if (loaded.ok) {
      assert.equal(loaded.signed, false)
      assert.equal(loaded.publisher, null)
      assert.equal(loaded.manifest.id, 'community-one')
    }
  })

  it('目录里没有 plugin.json 时给出「可能多套了一层目录」的提示', () => {
    const pluginDir = path.join(pluginsRoot, 'no-manifest')
    fs.mkdirSync(pluginDir, { recursive: true })
    const loaded = loadPluginDirectory(pluginDir)
    assert.equal(loaded.ok, false)
    if (!loaded.ok) {
      assert.match(loaded.message, /多套了一层目录/)
    }
  })

  it('清单字段非法时指出具体字段', () => {
    const pluginDir = seedPlugin('bad-manifest', { ...buildManifest(), id: 'Bad_ID' })
    const loaded = loadPluginDirectory(pluginDir)
    assert.equal(loaded.ok, false)
    if (!loaded.ok) {
      assert.match(loaded.message, /id/)
    }
  })

  it('清单声明的入口不存在时拒绝', () => {
    const manifest = buildManifest({ id: 'missing-entry', entry: 'bin/not-there.js' })
    const pluginDir = seedPlugin('missing-entry', manifest)
    const loaded = loadPluginDirectory(pluginDir)
    assert.equal(loaded.ok, false)
    if (!loaded.ok) {
      assert.match(loaded.message, /入口不存在/)
    }
  })

  it('入口路径带 .. 逃逸时拒绝', () => {
    for (const entry of ['../outside.js', 'bin/../../outside.js']) {
      const manifest = buildManifest({ id: 'escape-entry', entry })
      const pluginDir = seedPlugin(`escape-${entry.length}`, manifest, { withEntry: false })
      const loaded = loadPluginDirectory(pluginDir)
      assert.equal(loaded.ok, false, `应当拒绝入口：${entry}`)
      if (!loaded.ok) {
        assert.match(loaded.message, /相对路径/)
      }
    }
  })

  it('API 版本不兼容时给出「升级谁」的明确说明', () => {
    const tooNew = seedPlugin('too-new', buildManifest({ id: 'too-new', apiVersion: 99 }))
    const newResult = loadPluginDirectory(tooNew)
    assert.equal(newResult.ok, false)
    if (!newResult.ok) {
      assert.match(newResult.message, /先升级面板/)
    }

    const tooOld = seedPlugin('too-old', buildManifest({ id: 'too-old', apiVersion: 0 }))
    const oldResult = loadPluginDirectory(tooOld, { hostApiVersion: 1 })
    // apiVersion 必须为正整数，0 在 schema 层就被拒
    assert.equal(oldResult.ok, false)
  })

  it('商业插件缺少签名时拒绝，且说明文件由谁提供', () => {
    const manifest = buildManifest({ id: 'commercial-unsigned', kind: 'commercial' })
    const pluginDir = seedPlugin('commercial-unsigned', manifest)
    const loaded = loadPluginDirectory(pluginDir)
    assert.equal(loaded.ok, false)
    if (!loaded.ok) {
      assert.match(loaded.message, /plugin\.signature\.json/)
    }
  })

  it('商业插件签名有效时装载成功并给出发布方', () => {
    const manifest = buildManifest({
      id: 'commercial-signed',
      kind: 'commercial',
      // 覆盖「操作审计日志」这类商业功能所需的宿主 API 能力
      capabilities: ['instances:read', 'console:read'],
    })
    const pluginDir = seedPlugin('commercial-signed', manifest, { signature: signManifest(manifest) })
    const loaded = loadPluginDirectory(pluginDir)
    assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.message)
    if (loaded.ok) {
      assert.equal(loaded.signed, true)
      assert.equal(loaded.publisher, 'gsh-official')
    }
  })

  it('清单被改动后签名不再成立（不能靠改清单自助提权）', () => {
    const manifest = buildManifest({ id: 'commercial-tampered', kind: 'commercial', capabilities: ['instances:read'] })
    const signature = signManifest(manifest)
    // 签名后偷偷加上危险能力
    const tampered = { ...manifest, capabilities: ['instances:read', 'instances:lifecycle'] }
    const pluginDir = seedPlugin('commercial-tampered', tampered, { signature })
    const loaded = loadPluginDirectory(pluginDir)
    assert.equal(loaded.ok, false)
    if (!loaded.ok) {
      assert.match(loaded.message, /签名校验失败/)
    }
  })

  it('签名里的插件标识与清单不一致时拒绝', () => {
    const manifest = buildManifest({ id: 'commercial-mismatch', kind: 'commercial' })
    const pluginDir = seedPlugin('commercial-mismatch', manifest, {
      signature: signManifest(manifest, { pluginId: 'someone-else' }),
    })
    const loaded = loadPluginDirectory(pluginDir)
    assert.equal(loaded.ok, false)
    if (!loaded.ok) {
      assert.match(loaded.message, /不一致/)
    }
  })

  it('社区插件带签名但签名无效时同样拒绝（不当作未签名放过）', () => {
    const manifest = buildManifest({ id: 'community-badsig' })
    const pluginDir = seedPlugin('community-badsig', manifest, {
      signature: signManifest(manifest, { signature: Buffer.alloc(64).toString('base64') }),
    })
    const loaded = loadPluginDirectory(pluginDir)
    assert.equal(loaded.ok, false)
    if (!loaded.ok) {
      assert.match(loaded.message, /签名/)
    }
  })
})

describe('summarizePluginCapabilities', () => {
  it('识别危险能力', () => {
    const safe = summarizePluginCapabilities(buildManifest({ capabilities: ['instances:read', 'metrics:read'] }))
    assert.equal(safe.hasDangerousCapabilities, false)

    const dangerous = summarizePluginCapabilities(buildManifest({ capabilities: ['instances:lifecycle'] }))
    assert.equal(dangerous.hasDangerousCapabilities, true)
  })
})

describe('scanPlugins / setPluginEnabled', () => {
  it('插件根不存在时返回空列表而不是报错', () => {
    process.env.BSP_PLUGINS_ROOT = path.join(workDir, 'not-created-yet')
    const result = scanPlugins()
    assert.deepEqual(result.items, [])
    assert.equal(result.hostApiVersion, 1)
    process.env.BSP_PLUGINS_ROOT = pluginsRoot
  })

  it('已装载但未启用的插件状态是 disabled', () => {
    const result = scanPlugins()
    const item = result.items.find(entry => entry.id === 'community-one')
    assert.ok(item, '应当扫到 community-one')
    assert.equal(item.enabled, false)
    assert.equal(item.state, 'disabled')
  })

  it('损坏的插件目录标记为 invalid，且不影响其它插件与接口本身', () => {
    const result = scanPlugins()
    const broken = result.items.find(entry => entry.id === 'no-manifest')
    assert.ok(broken)
    assert.equal(broken.state, 'invalid')
    assert.match(broken.message, /plugin\.json/)
    // 其余插件仍正常列出
    assert.ok(result.items.some(entry => entry.id === 'community-one'))
  })

  it('启用后状态变为 ready，并写入状态文件', () => {
    const result = setPluginEnabled({ pluginId: 'community-one', enabled: true })
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    const scanned = scanPlugins().items.find(entry => entry.id === 'community-one')
    assert.equal(scanned?.state, 'ready')
    assert.equal(scanned?.enabled, true)
    const stateFile = JSON.parse(fs.readFileSync(path.join(pluginsRoot, 'plugins.state.json'), 'utf8'))
    assert.deepEqual(stateFile.enabled, ['community-one'])
  })

  it('停用后回到 disabled', () => {
    const result = setPluginEnabled({ pluginId: 'community-one', enabled: false })
    assert.equal(result.ok, true)
    if (result.ok) {
      // 「停用不影响运行中的实例」常驻在页面说明里，提示只说动作本身
      assert.match(result.message, /已停用/)
      assert.doesNotMatch(result.message, /不受影响/)
    }
    assert.equal(scanPlugins().items.find(entry => entry.id === 'community-one')?.state, 'disabled')
  })

  it('声明危险能力的插件需要显式确认才能启用', () => {
    const manifest = buildManifest({ id: 'danger-plugin', capabilities: ['instances:lifecycle'] })
    seedPlugin('danger-plugin', manifest)

    const rejected = setPluginEnabled({ pluginId: 'danger-plugin', enabled: true })
    assert.equal(rejected.ok, false)
    if (!rejected.ok) {
      assert.match(rejected.message, /instances:lifecycle/)
    }

    const accepted = setPluginEnabled({ pluginId: 'danger-plugin', enabled: true, acknowledgeDangerous: true })
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.message)
  })

  it('装载失败的插件无法被启用', () => {
    const result = setPluginEnabled({ pluginId: 'no-manifest', enabled: true })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.message, /无法启用/)
    }
  })

  it('不存在的插件给出可执行的提示', () => {
    const result = setPluginEnabled({ pluginId: 'not-installed', enabled: true })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.message, /未找到插件/)
    }
  })

  it('商业插件在无授权时启用被拒，状态为 missing_license', () => {
    const manifest = buildManifest({
      id: 'commercial-gated',
      kind: 'commercial',
      // 异地备份所需的能力：备份读写
      capabilities: ['backups:read', 'backups:write'],
    })
    seedPlugin('commercial-gated', manifest, { signature: signManifest(manifest) })

    const result = setPluginEnabled({ pluginId: 'commercial-gated', enabled: true, acknowledgeDangerous: true })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.message, /商业插件/)
      assert.match(result.message, /异地与云备份/)
    }

    // 先强制标记为启用，验证扫描时会给出 missing_license 而不是 ready
    const statePath = path.join(pluginsRoot, 'plugins.state.json')
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, enabled: ['commercial-gated'] }), 'utf8')
    const item = scanPlugins().items.find(entry => entry.id === 'commercial-gated')
    assert.equal(item?.state, 'missing_license')
    assert.equal(item?.enabled, true)
  })

  it('只读指标的轻量插件不受商业授权影响', () => {
    const manifest = buildManifest({ id: 'light-plugin', capabilities: ['metrics:read'] })
    seedPlugin('light-plugin', manifest)
    const result = setPluginEnabled({ pluginId: 'light-plugin', enabled: true })
    assert.equal(result.ok, true, result.ok ? '' : result.message)
  })

  it('插件根路径可由 BSP_PLUGINS_ROOT 指定', () => {
    assert.equal(resolvePluginsRoot(), pluginsRoot)
  })
})
