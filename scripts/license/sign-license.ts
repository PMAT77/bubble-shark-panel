#!/usr/bin/env node
/**
 * 签发 Pro 授权许可（离线工具，私有环境执行）。
 *
 * 产出 `license.json`：客户把它放到面板数据目录（默认 `<数据目录>/license.json`），
 * 或用 `BSP_LICENSE_FILE` 指定路径。核心用内置公钥离线验签，**不需要联网**。
 *
 * 用法：
 *   pnpm exec tsx scripts/license/sign-license.ts \
 *     --key ~/.bsp-license-keys/license-private.bsp-key \
 *     --customer "某某社区" \
 *     --capabilities multi-node,audit-log,remote-backup \
 *     --days 365 \
 *     [--fingerprint bsp-xxxxxxxx] [--note "订单 2026-001"] [--out license.json]
 *
 * 约定：
 * - `--days` 与 `--expires` 二选一，都不给则签发**永久**授权（面板会如实显示「永久」）；
 * - `--fingerprint` 不给则不绑定机器（客户可自由换机、迁移）；给了就只有该机器生效，
 *   指纹必须由客户在目标机器上跑 `print-fingerprint.ts` 得到，不要凭描述手写。
 */
import { createPrivateKey, sign as signPayload } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  canonicalizeLicensePayload,
  licenseCapabilitySchema,
  licenseFileSchema,
  licensePayloadSchema,
} from '../../shared/contracts/license.ts'

const CAPABILITY_HINT = licenseCapabilitySchema.options.join('、')

function fail(message: string): never {
  console.error(`[sign] ${message}`)
  process.exit(1)
}

interface Args {
  keyPath: string
  customer: string
  capabilities: string[]
  days?: number
  expires?: string
  fingerprint?: string
  note?: string
  outPath: string
  force: boolean
}

function parseArgs(argv: string[]): Args {
  const values: Record<string, string> = {}
  let force = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      console.log('用法：pnpm exec tsx scripts/license/sign-license.ts --key <私钥> --customer <客户> --capabilities <能力清单> [--days N | --expires ISO] [--fingerprint bsp-xxx] [--note 备注] [--out license.json] [--force]')
      console.log(`能力可选：${CAPABILITY_HINT}`)
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

  if (!values.key || !values.customer || !values.capabilities) {
    fail('必须提供 --key、--customer 与 --capabilities（--help 查看用法）')
  }
  if (values.days && values.expires) {
    fail('--days 与 --expires 只能给一个')
  }
  const days = values.days === undefined ? undefined : Number.parseInt(values.days, 10)
  if (values.days !== undefined && (!Number.isInteger(days) || (days as number) <= 0)) {
    fail('--days 需要是正整数')
  }

  return {
    keyPath: path.resolve(values.key),
    customer: values.customer,
    capabilities: values.capabilities.split(',').map(item => item.trim()).filter(Boolean),
    days,
    expires: values.expires,
    fingerprint: values.fingerprint,
    note: values.note,
    outPath: path.resolve(values.out ?? 'license.json'),
    force,
  }
}

const args = parseArgs(process.argv.slice(2))

if (!fs.existsSync(args.keyPath)) {
  fail(`私钥不存在：${args.keyPath}。先在离线环境运行 generate-keypair.ts。`)
}

const issuedAt = new Date()
const expiresAt = args.expires
  ? new Date(args.expires)
  : args.days
    ? new Date(issuedAt.getTime() + args.days * 24 * 60 * 60 * 1000)
    : null

if (expiresAt && Number.isNaN(expiresAt.getTime())) {
  fail(`到期时间无法解析：${args.expires ?? ''}`)
}
if (expiresAt && expiresAt.getTime() <= issuedAt.getTime()) {
  fail('到期时间必须晚于当前时间')
}

const payload = licensePayloadSchema.parse({
  version: 1,
  customer: args.customer,
  capabilities: args.capabilities,
  issuedAt: issuedAt.toISOString(),
  expiresAt: expiresAt ? expiresAt.toISOString() : null,
  fingerprint: args.fingerprint ?? null,
  ...(args.note ? { note: args.note } : {}),
})

let privateKey
try {
  privateKey = createPrivateKey(fs.readFileSync(args.keyPath, 'utf8'))
}
catch (error) {
  fail(`私钥无法解析：${error instanceof Error ? error.message : String(error)}`)
}

const signedBytes = Buffer.from(canonicalizeLicensePayload(payload), 'utf8')
const signature = signPayload(null, signedBytes, privateKey).toString('base64')
const file = licenseFileSchema.parse({ payload, signature })

if (!args.force && fs.existsSync(args.outPath)) {
  fail(`输出文件已存在：${args.outPath}（加 --force 覆盖）`)
}
fs.mkdirSync(path.dirname(args.outPath), { recursive: true })
fs.writeFileSync(args.outPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')

console.log('[sign] 许可已签发')
console.log(`  客户：${payload.customer}`)
console.log(`  能力：${payload.capabilities.join('、')}`)
console.log(`  到期：${payload.expiresAt ?? '永久'}`)
console.log(`  设备绑定：${payload.fingerprint ?? '不绑定（可换机器）'}`)
console.log(`  文件：${args.outPath}`)
if (args.note) {
  console.log(`  备注：${args.note}`)
}
console.log('')
console.log('[sign] 交给客户：把该文件放到面板数据目录下的 license.json（或用 BSP_LICENSE_FILE 指定路径）。')
console.log('[sign] 提醒：许可不影响 Community 核心能力；到期或无效时正在运行的游戏实例不会被停止。')
