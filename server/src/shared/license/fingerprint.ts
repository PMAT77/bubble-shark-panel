import { readBrandEnv } from '../../../../shared/brand-env'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 机器指纹：用来把一份授权绑定到一台机器（可选功能）。
 *
 * 两个纪律：
 * 1. **签发方与运行方必须用同一个算法**。所以客户要在目标机器上跑
 *    `tsx scripts/license/print-fingerprint.ts` 取指纹，而不是让客户报机器名——
 *    人工转述必然出错，而指纹不一致的表现是「许可无效」这种看不出原因的失败。
 * 2. **容器里也要稳定**：容器通常没有 `/etc/machine-id`，此时退回主机名 + 数据目录标识，
 *    只要数据目录是持久化的卷，重建容器后指纹不变。
 */

/** 指纹前缀便于人工识别，避免把指纹和别的十六进制串搞混 */
const FINGERPRINT_PREFIX = 'gsh'

function readFirstLine(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8').split('\n')[0]?.trim()
    return content && content.length > 0 ? content : null
  }
  catch {
    return null
  }
}

/**
 * 数据目录里的稳定标识：首次调用时创建，之后一直复用。
 * 用于容器等拿不到 `/etc/machine-id` 的环境；写不进去（只读挂载）时返回 null。
 */
function resolveDataDirIdentity(dataDir: string): string | null {
  const markerPath = path.join(dataDir, '.machine-fingerprint')
  const existing = readFirstLine(markerPath)
  if (existing) {
    return existing
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    const generated = `${os.hostname()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    fs.writeFileSync(markerPath, `${generated}\n`, { encoding: 'utf8', mode: 0o600 })
    return generated
  }
  catch {
    return null
  }
}

export interface FingerprintSourceOptions {
  /** 面板数据目录（用于容器环境的兜底标识）；缺省不尝试写标识文件 */
  dataDir?: string
}

/**
 * 计算当前机器的指纹。
 *
 * 优先级：显式配置（`BSP_LICENSE_FINGERPRINT`，用于客户自己管理的绑定标识）→
 * `/etc/machine-id`（Linux 标准，重装系统才会变）→ 数据目录标识文件。
 * 三者都拿不到时返回 null：此时指纹绑定类授权一律判为不匹配，而不是"随便放过"。
 */
export function resolveMachineFingerprint(options: FingerprintSourceOptions = {}): string | null {
  const explicit = readBrandEnv('BSP_LICENSE_FINGERPRINT')?.trim()
  if (explicit) {
    return explicit
  }
  const machineId = readFirstLine('/etc/machine-id') ?? readFirstLine('/var/lib/dbus/machine-id')
  const identity = machineId ?? (options.dataDir ? resolveDataDirIdentity(options.dataDir) : null)
  if (!identity) {
    return null
  }
  const digest = createHash('sha256').update(`${os.hostname()}|${identity}`).digest('hex').slice(0, 24)
  return `${FINGERPRINT_PREFIX}-${digest}`
}
