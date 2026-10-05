import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import {
  ADMIN_CREDENTIALS_FILENAME,
  deleteAdminCredentialsFile,
  resolveAdminCredentialsFilePath,
  shouldWriteAdminCredentialsFile,
  writeAdminCredentialsFile,
} from './credentials-file'

describe('初始管理员凭据文件', () => {
  const workDir = path.join(os.tmpdir(), `bsp-credentials-file-test-${randomUUID()}`)
  const dbPath = path.join(workDir, 'bubblesharkpanel.sqlite')

  after(() => {
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('只有密码真正写库时才落盘凭据文件', () => {
    assert.equal(shouldWriteAdminCredentialsFile('created'), true)
    assert.equal(shouldWriteAdminCredentialsFile('updated'), true)
    assert.equal(shouldWriteAdminCredentialsFile('skipped'), false)
    assert.equal(shouldWriteAdminCredentialsFile('absent'), false)
  })

  it('凭据文件与数据库同目录，且可被删除', () => {
    fs.mkdirSync(workDir, { recursive: true })
    const filePath = writeAdminCredentialsFile(dbPath, 'superadmin', 'GsH!secret2026')
    assert.equal(filePath, resolveAdminCredentialsFilePath(dbPath))
    assert.equal(path.basename(filePath), ADMIN_CREDENTIALS_FILENAME)
    const content = fs.readFileSync(filePath, 'utf8')
    assert.match(content, /^ADMIN_USERNAME=superadmin$/m)
    assert.match(content, /^ADMIN_PASSWORD=GsH!secret2026$/m)

    deleteAdminCredentialsFile(dbPath)
    assert.equal(fs.existsSync(filePath), false)
  })

  it('删除不存在的凭据文件不抛错', () => {
    deleteAdminCredentialsFile(path.join(workDir, 'missing-dir', 'bubblesharkpanel.sqlite'))
  })
})
