import type { PluginCapability, PluginKind, PluginManifest } from '../../../shared/contracts/plugin'
import fs from 'node:fs'
import path from 'node:path'
import { verify as verifySignature } from 'node:crypto'
import {
  canonicalizePluginManifest,
  checkPluginApiCompatibility,
  isDangerousPluginCapability,
  PLUGIN_HOST_API_VERSION,
  pluginKindSchema,
  pluginManifestSchema,
  pluginSignatureSchema,
} from '../../../shared/contracts/plugin'
import { loadPluginPublicKeys } from '../shared/license/verify'

/**
 * 单个插件目录的装载与校验。
 *
 * 目录约定：
 * ```text
 * <插件根>/<目录名>/
 *   plugin.json            清单（必需）
 *   plugin.signature.json  商业插件签名（commercial 类型必需）
 *   <entry>                入口可执行文件，清单里声明
 * ```
 *
 * 校验顺序：清单存在与合法 → 入口存在 → API 版本兼容 → 签名（商业插件必需）。
 * 顺序有意义：先给出「文件没放对」这类管理员自己能修的错误，再报签名与版本问题——
 * 装插件的人多半是照着文档拷目录，最常见的失败是少文件或放错层级。
 */

export type PluginLoadResult
  = | { ok: true, manifest: PluginManifest, signed: boolean, publisher: string | null }
    | { ok: false, message: string }

const MANIFEST_FILE = 'plugin.json'
const SIGNATURE_FILE = 'plugin.signature.json'

/** 入口路径必须是插件目录内的相对路径：拒绝绝对路径与 `..` 逃逸 */
function isSafeRelativeEntry(entry: string): boolean {
  if (path.isAbsolute(entry) || /^[A-Za-z]:[\\/]/.test(entry)) {
    return false
  }
  const normalized = path.normalize(entry)
  return !normalized.startsWith('..') && !normalized.includes(`..${path.sep}`)
}

/**
 * 校验商业插件签名。
 *
 * 公钥与授权许可共用同一套（`BSP_LICENSE_PUBLIC_KEY`）：插件与许可是同一个商业信任根，
 * 分成两套密钥只会让「换密钥」变成两次运维事故。
 */
function verifyPluginSignature(
  pluginDir: string,
  manifest: PluginManifest,
): { ok: true, publisher: string } | { ok: false, message: string } {
  const signaturePath = path.join(pluginDir, SIGNATURE_FILE)
  if (!fs.existsSync(signaturePath)) {
    return {
      ok: false,
      message: `商业插件缺少 ${SIGNATURE_FILE}：该文件由发布方随插件提供，缺失或丢失时应重新获取插件包。`,
    }
  }

  let parsedRaw: unknown
  try {
    parsedRaw = JSON.parse(fs.readFileSync(signaturePath, 'utf8'))
  }
  catch {
    return { ok: false, message: `${SIGNATURE_FILE} 不是合法的 JSON。` }
  }

  const parsed = pluginSignatureSchema.safeParse(parsedRaw)
  if (!parsed.success) {
    return { ok: false, message: `${SIGNATURE_FILE} 格式不正确：缺少插件标识、发布方或签名。` }
  }
  const signature = parsed.data
  if (signature.pluginId !== manifest.id) {
    return {
      ok: false,
      message: `签名中的插件标识（${signature.pluginId}）与清单（${manifest.id}）不一致。`,
    }
  }

  const publicKeys = loadPluginPublicKeys()
  if (publicKeys.length === 0) {
    return {
      ok: false,
      message: '此构建未内置插件签名公钥（BSP_PLUGIN_PUBLIC_KEY 或 BSP_LICENSE_PUBLIC_KEY）：无法校验商业插件签名。',
    }
  }

  let signatureValid = false
  try {
    const signedBytes = Buffer.from(canonicalizePluginManifest(manifest), 'utf8')
    const signatureBytes = Buffer.from(signature.signature, 'base64')
    signatureValid = publicKeys.some((key) => {
      try {
        return verifySignature(null, signedBytes, key, signatureBytes)
      }
      catch {
        return false
      }
    })
  }
  catch {
    signatureValid = false
  }
  if (!signatureValid) {
    return {
      ok: false,
      message: '插件签名校验失败：清单内容与签名不符，或不是本项目的插件包。请向提供方重新获取。',
    }
  }
  return { ok: true, publisher: signature.publisher }
}

/** 装载一个插件目录：只读操作，不启动任何进程，也不修改目录内容 */
export function loadPluginDirectory(
  pluginDir: string,
  options: { hostApiVersion?: number } = {},
): PluginLoadResult {
  const manifestPath = path.join(pluginDir, MANIFEST_FILE)
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, message: `目录下没有 ${MANIFEST_FILE}：解压时可能多套了一层目录。` }
  }

  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  }
  catch (error) {
    return { ok: false, message: `${MANIFEST_FILE} 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}` }
  }

  const parsed = pluginManifestSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path.join('.') || MANIFEST_FILE
    return { ok: false, message: `清单字段不合法（${where}）：${first?.message ?? '格式错误'}` }
  }
  const manifest = parsed.data

  if (!isSafeRelativeEntry(manifest.entry)) {
    return { ok: false, message: `入口路径必须是插件目录内的相对路径，当前为：${manifest.entry}` }
  }
  if (!fs.existsSync(path.join(pluginDir, manifest.entry))) {
    return { ok: false, message: `清单声明的入口不存在：${manifest.entry}` }
  }

  const compatibility = checkPluginApiCompatibility(
    manifest.apiVersion,
    options.hostApiVersion ?? PLUGIN_HOST_API_VERSION,
  )
  if (!compatibility.ok) {
    return { ok: false, message: compatibility.message }
  }

  if (manifest.kind === 'commercial') {
    const signature = verifyPluginSignature(pluginDir, manifest)
    if (!signature.ok) {
      return { ok: false, message: signature.message }
    }
    return { ok: true, manifest, signed: true, publisher: signature.publisher }
  }

  // 社区插件允许未签名，但带签名时同样校验（签错了要报错，而不是当作没签名放过）
  const signaturePath = path.join(pluginDir, SIGNATURE_FILE)
  if (fs.existsSync(signaturePath)) {
    const signature = verifyPluginSignature(pluginDir, manifest)
    if (!signature.ok) {
      return { ok: false, message: `签名存在问题：${signature.message}` }
    }
    return { ok: true, manifest, signed: true, publisher: signature.publisher }
  }
  return { ok: true, manifest, signed: false, publisher: null }
}

export interface PluginCapabilitySummary {
  capabilities: PluginCapability[]
  hasDangerousCapabilities: boolean
}

/** 汇总插件申请的能力，供界面提示「这个插件能干什么」 */
export function summarizePluginCapabilities(manifest: PluginManifest): PluginCapabilitySummary {
  const capabilities = [...manifest.capabilities]
  return {
    capabilities,
    hasDangerousCapabilities: capabilities.some(isDangerousPluginCapability),
  }
}

/** 清单里的类型字段是否合法（供扫描时快速过滤明显放错的目录） */
export function isSupportedPluginKind(value: unknown): value is PluginKind {
  return pluginKindSchema.safeParse(value).success
}
