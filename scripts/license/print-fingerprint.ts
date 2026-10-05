#!/usr/bin/env node
import { readBrandEnv } from '../../shared/brand-env'
/**
 * 打印当前机器的指纹（给客户在**目标机器**上执行，用于签发绑定设备的许可）。
 *
 * 用法：
 *   pnpm exec tsx scripts/license/print-fingerprint.ts
 *
 * 为什么必须让客户跑这个脚本，而不是让客户报「机器名 + 系统」：
 * 指纹由主机名与系统标识共同算出，人工转述必然出现大小写、空格或版本差异，
 * 而指纹不一致的表现是「许可无效」——客户看不出原因，你也要来回排查几轮。
 *
 * 与面板运行时用的是**同一个函数**（`server/src/shared/license/fingerprint.ts`），
 * 因此脚本输出与面板内部判定不会出现分歧。
 */
import process from 'node:process'
import { resolveMachineFingerprint } from '../../server/src/shared/license/fingerprint.ts'

const dataDir = readBrandEnv('BSP_DATA_DIR')?.trim()
const fingerprint = resolveMachineFingerprint(dataDir ? { dataDir } : {})

if (!fingerprint) {
  console.error('[fingerprint] 无法计算指纹：既读不到 /etc/machine-id，也没有可写的标识目录。')
  console.error('[fingerprint] 请在目标机器上设置 BSP_LICENSE_FINGERPRINT=<自定义稳定标识>，或用 BSP_DATA_DIR 指定可写的面板数据目录。')
  process.exit(1)
}

console.log(fingerprint)
console.error('[fingerprint] 把上面这一行原样交给签发方（它区分大小写）。')
