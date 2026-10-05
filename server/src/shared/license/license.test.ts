import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as signWithKey } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  canonicalizeLicensePayload,
  licenseFileSchema,
  type LicenseCapability,
  type LicensePayload,
} from '../../../../shared/contracts/license'
import { clearLicenseCache, readLicenseState, resolveLicenseFilePath } from './index'
import { communityLicenseState, inspectLicenseFile } from './verify'

/**
 * 授权验签的测试。
 *
 * 这套机制存在的意义只有一个：**让 Pro 能力可以按授权开关，同时绝不影响 Community 核心**。
 * 所以用例除了验签本身，重点盯三件事：
 *   1. 篡改任何一个字段都必须被拒（否则整个许可形同虚设）；
 *   2. 过期与无效都**不能**演变成「拒绝服务」——状态要清楚，调用方拿得到能力清单为空；
 *   3. 设备绑定必须真绑定，且签发方与运行方用同一套指纹算法。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-license-'))
const licensePath = path.join(workDir, 'license.json')

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

function buildPayload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    version: 1,
    customer: '测试客户',
    capabilities: ['multi-node', 'audit-log'] as LicenseCapability[],
    issuedAt: new Date('2026-09-01T00:00:00.000Z').toISOString(),
    expiresAt: null,
    fingerprint: null,
    ...overrides,
  }
}

function signPayload(payload: LicensePayload): string {
  return signWithKey(null, Buffer.from(canonicalizeLicensePayload(payload), 'utf8'), privateKey).toString('base64')
}

function writeLicense(payload: LicensePayload, signature = signPayload(payload)): void {
  fs.writeFileSync(licensePath, `${JSON.stringify({ payload, signature }, null, 2)}\n`, 'utf8')
  clearLicenseCache()
}

beforeEach(() => {
  process.env.BSP_LICENSE_FILE = licensePath
  process.env.BSP_LICENSE_PUBLIC_KEY = publicPem
  clearLicenseCache()
})

afterEach(() => {
  clearLicenseCache()
})

describe('canonicalizeLicensePayload', () => {
  it('与键顺序无关，签发的字节与验签的字节必然一致', () => {
    const a: LicensePayload = buildPayload({ note: 'a' })
    const b = {
      note: 'a',
      fingerprint: null,
      expiresAt: null,
      issuedAt: a.issuedAt,
      capabilities: a.capabilities,
      customer: a.customer,
      version: 1 as const,
    }
    assert.equal(canonicalizeLicensePayload(a), canonicalizeLicensePayload(b as LicensePayload))
  })

  it('忽略值为 undefined 的可选字段，不会因此产生两种字节', () => {
    const withUndefined = { ...buildPayload(), fingerprint: undefined } as unknown as LicensePayload
    assert.equal(canonicalizeLicensePayload(withUndefined), canonicalizeLicensePayload(buildPayload()))
  })
})

describe('inspectLicenseFile', () => {
  it('验签通过且未过期时给出 active 与能力清单', () => {
    const payload = buildPayload()
    const { state } = inspectLicenseFile({ payload, signature: signPayload(payload) })
    assert.equal(state.status, 'active')
    assert.deepEqual(state.capabilities, ['multi-node', 'audit-log'])
    assert.equal(state.customer, '测试客户')
    assert.equal(state.bound, false)
    assert.equal(state.expiresAt, null)
    assert.equal(state.daysRemaining, null)
  })

  it('篡改客户名后验签失败，能力清单为空', () => {
    const payload = buildPayload()
    const signature = signPayload(payload)
    const tampered = { ...payload, customer: '别人' }
    const { state } = inspectLicenseFile({ payload: tampered, signature })
    assert.equal(state.status, 'invalid')
    assert.deepEqual(state.capabilities, [])
    assert.match(state.message, /签名/)
  })

  it('篡改能力清单同样被拒（不能靠改 JSON 自助升级）', () => {
    const payload = buildPayload({ capabilities: ['audit-log'] })
    const signature = signPayload(payload)
    const tampered = { ...payload, capabilities: ['multi-node', 'audit-log', 'remote-backup'] }
    assert.equal(inspectLicenseFile({ payload: tampered, signature }).state.status, 'invalid')
  })

  it('缺少公钥时判为无效但不抛异常（面板不能因此起不来）', () => {
    const payload = buildPayload()
    const file = { payload, signature: signPayload(payload) }
    const original = process.env.BSP_LICENSE_PUBLIC_KEY
    delete process.env.BSP_LICENSE_PUBLIC_KEY
    try {
      const { state } = inspectLicenseFile(file)
      assert.equal(state.status, 'invalid')
      assert.match(state.message, /公钥/)
    }
    finally {
      process.env.BSP_LICENSE_PUBLIC_KEY = original
    }
  })

  /**
   * 公钥在 panel.env 里有三种常见写法：单行 base64（keygen 打印的形式）、
   * 带真实换行的多行 PEM、以及把换行写成 `\n` 的单行 PEM。
   * 三种都必须能验签成功——只支持其中一种的话，客户会拿到「未内置授权公钥」这种
   * 看起来像构建问题的报错，而实际只是粘贴格式不同。
   */
  it('公钥的三种写法都能验签成功', () => {
    const payload = buildPayload()
    const signature = signPayload(payload)
    const base64Only = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
    const variants = [
      base64Only,
      publicPem,
      publicPem.replace(/\n/g, '\\n'),
      publicPem.replace(/\n/g, ''),
    ]
    const original = process.env.BSP_LICENSE_PUBLIC_KEY
    try {
      for (const variant of variants) {
        process.env.BSP_LICENSE_PUBLIC_KEY = variant
        const { state } = inspectLicenseFile({ payload, signature })
        assert.equal(state.status, 'active', `这种公钥写法未能通过验签：${variant.slice(0, 24)}…`)
      }
    }
    finally {
      process.env.BSP_LICENSE_PUBLIC_KEY = original
    }
  })

  it('过期后是 expired 而不是崩溃，且能力清零、文案说明不影响运行中的实例', () => {
    const payload = buildPayload({ expiresAt: new Date('2026-01-01T00:00:00.000Z').toISOString() })
    const { state } = inspectLicenseFile(
      { payload, signature: signPayload(payload) },
      { now: new Date('2026-09-22T00:00:00.000Z') },
    )
    assert.equal(state.status, 'expired')
    assert.deepEqual(state.capabilities, [])
    assert.match(state.message, /Community 功能与运行中的实例不受影响/)
  })

  it('时钟偏差在 6 小时内不误判过期', () => {
    const expiresAt = new Date('2026-09-22T00:00:00.000Z')
    const payload = buildPayload({ expiresAt: expiresAt.toISOString() })
    // 机器时间比到期时间快 3 小时：仍应判为有效
    const { state } = inspectLicenseFile(
      { payload, signature: signPayload(payload) },
      { now: new Date(expiresAt.getTime() + 3 * 60 * 60 * 1000) },
    )
    assert.equal(state.status, 'active')
    assert.equal(state.daysRemaining, 0)
  })

  it('绑定设备时指纹不一致判为无效，并标记为已绑定', () => {
    const payload = buildPayload({ fingerprint: 'bsp-expected-fingerprint' })
    const { state } = inspectLicenseFile(
      { payload, signature: signPayload(payload) },
      { machineFingerprint: 'bsp-other-machine' },
    )
    assert.equal(state.status, 'invalid')
    assert.equal(state.bound, true)
    assert.match(state.message, /另一台机器/)
  })

  it('绑定设备且指纹一致时生效', () => {
    const payload = buildPayload({ fingerprint: 'bsp-same-machine' })
    const { state } = inspectLicenseFile(
      { payload, signature: signPayload(payload) },
      { machineFingerprint: 'bsp-same-machine' },
    )
    assert.equal(state.status, 'active')
    assert.equal(state.bound, true)
  })

  it('格式不符的文件不会让调用方拿到能力', () => {
    for (const malformed of [{}, { payload: {} }, { payload: buildPayload() }, null, 'not-json']) {
      const { state } = inspectLicenseFile(malformed)
      assert.equal(state.status, 'invalid', `应当拒绝：${JSON.stringify(malformed)?.slice(0, 40)}`)
      assert.deepEqual(state.capabilities, [])
    }
  })
})

describe('readLicenseState', () => {
  it('没有许可文件时是 community 常态，且文案说明核心功能完整可用', () => {
    fs.rmSync(licensePath, { force: true })
    clearLicenseCache()
    const state = readLicenseState()
    assert.equal(state.status, 'none')
    assert.match(state.message, /Community 核心功能完整可用/)
    assert.deepEqual(state.capabilities, [])
  })

  it('文件损坏时不抛异常，按无效处理并给出路径', () => {
    fs.writeFileSync(licensePath, '{ 这不是 JSON', 'utf8')
    clearLicenseCache()
    const state = readLicenseState()
    assert.equal(state.status, 'invalid')
    assert.match(state.message, /无法解析/)
  })

  it('读取路径可用 BSP_LICENSE_FILE 指定', () => {
    assert.equal(resolveLicenseFilePath(), licensePath)
  })

  it('有效许可写入后即生效，且能力清单与签发一致', async () => {
    writeLicense(buildPayload({ capabilities: ['remote-backup'] as LicenseCapability[] }))
    const state = readLicenseState()
    assert.equal(state.status, 'active')
    assert.deepEqual(state.capabilities, ['remote-backup'])
  })

  it('许可文件被替换后（mtime 变化）状态随之更新', async () => {
    writeLicense(buildPayload({ capabilities: ['audit-log'] as LicenseCapability[] }))
    assert.deepEqual(readLicenseState().capabilities, ['audit-log'])
    // 同一毫秒内写入会让 mtime 不变，缓存按设计不会失效；这里等一下以模拟真实的文件替换
    await new Promise(resolve => setTimeout(resolve, 20))
    const replaced: LicensePayload = buildPayload({ capabilities: ['multi-node'] as LicenseCapability[] })
    writeLicense(replaced)
    assert.deepEqual(readLicenseState().capabilities, ['multi-node'])
  })

  it('契约 schema 能解析签发出的文件', () => {
    const payload = buildPayload()
    const parsed = licenseFileSchema.safeParse({ payload, signature: signPayload(payload) })
    assert.equal(parsed.success, true)
  })
})

describe('communityLicenseState', () => {
  it('默认文案强调「与是否购买无关」', () => {
    assert.match(communityLicenseState().message, /与是否购买无关/)
  })
})
