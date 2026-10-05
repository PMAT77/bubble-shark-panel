/**
 * 一次性迁移：统一演示/管理员账号为 superadmin/123456，清理 legacy superman/admin。
 * 用法: pnpm exec tsx server/scripts/migrate-demo-accounts.ts
 */
import { randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dbPath = path.join(repoRoot, 'server/data/bubblesharkpanel.sqlite')

function hashPassword(password: string, salt = randomUUID()) {
  const derivedKey = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${derivedKey}`
}

function verifyPassword(password: string, storedHash: string) {
  const [salt, hashed] = storedHash.split(':')
  if (!salt || !hashed) {
    return false
  }
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hashed, 'hex'))
}

const targetPassword = '123456'
const accountsToUpdate = ['superadmin', 'test']
const legacyAccounts = ['superman', 'admin']

const db = new DatabaseSync(dbPath)
const now = new Date().toISOString()

db.exec('BEGIN')
try {
  for (const account of accountsToUpdate) {
    const row = db.prepare('SELECT id FROM users WHERE account = ?').get(account) as { id: string } | undefined
    if (!row) {
      console.log(`Skip password update (missing): ${account}`)
      continue
    }
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      hashPassword(targetPassword),
      now,
      row.id,
    )
    console.log(`Updated password: ${account}`)
  }

  for (const legacy of legacyAccounts) {
    const row = db.prepare('SELECT id FROM users WHERE account = ?').get(legacy) as { id: string } | undefined
    if (!row) {
      continue
    }
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(row.id)
    db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(row.id)
    db.prepare('DELETE FROM users WHERE id = ?').run(row.id)
    console.log(`Removed legacy account: ${legacy}`)
  }

  db.exec('COMMIT')
}
catch (error) {
  db.exec('ROLLBACK')
  throw error
}

const users = db.prepare('SELECT account, email, must_change_password, password_hash FROM users ORDER BY account').all() as Array<{
  account: string
  email: string
  must_change_password: number
  password_hash: string
}>

console.log('\nCurrent users:')
for (const user of users) {
  const ok = verifyPassword(targetPassword, user.password_hash)
  console.log(`- ${user.account} (${user.email}) password=123456: ${ok ? 'OK' : 'FAIL'}`)
}
