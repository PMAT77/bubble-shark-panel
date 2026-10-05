#!/usr/bin/env node
/**
 * 为插件目录签发 `plugin.signature.json`（离线工具，私有环境执行）。
 *
 * 商业插件（`kind: "commercial"`）必须带签名才能被装载；签名对象是**清单**的规范化 JSON，
 * 而不是整个压缩包——tar 的字节会因打包工具与时间戳变化，签包体会让「同一份内容、两次打包」
 * 无法复现，而清单里已经包含 id、version、apiVersion、capabilities 等全部授权相关字段。
 *
 * 用法：
 *   pnpm exec tsx scripts/plugins/sign-plugin.ts --dir examples/plugins/remote-backup \
 *     --key ~/.bsp-license-keys/plugin-private.bsp-key \
 *     [--publisher gsh-official] [--force]
 *
 * 密钥建议与授权许可分开（`generate-keypair.ts --purpose plugin`）：
 * 许可按客户签发、插件按发布流程签发，混用一把私钥会让插件流程的失误波及所有客户授权。
 * 分开后，客户侧需要同时配置 `BSP_LICENSE_PUBLIC_KEY` 与 `BSP_PLUGIN_PUBLIC_KEY`。
 *
 * 签发逻辑写成可导入的函数（`signPluginDirectory`），CLI 只是它的一层壳：
 * 这样测试可以直接调用并断言产物，而不必跨进程跑 tsx。
 */
import { createPrivateKey, sign as signPayload } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  canonicalizePluginManifest,
  pluginManifestSchema,
  pluginSignatureSchema,
} from '../../shared/contracts/plugin.ts'

const SIGNATURE_FILE = 'plugin.signature.json'

export type SignPluginResult
  = | {
    ok: true
    outputPath: string
    pluginId: string
    pluginName: string
    kind: string
    capabilities: string[]
    publisher: string
  }
    | { ok: false, message: string }

export interface SignPluginOptions {
  pluginDir: string
  keyPath: string
  publisher?: string
  force?: boolean
}

/** 签发一个插件目录；返回结构化结果，不打印、不退出 */
export function signPluginDirectory(options: SignPluginOptions): SignPluginResult {
  const pluginDir = path.resolve(options.pluginDir)
  const manifestPath = path.join(pluginDir, 'plugin.json')
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, message: `目录下没有 plugin.json：${pluginDir}` }
  }
  if (!fs.existsSync(options.keyPath)) {
    return { ok: false, message: `私钥不存在：${options.keyPath}。先在离线环境运行 generate-keypair.ts。` }
  }

  let manifestRaw: unknown
  try {
    manifestRaw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  }
  catch (error) {
    return { ok: false, message: `plugin.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }

  const parsed = pluginManifestSchema.safeParse(manifestRaw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return {
      ok: false,
      message: `清单字段不合法（${first?.path.join('.') || 'plugin.json'}）：${first?.message ?? '格式错误'}`,
    }
  }
  const manifest = parsed.data

  let privateKey
  try {
    privateKey = createPrivateKey(fs.readFileSync(options.keyPath, 'utf8'))
  }
  catch (error) {
    return { ok: false, message: `私钥无法解析：${error instanceof Error ? error.message : String(error)}` }
  }

  const signature = signPayload(
    null,
    Buffer.from(canonicalizePluginManifest(manifest), 'utf8'),
    privateKey,
  ).toString('base64')

  const publisher = options.publisher?.trim() || 'gsh-official'
  const file = pluginSignatureSchema.parse({
    version: 1,
    pluginId: manifest.id,
    publisher,
    signedAt: new Date().toISOString(),
    signature,
  })

  const outputPath = path.join(pluginDir, SIGNATURE_FILE)
  if (!options.force && fs.existsSync(outputPath)) {
    return { ok: false, message: `签名文件已存在：${outputPath}（加 --force 覆盖；覆盖后旧签名立即失效）` }
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')

  return {
    ok: true,
    outputPath,
    pluginId: manifest.id,
    pluginName: manifest.name,
    kind: manifest.kind,
    capabilities: manifest.capabilities,
    publisher,
  }
}

interface CliArgs extends SignPluginOptions {}

function fail(message: string): never {
  console.error(`[sign-plugin] ${message}`)
  process.exit(1)
}

function parseArgs(argv: string[]): CliArgs {
  const values: Record<string, string> = {}
  let force = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      console.log('用法：pnpm exec tsx scripts/plugins/sign-plugin.ts --dir <插件目录> --key <私钥> [--publisher 名称] [--force]')
      process.exit(0)
    }
    if (!arg.startsWith('--')) {
      fail(`无法识别的参数：${arg}`)
    }
    const key = arg.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      fail(`参数 --${key} 缺少取值`)
    }
    values[key] = value
    index += 1
  }
  if (!values.dir || !values.key) {
    fail('必须提供 --dir 与 --key（--help 查看用法）')
  }
  return {
    pluginDir: path.resolve(values.dir),
    keyPath: path.resolve(values.key),
    publisher: values.publisher,
    force,
  }
}

/** 仅在作为脚本直接运行时执行 CLI（被测试 import 时不动） */
if (process.argv[1] && /sign-plugin\.(ts|js|mjs)$/.test(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2))
  const result = signPluginDirectory(args)
  if (!result.ok) {
    fail(result.message)
  }
  console.log('[sign-plugin] 已签发')
  console.log(`  插件：${result.pluginName}（${result.pluginId}）`)
  console.log(`  类型：${result.kind}`)
  console.log(`  能力：${result.capabilities.join('、') || '（无）'}`)
  console.log(`  发布方：${result.publisher}`)
  console.log(`  文件：${result.outputPath}`)
  console.log('')
  if (result.kind !== 'commercial') {
    console.log('[sign-plugin] 注意：这是社区插件，签名可选（但带签名时同样会被校验）。')
  }
  console.log('[sign-plugin] 提醒：清单改动后必须重新签发，否则面板会以「签名校验失败」拒绝装载。')
}
