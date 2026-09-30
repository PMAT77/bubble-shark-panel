import type { KeyObject } from 'node:crypto'
import type { LicenseFile, LicensePayload, LicenseState } from '../../../../shared/contracts/license'
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import process from 'node:process'
import {
  canonicalizeLicensePayload,
  licenseCapabilitySchema,
  licenseFileSchema,
} from '../../../../shared/contracts/license'
import { resolveMachineFingerprint } from './fingerprint'

/**
 * 许可验签与状态判定（纯逻辑，不读文件）。
 *
 * 内置公钥通过 `GSH_LICENSE_PUBLIC_KEY` 提供（PEM 或 base64 的 SPKI DER）：
 * 公钥不是秘密，正式发布时随构建注入即可。**私钥永远不进仓库、不进构建产物**，
 * 只存在于发布方的离线签发环境，见内部文档 `docs_local/license.md`。
 */

/** 缓存解析后的公钥：验签是热路径（面板每次读状态都会走），重复解析 PEM 没有必要 */
const publicKeyCache = new Map<string, KeyObject>()

/**
 * 解析一个或多个公钥。
 *
 * 为什么支持多个：授权许可与插件包在信任模型上是两件事——
 * 许可按客户签发，插件包按发布流程签发；用同一把私钥同时干这两件事，
 * 一旦插件签名流程出错就波及所有客户的授权。所以允许把两者的公钥分开配置
 * （`GSH_LICENSE_PUBLIC_KEY` 与 `GSH_PLUGIN_PUBLIC_KEY`），
 * 同时又保持"只配一个也能跑"的简单部署。
 *
 * 取值可以是单个 PEM / base64，也可以用换行或逗号分隔多个（便于密钥轮换期同时信任新旧两把）。
 */
export function parsePublicKeys(raw: string | undefined | null): KeyObject[] {
  const value = raw?.trim()
  if (!value) {
    return []
  }
  /**
   * 切分规则要同时兼容三种写法，写错就会表现成「公钥明明配了却验不过」：
   * 1. 完整 PEM（可能多行）；
   * 2. 单行 base64（keygen 打印的形式）；
   * 3. 多个公钥用逗号或换行分隔（密钥轮换期同时信任新旧两把）。
   * 所以先整体抓出 PEM 块，再把剩下的按逗号/空白切开。
   */
  const chunks: string[] = []
  const pemPattern = /-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g
  const pemMatches = value.match(pemPattern)
  if (pemMatches) {
    chunks.push(...pemMatches)
  }
  const remainder = value.replace(pemPattern, ' ')
  chunks.push(...remainder.split(/[\s,]+/).map(item => item.trim()).filter(Boolean))

  const keys: KeyObject[] = []
  for (const chunk of chunks) {
    const pem = toPem(chunk)
    if (!pem) {
      continue
    }
    const cached = publicKeyCache.get(pem)
    if (cached) {
      keys.push(cached)
      continue
    }
    try {
      const key = createPublicKey(pem)
      publicKeyCache.set(pem, key)
      keys.push(key)
    }
    catch {
      // 单个公钥格式错误不影响其它公钥
    }
  }
  return keys
}

/** 把 PEM 或单行 base64 统一成可解析的 PEM */
function toPem(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.includes('BEGIN PUBLIC KEY')) {
    const body = trimmed
      .replace(/\\n/g, '\n')
      .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
      .replace(/\s+/g, '')
    const lines = body.match(/.{1,64}/g)
    return lines ? `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n` : null
  }
  const lines = trimmed.replace(/\s+/g, '').match(/.{1,64}/g)
  return lines ? `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n` : null
}

/** 授权许可的公钥（首个）；保留单值形式供既有调用方使用 */
export function resolveLicensePublicKeyPem(): string | null {
  const raw = process.env.GSH_LICENSE_PUBLIC_KEY?.trim()
  if (!raw) {
    return null
  }
  // 支持两种写法：完整 PEM（panel.env 里可以写成一行，用 \n 表示换行），或单行 base64。
  if (raw.includes('BEGIN PUBLIC KEY')) {
    const normalized = raw.replace(/\\n/g, '\n')
    // 单行 PEM 的 base64 部分需要重新按 64 列折行，否则 OpenSSL 解析不了
    const body = normalized
      .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
      .replace(/\s+/g, '')
    const lines = body.match(/.{1,64}/g)
    return lines ? `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n` : null
  }
  const lines = raw.replace(/\s+/g, '').match(/.{1,64}/g)
  return lines ? `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n` : null
}

/**
 * 插件包的验签公钥。
 *
 * 优先取 `GSH_PLUGIN_PUBLIC_KEY`（推荐：与授权分开两把密钥）；
 * 未配置时回落到授权公钥，保证既有部署不用改配置也能继续验签插件。
 * 返回**原始配置值**（可能含多个公钥），由 `parsePublicKeys` 统一切分。
 */
export function resolvePluginPublicKeyRaw(): string | null {
  return process.env.GSH_PLUGIN_PUBLIC_KEY?.trim() || process.env.GSH_LICENSE_PUBLIC_KEY?.trim() || null
}

export function loadLicensePublicKeys(): KeyObject[] {
  return parsePublicKeys(process.env.GSH_LICENSE_PUBLIC_KEY)
}

export function loadPluginPublicKeys(): KeyObject[] {
  return parsePublicKeys(resolvePluginPublicKeyRaw())
}

export function resolveMachineFingerprintForLicense(dataDir?: string): string | null {
  return resolveMachineFingerprint({ dataDir })
}

export interface LicenseInspection {
  state: LicenseState
  payload: LicensePayload | null
}

function inactiveState(
  status: Exclude<LicenseState['status'], 'active'>,
  message: string,
  payload: LicensePayload | null,
  extra: { bound?: boolean, fingerprintMismatch?: boolean } = {},
): LicenseState {
  return {
    status,
    message,
    capabilities: [],
    customer: payload?.customer ?? null,
    issuedAt: payload?.issuedAt ?? null,
    expiresAt: payload?.expiresAt ?? null,
    bound: extra.bound ?? Boolean(payload?.fingerprint),
    daysRemaining: null,
  }
}

/** 允许的时钟偏差余量：客户机器时间略快不应把有效许可判过期 */
const CLOCK_SKEW_MS = 6 * 60 * 60 * 1000

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * 校验一份许可文件的内容（不读盘）并给出状态。
 *
 * 判定顺序刻意如此：格式 → 公钥 → 验签 → 设备 → 到期。
 * 先验签再看设备与时间，避免「改一个字段就能绕过」。
 */
export function inspectLicenseFile(
  raw: unknown,
  options: { now?: Date, machineFingerprint?: string | null, dataDir?: string } = {},
): LicenseInspection {
  const parsed = licenseFileSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      state: inactiveState('invalid', '许可文件格式不正确：无法解析出授权内容与签名。', null),
      payload: null,
    }
  }
  const file: LicenseFile = parsed.data
  const payload = file.payload

  const publicKeys = loadLicensePublicKeys()
  if (publicKeys.length === 0) {
    return {
      state: inactiveState('invalid', '此构建未内置授权公钥，无法校验许可。', payload),
      payload,
    }
  }

  const data = Buffer.from(canonicalizeLicensePayload(payload), 'utf8')
  const signatureBytes = Buffer.from(file.signature, 'base64')
  // 逐个公钥尝试：支持密钥轮换期同时信任新旧两把，任一验签成功即视为有效
  const signatureValid = publicKeys.some((key) => {
    try {
      return verifySignature(null, data, key, signatureBytes)
    }
    catch {
      return false
    }
  })
  if (!signatureValid) {
    return {
      state: inactiveState('invalid', '许可签名校验失败：文件可能被修改过，或不是本项目的授权文件。', payload),
      payload,
    }
  }

  if (payload.fingerprint) {
    const fingerprint = options.machineFingerprint ?? resolveMachineFingerprintForLicense(options.dataDir)
    if (!fingerprint || fingerprint !== payload.fingerprint) {
      return {
        state: inactiveState('invalid', '许可绑定了另一台机器：换机器或重装系统后需要重新签发。', payload, { bound: true }),
        payload,
      }
    }
  }

  const capabilities = payload.capabilities.filter(item => licenseCapabilitySchema.safeParse(item).success)
  const now = (options.now ?? new Date()).getTime()
  const expiresAt = parseTimestamp(payload.expiresAt)
  if (expiresAt !== null && now > expiresAt + CLOCK_SKEW_MS) {
    return {
      state: inactiveState('expired', `许可已于 ${payload.expiresAt} 到期；已安装的 Community 功能与运行中的实例不受影响。`, payload),
      payload,
    }
  }

  const daysRemaining = expiresAt === null
    ? null
    : Math.max(0, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)))
  return {
    state: {
      status: 'active',
      message: expiresAt === null
        ? `授权有效（永久）。`
        : `授权有效，剩余 ${daysRemaining} 天。`,
      capabilities,
      customer: payload.customer,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      bound: Boolean(payload.fingerprint),
      daysRemaining,
    },
    payload,
  }
}

/** 没有许可文件时的状态：Community 常态，明确说明核心能力不受影响 */
export function communityLicenseState(): LicenseState {
  return {
    status: 'none',
    message: '未安装授权文件：Community 核心功能完整可用，这与是否购买无关。',
    capabilities: [],
    customer: null,
    issuedAt: null,
    expiresAt: null,
    bound: false,
    daysRemaining: null,
  }
}
