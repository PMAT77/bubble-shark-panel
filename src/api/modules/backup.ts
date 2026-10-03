import type {
  BackupItem,
  BackupMutationResult,
  BackupRestoreResult,
  MigrationExportResult,
  SaveImportCandidate,
  SaveImportProbeResult,
  SaveImportRequest,
  SaveImportResult,
  SaveImportTokenSource,
} from '../../../shared/contracts/backup'
import { DB_SNAPSHOT_RESTORE_CONFIRM_TEXT } from '../../../shared/contracts/backup'
import api from '../index'

export type {
  BackupItem,
  BackupMutationResult,
  BackupRestoreResult,
  MigrationExportResult,
  SaveImportCandidate,
  SaveImportProbeResult,
  SaveImportRequest,
  SaveImportResult,
  SaveImportTokenSource,
}

export { DB_SNAPSHOT_RESTORE_CONFIRM_TEXT }

export interface BackupDownloadOptions {
  backupId: string
}

/**
 * 创建、恢复、导入、快照与下载都要等后端把存档打包 / 解压 / 传输完才返回，大存档会超过全局
 * 60 秒请求超时——前端弹出「请求失败」，后端其实已经成功。这几处与存档上传接口一致，关掉超时；
 * 列表与删除很快，仍沿用全局超时。
 */
export default {
  /** 创建实例存档备份（运行中实例会先发送 c_save() 热保存） */
  createBackup: (instanceId: string, note?: string) => api.post('app/instance/backup/create', {
    instanceId,
    ...(note?.trim() ? { note: note.trim() } : {}),
  }, { timeout: 0 }) as Promise<{ data: BackupMutationResult }>,
  /** 备份列表；instanceId 缺省返回全部（含数据库快照） */
  getBackupList: (instanceId?: string) => api.post('app/instance/backup/list', instanceId ? { instanceId } : {}) as Promise<{ data: BackupItem[] }>,
  /**
   * 流式下载备份包。
   *
   * `onProgress` 只回传已接收字节数：响应是 chunked 的（后端不设 Content-Length），
   * 浏览器量不出总量，进度分母由调用方用列表里的备份大小给出。
   */
  downloadBackup: ({ backupId }: BackupDownloadOptions, onProgress?: (loadedBytes: number) => void) => api.post('app/instance/backup/download', { backupId }, {
    responseType: 'blob',
    timeout: 0,
    onDownloadProgress: (event: { loaded: number }) => {
      onProgress?.(event.loaded)
    },
  }) as Promise<{ data: Blob }>,
  deleteBackup: (backupId: string) => api.post('app/instance/backup/delete', { backupId }) as Promise<{ data: BackupMutationResult }>,
  /** 恢复实例存档（要求实例已停止；自动生成恢复前安全备份） */
  restoreBackup: (backupId: string) => api.post('app/instance/backup/restore', { backupId }, { timeout: 0 }) as Promise<{ data: BackupRestoreResult }>,
  /** 上传本地存档压缩包（zip/tar.gz）到服务端解压并识别集群候选；onProgress 回传 0-100 上传百分比 */
  uploadSaveImportArchive: (file: File, onProgress?: (percent: number) => void) => api.post(`app/instance/backup/import/upload?fileName=${encodeURIComponent(file.name)}`, file, {
    headers: { 'Content-Type': 'application/octet-stream' },
    timeout: 0,
    onUploadProgress: (event: { loaded: number, total?: number }) => {
      if (onProgress && event.total) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)))
      }
    },
  }) as Promise<{ data: SaveImportProbeResult }>,
  /** 导入上传的外部 Klei 集群存档到指定实例（要求实例已停止且已完成游戏安装） */
  importSave: (data: SaveImportRequest) => api.post('app/instance/backup/import', data, { timeout: 0 }) as Promise<{ data: SaveImportResult }>,
  /** 创建面板数据库一致性快照（VACUUM INTO） */
  createDbBackup: () => api.post('app/system/db/backup', {}, { timeout: 0 }) as Promise<{ data: BackupMutationResult }>,
  /** 数据库快照列表 */
  getDbBackupList: () => api.get('app/system/db/backup') as Promise<{ data: BackupItem[] }>,
  /** 上传外部面板数据库快照（.sqlite）：只入库，是否恢复由用户在列表里另行确认 */
  uploadDbSnapshot: (file: File, onProgress?: (percent: number) => void) => api.post(`app/system/db/backup/import?fileName=${encodeURIComponent(file.name)}`, file, {
    headers: { 'Content-Type': 'application/octet-stream' },
    timeout: 0,
    onUploadProgress: (event: { loaded: number, total?: number }) => {
      if (onProgress && event.total) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)))
      }
    },
  }) as Promise<{ data: BackupMutationResult }>,
  /**
   * 用快照恢复面板数据。
   *
   * 服务端替换数据库后会让面板进程退出、由部署侧拉起，因此这个请求之后连接会断——
   * 调用方不能把「请求失败」当作「恢复失败」，而要按 /health 是否可达来判断结果。
   */
  restoreDbSnapshot: (backupId: string, confirmText: string) => api.post('app/system/db/backup/restore', {
    backupId,
    confirmText,
  }, { timeout: 0 }) as Promise<{ data: BackupMutationResult }>,
  /**
   * 生成并下载「迁移包」：把实例存档 + 配置 + Mod 清单整理成另一台机器可直接导入的 tar.gz。
   * 打包耗时取决于存档大小，因此与备份下载一样关闭请求超时。
   */
  exportMigrationPack: (instanceId: string, includeMods = false) => api.post('app/instance/migration/export', { instanceId, includeMods }, {
    responseType: 'blob',
    timeout: 0,
  }) as Promise<{ data: Blob, headers: Record<string, string> }>,
  /** 先取迁移报告（不打包）：分片端口、Mod、名单与迁移前必须确认的风险项 */
  getMigrationReport: (instanceId: string, includeMods = false) => api.post('app/instance/migration/report', { instanceId, reportOnly: true, includeMods }) as Promise<{ data: MigrationExportResult }>,
}
