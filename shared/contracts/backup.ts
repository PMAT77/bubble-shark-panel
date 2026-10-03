import { z } from 'zod'

/** 备份来源：手动 / 计划任务（预留）/ 更新前 / 删除前 / 恢复前 / 导入前 / 回档前 / 重置世界前 / 数据库快照 */
export const backupKindSchema = z.enum([
  'manual',
  'scheduled',
  'pre_update',
  'pre_delete',
  'pre_restore',
  'pre_import',
  'pre_rollback',
  'pre_reset',
  'database',
])
export type BackupKind = z.infer<typeof backupKindSchema>

/** 备份状态：completed=文件完整；failed=创建失败残留记录；stale=文件已丢失 */
export const backupStatusSchema = z.enum(['completed', 'failed', 'stale'])
export type BackupStatus = z.infer<typeof backupStatusSchema>

export const backupItemSchema = z.object({
  id: z.string().trim().min(1).max(128),
  instanceId: z.string().trim().min(1).max(128),
  kind: backupKindSchema,
  status: backupStatusSchema,
  /** 备份包文件名（不含路径），存档备份为 .tar.gz，数据库快照为 .sqlite */
  fileName: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  note: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
})
export type BackupItem = z.infer<typeof backupItemSchema>

export const backupCreateRequestSchema = z.object({
  instanceId: z.string().trim().min(1).max(128),
  note: z.string().max(200).optional(),
})
export type BackupCreateRequest = z.infer<typeof backupCreateRequestSchema>

export const backupListRequestSchema = z.object({
  /** 缺省返回全部（含数据库快照）；指定实例时仅返回该实例的存档备份 */
  instanceId: z.string().trim().min(1).max(128).optional(),
})
export type BackupListRequest = z.infer<typeof backupListRequestSchema>

export const backupIdRequestSchema = z.object({
  backupId: z.string().trim().min(1).max(128),
})
export type BackupIdRequest = z.infer<typeof backupIdRequestSchema>

export const backupRestoreRequestSchema = z.object({
  backupId: z.string().trim().min(1).max(128),
  /** 恢复完成后是否自动启动实例（默认否） */
  startAfterRestore: z.boolean().optional(),
})
export type BackupRestoreRequest = z.infer<typeof backupRestoreRequestSchema>

export const backupMutationResultSchema = z.object({
  isSuccess: z.boolean(),
  backupId: z.string().optional(),
})
export type BackupMutationResult = z.infer<typeof backupMutationResultSchema>

export const backupRestoreResultSchema = z.object({
  isSuccess: z.boolean(),
  /** 恢复过程中自动创建的安全备份 id（恢复失败时可用它回退） */
  safetyBackupId: z.string().optional(),
})
export type BackupRestoreResult = z.infer<typeof backupRestoreResultSchema>

// ---------------------------------------------------------------------------
// 存档导入（外部 Klei 集群目录 → 面板实例）
// ---------------------------------------------------------------------------

const importPathSchema = z.string().trim().min(1).max(1024)

export const importShardIdSchema = z.enum(['master', 'caves'])
export type ImportShardId = z.infer<typeof importShardIdSchema>

/** 一个可导入的集群存档候选（上传识别结果项） */
export const saveImportCandidateSchema = z.object({
  /** 集群目录名（如 Cluster_2） */
  dirName: z.string().min(1).max(256),
  /** 集群目录绝对路径（位于服务端上传解压临时目录内，导入请求回传该值） */
  clusterPath: importPathSchema,
  /** cluster.ini 中的房间名（解析失败为 null） */
  clusterName: z.string().nullable(),
  shards: z.array(importShardIdSchema),
  /** 任一 shard 的 save 目录非空即视为世界已生成 */
  worldGenerated: z.boolean(),
  /** modoverrides.lua 中识别出的 Mod 数量（无文件或解析失败为 0） */
  modCount: z.number().int().nonnegative(),
  /** 源目录是否自带 cluster_token.txt */
  hasTokenFile: z.boolean(),
  /** 目录大小（字节）；超出扫描上限时为已统计部分 */
  sizeBytes: z.number().int().nonnegative(),
  /** 目录条目超出扫描上限，sizeBytes 仅为部分统计 */
  sizeIncomplete: z.boolean(),
  warnings: z.array(z.string()),
  migration: z.object({ includeMods: z.boolean(), includedModCount: z.number(), missingModIds: z.array(z.string()) }).optional(),
})
export type SaveImportCandidate = z.infer<typeof saveImportCandidateSchema>

export const saveImportProbeResultSchema = z.object({
  /** 本次上传的记录 id（导入请求需回传；上传记录过期后需重新上传） */
  uploadId: z.string().trim().min(1).max(64),
  /** 上传的存档包原始文件名（仅展示与安全备份备注） */
  sourceName: z.string().trim().min(1).max(256),
  /** 服务端解压根目录（仅供展示） */
  sourcePath: importPathSchema,
  candidates: z.array(saveImportCandidateSchema).max(10),
  warnings: z.array(z.string()),
})
export type SaveImportProbeResult = z.infer<typeof saveImportProbeResultSchema>

/** 执行导入请求：将上传解压后的源集群存档替换挂载到目标实例 */
export const saveImportRequestSchema = z.object({
  instanceId: z.string().trim().min(1).max(128),
  /** 上传存档包时返回的记录 id */
  uploadId: z.string().trim().min(1).max(64),
  /** 上传解压后识别出的集群目录绝对路径（必须位于该 uploadId 的解压根内） */
  sourceClusterPath: importPathSchema,
  /** 可选：导入时写入的 Klei 集群令牌（优先级高于实例已有令牌与源档令牌文件） */
  clusterToken: z.string().trim().max(512).optional(),
})
export type SaveImportRequest = z.infer<typeof saveImportRequestSchema>

export const saveImportTokenSourceSchema = z.enum(['provided', 'existing', 'source', 'none'])
export type SaveImportTokenSource = z.infer<typeof saveImportTokenSourceSchema>

export const saveImportResultSchema = z.object({
  isSuccess: z.boolean(),
  /** 实际导入的 shard 目录（如 ['master','caves']） */
  importedShards: z.array(importShardIdSchema),
  /** 反向写入面板 Mod 列表的条目数 */
  modCount: z.number().int().nonnegative(),
  /** 实例安装目录中未找到 workshop 内容的 Mod（用户在下载队列显式补齐） */
  missingWorkshopContent: z.array(z.string()),
  tokenSource: saveImportTokenSourceSchema,
  /** 导入前自动创建的安全备份 id（实例原本无存档时缺省） */
  safetyBackupId: z.string().optional(),
  /** 目标 master 端口与实例 DB 记录不一致时已同步 DB */
  gamePortSynced: z.boolean().optional(),
  warnings: z.array(z.string()),
})
export type SaveImportResult = z.infer<typeof saveImportResultSchema>

// ---------------------------------------------------------------------------
// 迁移包导出（把本面板实例的存档整理成可交给另一台机器导入的包）
// ---------------------------------------------------------------------------

export const migrationExportRequestSchema = z.object({
  instanceId: z.string().trim().min(1).max(128),
  /** true 时只返回体检报告与文件名，不打包（界面先展示风险项，用户确认后再下载） */
  reportOnly: z.boolean().optional(),
  includeMods: z.boolean().default(false),
})
export type MigrationExportRequest = z.infer<typeof migrationExportRequestSchema>

export const migrationExportResultSchema = z.object({
  /** 迁移包文件名（不含路径），与下载接口返回的一致 */
  fileName: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /** 迁移报告全文，与包内报告同源；界面直接展示，也可复制给人 */
  reportText: z.string(),
  /** 迁移前必须确认的风险项（报告第四节同源，便于界面单独强调） */
  warnings: z.array(z.string()),
  /** 本次是否真的产出了压缩包（reportOnly 时为 false） */
  packaged: z.boolean(),
  modContent: z.object({ includedModCount: z.number(), estimatedContentBytes: z.number(), missingRequiredMods: z.array(z.string()), missingOptionalMods: z.array(z.string()), canExport: z.boolean() }).optional(),
})
export type MigrationExportResult = z.infer<typeof migrationExportResultSchema>

// ---------------------------------------------------------------------------
// 面板数据库快照恢复（用某份快照替换面板自身的数据库）
// ---------------------------------------------------------------------------

/**
 * 恢复面板数据必须手工输入的确认短语。
 * 前后端共用一份：这类「输入点什么才能点确认」的交互，两边各写一遍文案迟早对不上，
 * 表现是用户照着界面提示输入却被服务端拒绝。
 */
export const DB_SNAPSHOT_RESTORE_CONFIRM_TEXT = '恢复面板数据'

export const dbSnapshotRestoreRequestSchema = z.object({
  backupId: z.string().trim().min(1).max(128),
  /** 必须等于 DB_SNAPSHOT_RESTORE_CONFIRM_TEXT */
  confirmText: z.string().trim().max(64),
})
export type DbSnapshotRestoreRequest = z.infer<typeof dbSnapshotRestoreRequestSchema>

