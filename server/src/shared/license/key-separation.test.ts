import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as signWithKey } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  canonicalizePluginManifest,
  type PluginManifest,
} from '../../../../shared/contracts/plugin'
import {
  canonicalizeLicensePayload,
  licenseFileSchema,
  type LicensePayload,
} from '../../../../shared/contracts/license'
import { loadPluginDirectory } from '../../plugins/manifest'
import { clearLicenseCache, readLicenseState } from './index'

/**
 * 授权密钥与插件密钥的分离。
 *
 * 为什么需要这条边界：许可按**客户**签发、插件包按**发布流程**签发，两者的节奏与失误面
 * 完全不同。用同一把私钥干这两件事，一次插件签名流程的失误（私钥泄露、误签、轮换）就会
 * 波及所有客户的授权。所以核心支持两个公钥变量：
 * - `BSP_LICENSE_PUBLIC_KEY`：验授权许可；
 * - `BSP_PLUGIN_PUBLIC_KEY`：验插件包；未配置时回落到授权公钥（保证既有部署不用改配置）。
 *
 * 用例覆盖四种组合，避免"分离了但谁也没生效"这种最糟的结果。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-key-separation-'))
const licenseKeypair = generateKeyPairSync('ed25519')
const pluginKeypair = generateKeyPairSync('ed25519')
const rotatedKeypair = generateKeyPairSync('ed25519')

const licensePublicBase64 = (licenseKeypair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
const pluginPublicBase64 = (pluginKeypair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
const rotatedPublicBase64 = (rotatedKeypair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')

const originalLicenseKey = process.env.BSP_LICENSE_PUBLIC_KEY
const originalPluginKey = process.env.BSP_PLUGIN_PUBLIC_KEY

function buildLicenseFile(): unknown {
  const payload: LicensePayload = {
    version: 1,
    customer: '密钥分离测试',
    capabilities: ['remote-backup'],
    issuedAt: new Date('2026-09-01T00:00:00.000Z').toISOString(),
    expiresAt: null,
    fingerprint: null,
  }
  const signature = signWithKey(
    null,
    Buffer.from(canonicalizeLicensePayload(payload), 'utf8'),
    licenseKeypair.privateKey,
  ).toString('base64')
  return licenseFileSchema.parse({ payload, signature })
}

/** 造一个用指定私钥签名的商业插件目录 */
function seedSignedPlugin(directory: string, signWith: 'plugin' | 'license' | 'rotated'): string {
  const pluginDir = path.join(workDir, directory)
  fs.mkdirSync(path.join(pluginDir, 'bin'), { recursive: true })
  const manifest: PluginManifest = {
    id: `plugin-${directory}`,
    name: `插件 ${directory}`,
    version: '1.0.0',
    apiVersion: 1,
    kind: 'commercial',
    entry: 'bin/plugin.mjs',
    capabilities: ['backups:read'],
  }
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(pluginDir, 'bin', 'plugin.mjs'), 'process.exit(0)\n', 'utf8')

  const privateKey = signWith === 'plugin'
    ? pluginKeypair.privateKey
    : signWith === 'license'
      ? licenseKeypair.privateKey
      : rotatedKeypair.privateKey
  const signature = signWithKey(
    null,
    Buffer.from(canonicalizePluginManifest(manifest), 'utf8'),
    privateKey,
  ).toString('base64')
  fs.writeFileSync(path.join(pluginDir, 'plugin.signature.json'), `${JSON.stringify({
    version: 1,
    pluginId: manifest.id,
    publisher: 'test',
    signedAt: new Date().toISOString(),
    signature,
  }, null, 2)}\n`, 'utf8')
  return pluginDir
}

before(() => {
  fs.writeFileSync(path.join(workDir, 'license.json'), `${JSON.stringify(buildLicenseFile(), null, 2)}\n`, 'utf8')
  process.env.BSP_LICENSE_PUBLIC_KEY = licensePublicBase64
})

after(() => {
  if (originalLicenseKey === undefined) {
    delete process.env.BSP_LICENSE_PUBLIC_KEY
  }
  else {
    process.env.BSP_LICENSE_PUBLIC_KEY = originalLicenseKey
  }
  if (originalPluginKey === undefined) {
    delete process.env.BSP_PLUGIN_PUBLIC_KEY
  }
  else {
    process.env.BSP_PLUGIN_PUBLIC_KEY = originalPluginKey
  }
  clearLicenseCache()
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('授权密钥与插件密钥分离', () => {
  it('未配置插件公钥时回落到授权公钥：用授权私钥签的插件能装载', () => {
    delete process.env.BSP_PLUGIN_PUBLIC_KEY
    const loaded = loadPluginDirectory(seedSignedPlugin('fallback', 'license'))
    assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.message)
  })

  it('两把密钥不同：用插件私钥签的插件在只配授权公钥时被拒', () => {
    delete process.env.BSP_PLUGIN_PUBLIC_KEY
    const loaded = loadPluginDirectory(seedSignedPlugin('crosskey', 'plugin'))
    assert.equal(loaded.ok, false)
    if (!loaded.ok) {
      assert.match(loaded.message, /签名/)
    }
  })

  it('配置了插件公钥后，用插件私钥签的插件通过、用授权私钥签的被拒', () => {
    process.env.BSP_PLUGIN_PUBLIC_KEY = pluginPublicBase64

    const withPluginKey = loadPluginDirectory(seedSignedPlugin('plugin-key', 'plugin'))
    assert.equal(withPluginKey.ok, true, withPluginKey.ok ? '' : withPluginKey.message)

    const withLicenseKey = loadPluginDirectory(seedSignedPlugin('license-key', 'license'))
    assert.equal(withLicenseKey.ok, false, '插件公钥不该接受授权私钥的签名')
  })

  it('密钥分离不影响授权许可的验签', () => {
    process.env.BSP_PLUGIN_PUBLIC_KEY = pluginPublicBase64
    process.env.BSP_LICENSE_FILE = path.join(workDir, 'license.json')
    clearLicenseCache()
    const state = readLicenseState()
    assert.equal(state.status, 'active', `授权应当仍然有效：${state.message}`)
    assert.deepEqual(state.capabilities, ['remote-backup'])
  })

  it('授权公钥配了两把时，两把签名都能通过（密钥轮换期）', () => {
    process.env.BSP_PLUGIN_PUBLIC_KEY = `${pluginPublicBase64},${rotatedPublicBase64}`
    const rotated = loadPluginDirectory(seedSignedPlugin('rotated', 'rotated'))
    assert.equal(rotated.ok, true, rotated.ok ? '' : rotated.message)
    const primary = loadPluginDirectory(seedSignedPlugin('primary', 'plugin'))
    assert.equal(primary.ok, true, primary.ok ? '' : primary.message)
  })

  it('公钥写错时给出可执行的提示，而不是静默拒绝', () => {
    process.env.BSP_PLUGIN_PUBLIC_KEY = 'not-a-valid-key'
    const loaded = loadPluginDirectory(seedSignedPlugin('badkey', 'plugin'))
    assert.equal(loaded.ok, false)
    if (!loaded.ok) {
      assert.match(loaded.message, /公钥|签名/)
    }
  })
})
