import fs from 'node:fs'
import path from 'node:path'
import type { ShardId } from '../../../../../shared/contracts/shard'
import { worldSeedPattern } from '../../../../../shared/contracts/shard'
import { DST_CLUSTER_NAME, DST_CONF_DIR, DST_STORAGE_DIR } from './constants'
import { writeFileAtomic } from './atomic-write'

export interface ObservedWorldSeed {
  /** 游戏记录的真实种子（游戏内的 TheWorld.meta.seed，与存档一致） */
  seed: string
  /** 读到该种子的时间（ISO） */
  at: string
  /** 世界会话标识：世界每重新生成一次就变一次，用于判断这条记录是否还代表当前世界 */
  sessionId: string | null
  /** 世界已重新生成、但还没读到新会话：这条记录暂时不可信，界面按"尚未读到"处理 */
  stale?: boolean
}

export interface PanelConfigMeta {
  roomSavedAt?: string
  masterWorldSavedAt?: string
  /** 世界种子：按分片记录；缺省或空串表示留空（由游戏自己随机） */
  worldSeeds?: Partial<Record<ShardId, string>>
  /**
   * 从运行中的世界读到的真实种子，按分片保存。
   * 读取必须发生在实例运行期间，所以记录下来后即使实例停服也还能显示。
   */
  observedWorldSeeds?: Partial<Record<ShardId, ObservedWorldSeed>>
}

function resolveMetaPath(installPath: string): string {
  const clusterRoot = path.join(installPath, DST_STORAGE_DIR, DST_CONF_DIR, DST_CLUSTER_NAME)
  return path.join(clusterRoot, '.bsp-panel-config.json')
}

export function readPanelConfigMeta(installPath: string): PanelConfigMeta {
  const metaPath = resolveMetaPath(installPath)
  if (!fs.existsSync(metaPath)) {
    return {}
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as PanelConfigMeta
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  }
  catch {
    return {}
  }
}

function writePanelConfigMeta(installPath: string, patch: Partial<PanelConfigMeta>): void {
  const metaPath = resolveMetaPath(installPath)
  const next: PanelConfigMeta = {
    ...readPanelConfigMeta(installPath),
    ...patch,
  }
  fs.mkdirSync(path.dirname(metaPath), { recursive: true })
  writeFileAtomic(metaPath, `${JSON.stringify(next, null, 2)}\n`)
}

export function markPanelRoomSaved(installPath: string): void {
  writePanelConfigMeta(installPath, { roomSavedAt: new Date().toISOString() })
}

export function markPanelMasterWorldSaved(installPath: string): void {
  writePanelConfigMeta(installPath, { masterWorldSavedAt: new Date().toISOString() })
}

export function isPanelRoomSaved(meta: PanelConfigMeta): boolean {
  return Boolean(meta.roomSavedAt)
}

export function isPanelMasterWorldSaved(meta: PanelConfigMeta): boolean {
  return Boolean(meta.masterWorldSavedAt)
}

/**
 * 读回面板记录的世界种子（按分片）。
 *
 * 元数据文件可能被手工改过，因此逐项校验形状：非字符串或不符合种子格式的值一律忽略，
 * 界面与落位逻辑都按"留空"处理，不会把脏值写进游戏文件。
 */
export function readWorldSeeds(installPath: string): Partial<Record<ShardId, string>> {
  const raw = readPanelConfigMeta(installPath).worldSeeds
  if (!raw || typeof raw !== 'object') {
    return {}
  }
  const seeds: Partial<Record<ShardId, string>> = {}
  for (const shardId of ['master', 'caves'] as const) {
    const value = (raw as Record<string, unknown>)[shardId]
    if (typeof value === 'string' && worldSeedPattern.test(value)) {
      seeds[shardId] = value
    }
  }
  return seeds
}

/** 写入或清除某个分片的世界种子（`null` = 清除）；其余分片与字段保持不变 */
export function writeWorldSeed(installPath: string, shardId: ShardId, seed: string | null): void {
  const next: Partial<Record<ShardId, string>> = { ...readWorldSeeds(installPath) }
  if (seed === null) {
    delete next[shardId]
  }
  else {
    next[shardId] = seed
  }
  writePanelConfigMeta(installPath, { worldSeeds: next })
}

/**
 * 读回已记录的真实世界种子（按分片）。元数据可能被手工改过，逐项校验形状，
 * 不合规的条目一律忽略——界面按"没读到"处理，不会显示脏值。
 */
export function readObservedWorldSeeds(installPath: string): Partial<Record<ShardId, ObservedWorldSeed>> {
  const raw = readPanelConfigMeta(installPath).observedWorldSeeds
  if (!raw || typeof raw !== 'object') {
    return {}
  }
  const seeds: Partial<Record<ShardId, ObservedWorldSeed>> = {}
  for (const shardId of ['master', 'caves'] as const) {
    const entry = (raw as Record<string, unknown>)[shardId]
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const { seed, at, sessionId, stale } = entry as Record<string, unknown>
    if (typeof seed !== 'string' || !worldSeedPattern.test(seed) || typeof at !== 'string') {
      continue
    }
    seeds[shardId] = {
      seed,
      at,
      sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
      ...(stale === true ? { stale: true } : {}),
    }
  }
  return seeds
}

export function readObservedWorldSeed(installPath: string, shardId: ShardId): ObservedWorldSeed | null {
  return readObservedWorldSeeds(installPath)[shardId] ?? null
}

/** 记录某个分片当前世界的真实种子（读取时间由调用方给出）；写入即视为记录重新可信 */
export function writeObservedWorldSeed(
  installPath: string,
  shardId: ShardId,
  observed: { seed: string, at: string, sessionId: string | null },
): void {
  writePanelConfigMeta(installPath, {
    observedWorldSeeds: { ...readObservedWorldSeeds(installPath), [shardId]: { ...observed } },
  })
}

/**
 * 标记记录已过时（世界被重新生成）。
 *
 * 此刻游戏里的世界可能还在重建，马上重读有可能又读到旧世界的种子，所以这里只作废记录：
 * 界面暂时显示"尚未读到"，等读到属于新世界的会话（sessionId 变了）再写回。
 */
export function markObservedWorldSeedStale(installPath: string, shardId: ShardId): void {
  const existing = readObservedWorldSeed(installPath, shardId)
  if (!existing) {
    return
  }
  writePanelConfigMeta(installPath, {
    observedWorldSeeds: {
      ...readObservedWorldSeeds(installPath),
      [shardId]: { ...existing, stale: true },
    },
  })
}
