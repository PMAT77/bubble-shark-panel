import fs from 'node:fs'
import path from 'node:path'

/** 初始管理员凭据文件名（与数据库同目录，0600 权限） */
export const ADMIN_CREDENTIALS_FILENAME = 'admin-credentials.txt'

/**
 * 环境变量中的管理员凭证本次启动的落库结果。
 * - created：数据库中原本没有该管理员，已用该凭证创建
 * - updated：开启了 BSP_SYNC_ADMIN_PASSWORD_FROM_ENV，已用该凭证覆盖既有密码
 * - skipped：管理员已存在且未开启同步，环境变量里的密码未写库
 * - absent：未提供管理员名或密码，未参与落库
 */
export type AdminCredentialOutcome = 'created' | 'updated' | 'skipped' | 'absent'

/**
 * 仅当密码确实写入了数据库时才落盘初始凭据文件。
 * 否则凭据文件里会是一个从未生效的随机密码（用户照它登录必然失败），
 * 而且每次启动都会被新的随机密码覆盖。
 */
export function shouldWriteAdminCredentialsFile(outcome: AdminCredentialOutcome): boolean {
  return outcome === 'created' || outcome === 'updated'
}

export function resolveAdminCredentialsFilePath(dbPath: string): string {
  return path.join(path.dirname(dbPath), ADMIN_CREDENTIALS_FILENAME)
}

/**
 * 生产环境自动生成管理员密码时，把凭据写入 0600 权限文件。
 * 密码不得进入应用日志（journald/日志采集管道不可信）。
 */
export function writeAdminCredentialsFile(dbPath: string, username: string, password: string): string {
  const filePath = resolveAdminCredentialsFilePath(dbPath)
  fs.writeFileSync(filePath, [
    '# BubbleSharkPanel 初始管理员凭据',
    '# 首次登录修改密码后本文件即失效，可手动删除。',
    `ADMIN_USERNAME=${username}`,
    `ADMIN_PASSWORD=${password}`,
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 })
  return filePath
}

/** 首次强制改密完成后删除初始凭据文件（幂等，失败不影响主流程） */
export function deleteAdminCredentialsFile(dbPath: string): void {
  try {
    fs.rmSync(resolveAdminCredentialsFilePath(dbPath), { force: true })
  }
  catch {
    // 文件仅含已被替换的初始密码，删除失败无需阻断改密流程。
  }
}
