#!/usr/bin/env node
/**
 * 生成签发用的 Ed25519 密钥对（离线工具，私有环境执行一次即可）。
 *
 * 用途与纪律：
 * - **私钥永远不要进仓库、不要上传、不要放进面板部署目录**；它只存在于你签发的机器上。
 * - 公钥要随构建注入（授权用 `BSP_LICENSE_PUBLIC_KEY`，插件用 `BSP_PLUGIN_PUBLIC_KEY`）；公钥不是秘密。
 * - 换密钥意味着所有已签发的许可或插件立即失效，所以私钥要备份（离线介质），并在一开始就定好。
 * - **建议授权与插件各生成一把**（`--purpose license` / `--purpose plugin`）：
 *   两者按不同节奏签发，混用一把私钥会让插件签名流程的失误波及所有客户授权。
 *
 * 用法：
 *   pnpm exec tsx scripts/license/generate-keypair.ts [--out <目录>] [--purpose license|plugin] [--force]
 */
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_OUT_DIR = path.join(os.homedir(), '.bsp-license-keys')

function parseArgs(argv: string[]): { outDir: string, purpose: 'license' | 'plugin', force: boolean } {
  let outDir = DEFAULT_OUT_DIR
  let purpose: 'license' | 'plugin' = 'license'
  let force = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') {
      outDir = path.resolve(argv[index + 1] ?? '')
      index += 1
      continue
    }
    if (arg === '--purpose') {
      const value = argv[index + 1]
      if (value !== 'license' && value !== 'plugin') {
        console.error('[keygen] --purpose 只能是 license 或 plugin')
        process.exit(1)
      }
      purpose = value
      index += 1
      continue
    }
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      console.log('用法：pnpm exec tsx scripts/license/generate-keypair.ts [--out <目录>] [--purpose license|plugin] [--force]')
      process.exit(0)
    }
    console.error(`[keygen] 无法识别的参数：${arg}`)
    process.exit(1)
  }
  if (!outDir) {
    console.error('[keygen] --out 需要指定目录')
    process.exit(1)
  }
  return { outDir, purpose, force }
}

const { outDir, purpose, force } = parseArgs(process.argv.slice(2))
const baseName = purpose === 'plugin' ? 'plugin-private' : 'license-private'
const privateKeyPath = path.join(outDir, `${baseName}.bsp-key`)
const publicKeyPath = path.join(outDir, `${baseName}.bsp-key.public.pem`)
const envName = purpose === 'plugin' ? 'BSP_PLUGIN_PUBLIC_KEY' : 'BSP_LICENSE_PUBLIC_KEY'

if (!force && (fs.existsSync(privateKeyPath) || fs.existsSync(publicKeyPath))) {
  console.error(`[keygen] 目标位置已有密钥：${outDir}`)
  console.error('[keygen] 覆盖会让已签发的许可 / 插件全部失效；确需重新生成请加 --force')
  process.exit(1)
}

fs.mkdirSync(outDir, { recursive: true })

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

fs.writeFileSync(privateKeyPath, privatePem, { encoding: 'utf8', mode: 0o600 })
fs.writeFileSync(publicKeyPath, publicPem, { encoding: 'utf8', mode: 0o644 })

/** 单行 base64：panel.env 里写多行 PEM 很别扭，核心两种写法都支持 */
const publicBase64 = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')

console.log(`[keygen] 已生成${purpose === 'plugin' ? '插件签名' : '授权许可'}用的密钥对`)
console.log(`  私钥：${privateKeyPath}（权限 0600，不要提交、不要上传）`)
console.log(`  公钥：${publicKeyPath}`)
console.log('')
console.log('[keygen] 把下面这一行放进构建环境与客户部署的 panel.env：')
console.log('')
console.log(`${envName}=${publicBase64}`)
console.log('')
if (purpose === 'plugin') {
  console.log('[keygen] 下一步：pnpm exec tsx scripts/plugins/sign-plugin.ts --dir <插件目录> --key ' + privateKeyPath)
}
else {
  console.log('[keygen] 下一步：用 sign-license.ts 签发许可；客户机器指纹用 print-fingerprint.ts 获取。')
}

