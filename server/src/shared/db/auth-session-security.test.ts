import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  createSessionTokens,
  closeDatabase,
  findUserByAccount,
  findUserByToken,
  initDatabase,
  rotateSessionByRefreshToken,
  updateUserPassword,
} from './index'

const dbFilePath = path.join(os.tmpdir(), `bsp-auth-test-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

describe('auth session security', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
  })

  after(() => {
    closeDatabase()
  })

  it('rotates refresh token and revokes old session tokens', async () => {
    const user = await findUserByAccount('superadmin')
    assert.ok(user, 'superadmin should exist')

    const firstTokens = await createSessionTokens(user.id, { remember: false })
    const rotated = await rotateSessionByRefreshToken(firstTokens.refreshToken)

    assert.ok(rotated, 'refresh token should be rotatable once')
    assert.ok(rotated.tokens.accessToken.length > 0)
    assert.ok(rotated.tokens.refreshToken.length > 0)
    assert.notEqual(rotated.tokens.refreshToken, firstTokens.refreshToken)
    assert.equal(await rotateSessionByRefreshToken(firstTokens.refreshToken), undefined, 'old refresh token must be invalid after rotation')
    assert.equal(await findUserByToken(firstTokens.accessToken), undefined, 'old access token should be revoked after refresh rotation')
    assert.ok(await findUserByToken(rotated.tokens.accessToken), 'new access token should be valid')
  })

  it('rejects expired refresh token', async () => {
    const user = await findUserByAccount('superadmin')
    assert.ok(user, 'superadmin should exist')
    const tokens = await createSessionTokens(user.id, { remember: false })

    const sqliteDb = new DatabaseSync(dbFilePath)
    sqliteDb.prepare(`
      UPDATE auth_sessions
      SET refresh_expires_at = ?
      WHERE refresh_token_hash = ?
    `).run('1970-01-01T00:00:00.000Z', hashToken(tokens.refreshToken))
    sqliteDb.close()

    const rotated = await rotateSessionByRefreshToken(tokens.refreshToken)
    assert.equal(rotated, undefined, 'expired refresh token must be rejected')
  })

  it('allows refresh token rotation after access token expires', async () => {
    const user = await findUserByAccount('superadmin')
    assert.ok(user, 'superadmin should exist')
    const tokens = await createSessionTokens(user.id, { remember: true })

    const sqliteDb = new DatabaseSync(dbFilePath)
    sqliteDb.prepare(`
      UPDATE auth_sessions
      SET expires_at = ?
      WHERE token_hash = ?
    `).run('1970-01-01T00:00:00.000Z', hashToken(tokens.accessToken))
    sqliteDb.close()

    const expiredAccessUser = await findUserByToken(tokens.accessToken)
    assert.equal(expiredAccessUser, undefined, 'expired access token should be invalid')

    const rotated = await rotateSessionByRefreshToken(tokens.refreshToken)
    assert.ok(rotated, 'refresh token should still be usable after access token expiry')
    assert.ok(await findUserByToken(rotated.tokens.accessToken), 'rotated access token should be valid')
  })

  it('revokes all active sessions after password update', async () => {
    const user = await findUserByAccount('superadmin')
    assert.ok(user, 'superadmin should exist')

    const sessionA = await createSessionTokens(user.id)
    const sessionB = await createSessionTokens(user.id)

    assert.ok(await findUserByToken(sessionA.accessToken), 'session A should be valid before password change')
    assert.ok(await findUserByToken(sessionB.accessToken), 'session B should be valid before password change')

    await updateUserPassword(user.id, 'P2_Regression#2026')

    assert.equal(await findUserByToken(sessionA.accessToken), undefined, 'session A should be revoked after password change')
    assert.equal(await findUserByToken(sessionB.accessToken), undefined, 'session B should be revoked after password change')
  })
})
