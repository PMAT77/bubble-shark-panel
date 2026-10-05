import { readBrandEnv } from '../../../../shared/brand-env'
import type { LicenseState } from '../../../../shared/contracts/license'
import fs from 'node:fs'
import path from 'node:path'
import { loadServerConfig } from '../config'
import { communityLicenseState, inspectLicenseFile } from './verify'

/**
 * 许可状态的读取入口（带缓存）。
 *
 * 文件位置：`BSP_LICENSE_FILE` 指定；未指定时用**面板数据目录**下的 `license.json`——
 * 放在数据目录里是有意的：它与数据库、备份一起被复制或迁移，客户换机器时不会丢；
 * 而放进发布目录则会被升级覆盖。
 *
 * 缓存 30 秒：状态查询会被界面与将来的插件宿主反复调用，而许可文件几乎不变。
 * 缓存的是「文件内容 + 判定结果」，不是公钥（公钥另有缓存）。
 */

const LICENSE_CACHE_MS = 30_000

interface LicenseCacheEntry {
  filePath: string
  mtimeMs: number
  state: LicenseState
  checkedAt: number
}

let cache: LicenseCacheEntry | null = null

export function resolveLicenseFilePath(): string {
  const configured = readBrandEnv('BSP_LICENSE_FILE')?.trim()
  if (configured) {
    return path.resolve(configured)
  }
  // 面板数据目录由 dbPath 推导（数据库、备份、实例都在这一层）
  return path.join(path.dirname(loadServerConfig().dbPath), 'license.json')
}

export function clearLicenseCache(): void {
  cache = null
}

/**
 * 读取当前许可状态。
 *
 * 任何异常（文件不存在、无权限读、JSON 损坏）都只影响授权状态本身，
 * **不会抛出**：调用方可能是面板启动路径或实例操作路径，许可问题不该把它们带崩。
 */
export function readLicenseState(options: { now?: Date } = {}): LicenseState {
  const filePath = resolveLicenseFilePath()

  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  }
  catch {
    cache = null
    return communityLicenseState()
  }

  const now = Date.now()
  if (
    cache
    && cache.filePath === filePath
    && cache.mtimeMs === stat.mtimeMs
    && now - cache.checkedAt < LICENSE_CACHE_MS
  ) {
    return cache.state
  }

  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  }
  catch {
    const state: LicenseState = {
      ...communityLicenseState(),
      status: 'invalid',
      message: `许可文件无法解析：${filePath}。Community 核心功能与正在运行的实例都不受影响。`,
    }
    cache = { filePath, mtimeMs: stat.mtimeMs, state, checkedAt: now }
    return state
  }

  const inspection = inspectLicenseFile(raw, { now: options.now, dataDir: path.dirname(filePath) })
  cache = { filePath, mtimeMs: stat.mtimeMs, state: inspection.state, checkedAt: now }
  return inspection.state
}

/** 当前是否具备某个 Pro 能力：只有 status 为 active 且能力命中才为 true */
export function hasLicenseCapability(capability: string): boolean {
  const state = readLicenseState()
  return state.status === 'active' && state.capabilities.includes(capability as never)
}
