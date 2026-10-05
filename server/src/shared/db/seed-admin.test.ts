import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AdminCredentialOutcome } from '../config/credentials-file'
import { closeDatabase, findUserByAccount, initDatabase, updateUserPassword, verifyPassword } from '../../shared/db/index'

const dbFilePath = path.join(os.tmpdir(), `bsp-seed-admin-test-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

describe('seedAdminUserFromEnv', () => {
  after(() => {
    closeDatabase()
  })

  it('does not overwrite existing admin password on restart unless sync flag is enabled', async () => {
    await initDatabase(dbFilePath, migrationsFolder, {
      adminUsername: 'superadmin',
      adminPassword: '123456',
      seedDevelopmentUsers: false,
    })
    const user = await findUserByAccount('superadmin')
    assert.ok(user)
    await updateUserPassword(user!.id, 'CustomPwd#2026')
    closeDatabase()

    await initDatabase(dbFilePath, migrationsFolder, {
      adminUsername: 'superadmin',
      adminPassword: '123456',
      seedDevelopmentUsers: false,
      syncAdminPasswordFromEnv: false,
    })
    const afterRestart = await findUserByAccount('superadmin')
    assert.ok(afterRestart)
    assert.equal(verifyPassword('CustomPwd#2026', afterRestart!.password_hash), true)
    closeDatabase()

    await initDatabase(dbFilePath, migrationsFolder, {
      adminUsername: 'superadmin',
      adminPassword: '123456',
      seedDevelopmentUsers: false,
      syncAdminPasswordFromEnv: true,
    })
    const afterSync = await findUserByAccount('superadmin')
    assert.ok(afterSync)
    assert.equal(verifyPassword('123456', afterSync!.password_hash), true)
    closeDatabase()
  })

  it('reports created / skipped / updated / absent for the credentials outcome', async () => {
    const outcomeDbPath = path.join(os.tmpdir(), `bsp-seed-admin-outcome-test-${randomUUID()}.sqlite`)
    const outcomes: AdminCredentialOutcome[] = []
    const record = (outcome: AdminCredentialOutcome) => {
      outcomes.push(outcome)
    }

    await initDatabase(outcomeDbPath, migrationsFolder, {
      adminUsername: 'superadmin',
      adminPassword: '123456',
      seedDevelopmentUsers: false,
      onAdminCredentialOutcome: record,
    })
    closeDatabase()

    await initDatabase(outcomeDbPath, migrationsFolder, {
      adminUsername: 'superadmin',
      adminPassword: 'ChangedPwd#2026',
      seedDevelopmentUsers: false,
      syncAdminPasswordFromEnv: false,
      onAdminCredentialOutcome: record,
    })
    const afterSkip = await findUserByAccount('superadmin')
    // 未开启同步时环境变量里的密码不得写库，否则初始凭据文件会与库内密码不一致
    assert.equal(verifyPassword('123456', afterSkip!.password_hash), true)
    closeDatabase()

    await initDatabase(outcomeDbPath, migrationsFolder, {
      adminUsername: 'superadmin',
      adminPassword: 'ChangedPwd#2026',
      seedDevelopmentUsers: false,
      syncAdminPasswordFromEnv: true,
      onAdminCredentialOutcome: record,
    })
    const afterUpdate = await findUserByAccount('superadmin')
    assert.equal(verifyPassword('ChangedPwd#2026', afterUpdate!.password_hash), true)
    closeDatabase()

    await initDatabase(outcomeDbPath, migrationsFolder, {
      seedDevelopmentUsers: false,
      onAdminCredentialOutcome: record,
    })
    closeDatabase()

    assert.deepEqual(outcomes, ['created', 'skipped', 'updated', 'absent'])
  })
})
