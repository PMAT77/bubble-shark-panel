import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const gameInstances = sqliteTable('game_instances', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull(),
  name: text('name').notNull(),
  gameCode: text('game_code').notNull(),
  status: text('status').notNull().default('stopped'),
  containerId: text('container_id'),
  runtimePid: integer('runtime_pid'),
  runtimeStartedAt: text('runtime_started_at'),
  installPath: text('install_path'),
  configPath: text('config_path'),
  queryPort: integer('query_port'),
  gamePort: integer('game_port'),
  rconPort: integer('rcon_port'),
  lastCommand: text('last_command'),
  lastExitCode: integer('last_exit_code'),
  lastError: text('last_error'),
  /**
   * 运行期警告（重启循环、退出原因、分片残留）。
   *
   * 与 lastError 分开存：lastError 会被「启动失败」「停止实例」「状态对账」反复覆盖，
   * 曾经把「主世界已停止但洞穴仍在运行」这类提示在写入一秒后就擦掉，服主永远看不到。
   * 本字段只在实例干净运行足够久或用户显式清除时才清空。
   */
  runtimeWarning: text('runtime_warning'),
  /** 最近一次异常退出检测时间（ISO）；成功启动后清除 */
  unexpectedExitAt: text('unexpected_exit_at'),
  installLogStatus: text('install_log_status'),
  installPercent: integer('install_percent'),
  installLogUpdatedAt: text('install_log_updated_at'),
  updateAvailable: integer('update_available').notNull().default(0),
  localBuildId: text('local_build_id'),
  remoteBuildId: text('remote_build_id'),
  updateCheckedAt: text('update_checked_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const instanceMods = sqliteTable('instance_mods', {
  id: text('id').primaryKey(),
  instanceId: text('instance_id').notNull(),
  workshopId: text('workshop_id').notNull(),
  name: text('name').notNull(),
  enabled: integer('enabled').notNull().default(0),
  loadOrder: integer('load_order').notNull().default(0),
  version: text('version'),
  previewImage: text('preview_image'),
  installStatus: text('install_status').notNull().default('ready'),
  installError: text('install_error'),
  /** 本机已下载内容对应的工坊版本时间（ISO）；未知为 null */
  localUpdatedAt: text('local_updated_at'),
  /** 工坊上的最新版本时间（ISO）；未知为 null */
  remoteUpdatedAt: text('remote_updated_at'),
  /** 最近一次版本检查时间（ISO）；从未检查为 null */
  updateCheckedAt: text('update_checked_at'),
  /**
   * 游戏实际加载的副本（ugc_mods）比已下载内容旧：DST 只读 ugc_mods，
   * 落位被跳过时「下载目录已最新、游戏里还是旧内容」会同时成立，需要重新下载/重新落位。
   */
  loadedCopyStale: integer('loaded_copy_stale').notNull().default(0),
  config: text('config'),
  /**
   * 连续下载失败次数，供队列做指数退避（10s / 30s / 60s，最多 3 次）；成功即清零。
   * 落在库里而不是内存里：面板重启后队列从 pending 恢复，退避进度同样不能丢。
   */
  retryCount: integer('retry_count').notNull().default(0),
  /** 退避等待的下次可尝试时间（ISO）；null = 立即可尝试 */
  nextRetryAt: text('next_retry_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const backups = sqliteTable('backups', {
  id: text('id').primaryKey(),
  instanceId: text('instance_id').notNull(),
  filePath: text('file_path').notNull(),
  sizeBytes: integer('size_bytes').notNull().default(0),
  note: text('note').notNull().default(''),
  /** 备份来源：manual/scheduled/pre_update/pre_delete/pre_restore/pre_import/pre_rollback/pre_reset/database */
  kind: text('kind').notNull().default('manual'),
  /** completed=文件完整；failed=创建失败残留；stale=文件已丢失 */
  status: text('status').notNull().default('completed'),
  /** 打包时的分片结构快照（JSON 数组，如 ["master","caves"]），数据库快照为 null */
  shards: text('shards'),
  createdBy: text('created_by').notNull().default(''),
  createdAt: text('created_at').notNull(),
})

export const instanceMaintenanceDrafts = sqliteTable('instance_maintenance_drafts', {
  instanceId: text('instance_id').primaryKey(),
  message: text('message').notNull().default(''),
  updatedAt: text('updated_at').notNull(),
})

export const instanceMaintenancePushLogs = sqliteTable('instance_maintenance_push_logs', {
  id: text('id').primaryKey(),
  instanceId: text('instance_id').notNull(),
  message: text('message').notNull(),
  operatorAccount: text('operator_account').notNull(),
  status: text('status').notNull(),
  errorMessage: text('error_message'),
  pushedAt: text('pushed_at').notNull(),
})
