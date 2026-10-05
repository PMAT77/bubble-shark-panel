import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { loadPluginDirectory } from '../../server/src/plugins/manifest'
import { pluginSignatureSchema } from '../../shared/contracts/plugin'
import { signPluginDirectory } from './sign-plugin'

/**
 * 插件签发链路的验证：**签发 → 核心装载**。
 *
 * 这条链路是商业交付的入口，但只在真正卖插件时才跑一次——正是"写坏了也没人发现"的典型。
 * 所以用例真的签发一份，然后交给核心的装载逻辑验收：只断言"文件生成了"没有意义，
 * 能被面板认下来才算通。
 *
 * 这里直接调用 `signPluginDirectory` 而不是跨进程跑 tsx：签发逻辑本身与进程无关，
 * 跨进程只会让用例更慢更脆（CLI 参数解析另有断言覆盖）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-sign-plugin-'))

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privateKeyPath = path.join(workDir, 'plugin-private.bsp-key')
const publicKeyBase64 = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')

const originalPluginKey = process.env.BSP_PLUGIN_PUBLIC_KEY

function freshPluginCopy(name: string): string {
  const target = path.join(workDir, name)
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(path.join(repoRoot, 'examples', 'plugins', 'remote-backup'), target, { recursive: true })
  fs.rmSync(path.join(target, 'plugin.signature.json'), { force: true })
  return target
}

before(() => {
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { encoding: 'utf8', mode: 0o600 })
  process.env.BSP_PLUGIN_PUBLIC_KEY = publicKeyBase64
})

after(() => {
  if (originalPluginKey === undefined) {
    delete process.env.BSP_PLUGIN_PUBLIC_KEY
  }
  else {
    process.env.BSP_PLUGIN_PUBLIC_KEY = originalPluginKey
  }
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('插件签发', () => {
  it('签发商业插件后，核心能验证通过并显示发布方', () => {
    const pluginDir = freshPluginCopy('remote-backup')
    const result = signPluginDirectory({
      pluginDir,
      keyPath: privateKeyPath,
      publisher: 'smoke-test',
    })
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (result.ok) {
      assert.equal(result.pluginId, 'pro-remote-backup')
      assert.equal(result.kind, 'commercial')
      assert.ok(result.capabilities.includes('backups:read'))
    }

    const signaturePath = path.join(pluginDir, 'plugin.signature.json')
    const parsed = pluginSignatureSchema.safeParse(JSON.parse(fs.readFileSync(signaturePath, 'utf8')))
    assert.equal(parsed.success, true, `签名文件应当符合契约：${JSON.stringify(parsed.error?.issues)}`)
    assert.equal(parsed.data?.publisher, 'smoke-test')

    const loaded = loadPluginDirectory(pluginDir)
    assert.equal(loaded.ok, true, loaded.ok ? '' : `核心拒绝了这个签名：${loaded.message}`)
    if (loaded.ok) {
      assert.equal(loaded.signed, true)
      assert.equal(loaded.publisher, 'smoke-test')
    }
  })

  it('清单被改动后原签名失效，重签后恢复', () => {
    const pluginDir = freshPluginCopy('remote-backup')
    assert.equal(signPluginDirectory({ pluginDir, keyPath: privateKeyPath }).ok, true)

    const manifestPath = path.join(pluginDir, 'plugin.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.capabilities = [...manifest.capabilities, 'instances:lifecycle']
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const tampered = loadPluginDirectory(pluginDir)
    assert.equal(tampered.ok, false, '改了清单还想过验签，说明签名没覆盖到能力清单')
    if (!tampered.ok) {
      assert.match(tampered.message, /签名/)
    }

    const resigned = signPluginDirectory({ pluginDir, keyPath: privateKeyPath, force: true })
    assert.equal(resigned.ok, true, resigned.ok ? '' : resigned.message)
    const afterResign = loadPluginDirectory(pluginDir)
    assert.equal(afterResign.ok, true, afterResign.ok ? '' : afterResign.message)
  })

  it('已有签名时默认拒绝覆盖，--force 才允许', () => {
    const pluginDir = freshPluginCopy('remote-backup')
    assert.equal(signPluginDirectory({ pluginDir, keyPath: privateKeyPath }).ok, true)

    const blocked = signPluginDirectory({ pluginDir, keyPath: privateKeyPath })
    assert.equal(blocked.ok, false)
    if (!blocked.ok) {
      assert.match(blocked.message, /已存在/)
    }

    const forced = signPluginDirectory({ pluginDir, keyPath: privateKeyPath, force: true })
    assert.equal(forced.ok, true, forced.ok ? '' : forced.message)
  })

  it('私钥缺失、目录缺清单、清单非法时给出明确原因', () => {
    const pluginDir = freshPluginCopy('remote-backup')

    const missingKey = signPluginDirectory({ pluginDir, keyPath: path.join(workDir, 'nope.bsp-key') })
    assert.equal(missingKey.ok, false)
    if (!missingKey.ok) {
      assert.match(missingKey.message, /私钥不存在/)
    }

    const emptyDir = path.join(workDir, 'empty')
    fs.mkdirSync(emptyDir, { recursive: true })
    const missingManifest = signPluginDirectory({ pluginDir: emptyDir, keyPath: privateKeyPath })
    assert.equal(missingManifest.ok, false)
    if (!missingManifest.ok) {
      assert.match(missingManifest.message, /plugin\.json/)
    }

    const badDir = path.join(workDir, 'bad-manifest')
    fs.mkdirSync(badDir, { recursive: true })
    fs.writeFileSync(path.join(badDir, 'plugin.json'), JSON.stringify({ id: 'BAD_ID' }), 'utf8')
    const badManifest = signPluginDirectory({ pluginDir: badDir, keyPath: privateKeyPath })
    assert.equal(badManifest.ok, false)
    if (!badManifest.ok) {
      assert.match(badManifest.message, /清单字段不合法/)
    }
  })

  it('社区插件也能签发（签名可选，但带签名时同样被校验）', () => {
    const target = path.join(workDir, 'audit-reporter')
    fs.rmSync(target, { recursive: true, force: true })
    fs.cpSync(path.join(repoRoot, 'examples', 'plugins', 'audit-reporter'), target, { recursive: true })

    const result = signPluginDirectory({ pluginDir: target, keyPath: privateKeyPath, force: true })
    assert.equal(result.ok, true, result.ok ? '' : result.message)
    if (result.ok) {
      assert.equal(result.kind, 'community')
    }
    const loaded = loadPluginDirectory(target)
    assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.message)
    if (loaded.ok) {
      assert.equal(loaded.signed, true)
    }
  })
})
