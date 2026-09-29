import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { readMigrationFiles } from 'drizzle-orm/migrator'

/**
 * 面板数据库文件体检。
 *
 * 为什么单独抽一层：导入、恢复与「启动收尾」三处都要判断「这个文件能不能当面板数据库用」，
 * 各写一遍的结局是口径分叉——导入放行的库恢复时被拒，用户看到的是没法解释的
 * 「能导入但不能恢复」。
 */

/** SQLite 文件头（16 字节，含结尾的 NUL）：先挡掉明显不是数据库的文件，再交给 SQLite 打开 */
const SQLITE_HEADER = 'SQLite format 3\u0000'
/** 核心表：缺任何一张都说明这不是本面板的库 */
const REQUIRED_TABLES = ['users', 'game_instances', 'system_settings', '__drizzle_migrations']

export interface PanelDatabaseVerifyResult {
  ok: boolean
  /** 失败原因（面向用户的中文短句） */
  message?: string
  /** 库内已应用的迁移条数；仅诊断用 */
  migrationCount?: number
}

function readSqliteHeader(filePath: string): string | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r')
    const header = Buffer.alloc(SQLITE_HEADER.length)
    const read = fs.readSync(fd, header, 0, header.length, 0)
    return read === header.length ? header.toString('latin1') : null
  }
  catch {
    return null
  }
  finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      }
      catch {
        // 已关闭
      }
    }
  }
}

/**
 * 校验一个 SQLite 文件能否作为面板数据库。
 *
 * 检查项按「越早越便宜」排序：文件头 → 完整性 → 表结构 → 迁移版本。
 * 迁移版本这一条挡住的是「把新版本面板的快照塞进旧面板」——那会让库结构与代码对不上，
 * 与 `docs/install-docker.md` / `docs/install-native.md` 升级一节里「跨版本回滚前先做快照」的告诫是同一个坑。
 */
export function verifyPanelDatabaseFile(filePath: string, migrationsFolder: string): PanelDatabaseVerifyResult {
  if (!fs.existsSync(filePath)) {
    return { ok: false, message: '快照文件不存在' }
  }
  try {
    if (fs.statSync(filePath).size === 0) {
      return { ok: false, message: '快照文件是空的' }
    }
  }
  catch {
    return { ok: false, message: '快照文件不可读' }
  }
  if (readSqliteHeader(filePath) !== SQLITE_HEADER) {
    return { ok: false, message: '这不是 SQLite 数据库文件（面板数据库快照应为 .sqlite）' }
  }

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(filePath, { readOnly: true })
    const integrity = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined
    const integrityValue = integrity ? String(Object.values(integrity)[0] ?? '') : ''
    if (integrityValue !== 'ok') {
      return { ok: false, message: `数据库完整性校验未通过：${integrityValue || '未知原因'}` }
    }

    const rows = db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\'').all() as Array<{ name: string }>
    const names = new Set(rows.map(row => row.name))
    const missing = REQUIRED_TABLES.filter(table => !names.has(table))
    if (missing.length > 0) {
      return { ok: false, message: `这不是本面板的数据库（缺少 ${missing.join('、')} 表）` }
    }

    const versionRow = db.prepare('SELECT MAX(created_at) AS latest FROM __drizzle_migrations').get() as { latest?: number | null } | undefined
    const snapshotLatest = Number(versionRow?.latest ?? 0)
    const supportedLatest = readMigrationFiles({ migrationsFolder })
      .reduce((max, file) => Math.max(max, file.folderMillis), 0)
    if (Number.isFinite(snapshotLatest) && snapshotLatest > supportedLatest) {
      return { ok: false, message: '该快照来自更新版本的面板，请先升级面板再恢复' }
    }

    const countRow = db.prepare('SELECT COUNT(*) AS total FROM __drizzle_migrations').get() as { total?: number } | undefined
    return { ok: true, migrationCount: Number(countRow?.total ?? 0) }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `无法读取该数据库：${message}` }
  }
  finally {
    try {
      db?.close()
    }
    catch {
      // 打不开时 db 未赋值；已关闭的句柄重复关闭也不影响结果
    }
  }
}
