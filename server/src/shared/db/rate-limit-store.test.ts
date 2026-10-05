import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { closeDatabase, initDatabase } from './index'
import {
  deleteRateLimitState,
  getRateLimitState,
  saveRateLimitState,
} from './rate-limit-store'

const dbFilePath = path.join(os.tmpdir(), `bsp-rate-limit-test-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

describe('rate limit store', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
  })

  after(() => {
    closeDatabase()
  })

  it('round-trips state and survives close/reopen (重启不清零)', async () => {
    const key = `test:${randomUUID()}`
    assert.equal(getRateLimitState(key), undefined)

    // windowStart 必须用当前时间：超过 24h 的行会被 prune 视为过期清理
    const windowStart = Date.now()
    const blockedUntil = windowStart + 15 * 60 * 1000
    saveRateLimitState(key, { failedCount: 3, windowStart, blockedUntil })
    assert.deepEqual(getRateLimitState(key), { failedCount: 3, windowStart, blockedUntil })

    saveRateLimitState(key, { failedCount: 4, windowStart, blockedUntil })
    assert.equal(getRateLimitState(key)?.failedCount, 4)

    closeDatabase()
    await initDatabase(dbFilePath, migrationsFolder)
    assert.deepEqual(getRateLimitState(key), { failedCount: 4, windowStart, blockedUntil })
  })

  it('deletes state', () => {
    const key = `test:${randomUUID()}`
    saveRateLimitState(key, { failedCount: 1, windowStart: Date.now(), blockedUntil: 0 })
    deleteRateLimitState(key)
    assert.equal(getRateLimitState(key), undefined)
    // 幂等
    deleteRateLimitState(key)
    assert.equal(getRateLimitState(key), undefined)
  })
})
