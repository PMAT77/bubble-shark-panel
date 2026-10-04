import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  modConfigPayloadSchema,
  modInstallPayloadSchema,
  modReorderPayloadSchema,
  modUpdateCheckPayloadSchema,
  steamModListQuerySchema,
  modDownloadQueueStartSchema,
  modImportCommitSchema,
} from '../../../../shared/contracts/mod'

describe('mod API contracts', () => {
  it('accepts legacy and batch import payloads but rejects ambiguous shapes and empty batches', () => {
    const importId = '12345678-1234-4234-8234-123456789012'
    assert.deepEqual(modImportCommitSchema.parse({ importId, workshopId: '123' }), { importId, workshopId: '123', overwrite: false })
    assert.equal(modImportCommitSchema.safeParse({ importId, items: [{ itemId: importId, workshopId: '123' }] }).success, true)
    assert.equal(modImportCommitSchema.safeParse({ importId, items: [] }).success, false)
    assert.equal(modImportCommitSchema.safeParse({ importId, workshopId: '123', items: [{ itemId: importId, workshopId: '123' }] }).success, false)
    assert.equal(modImportCommitSchema.safeParse({ importId, items: [{ itemId: '../directory', workshopId: '123' }] }).success, false)
  })
  it('keeps legacy start behavior while allowing explicit continue and retry', () => {
    assert.deepEqual(modDownloadQueueStartSchema.parse({}), { retryFailed: true })
    assert.deepEqual(modDownloadQueueStartSchema.parse({ retryFailed: false }), { retryFailed: false })
    assert.equal(modDownloadQueueStartSchema.safeParse({ retryFailed: 'false' }).success, false)
  })
  it('normalizes install payload identifiers', () => {
    assert.deepEqual(modInstallPayloadSchema.parse({
      workshopId: ' 123456 ',
      dependencyIds: [' 42 '],
      enabled: true,
    }), {
      workshopId: '123456',
      dependencyIds: ['42'],
      enabled: true,
    })
  })

  it('rejects malformed mutation and query payloads', () => {
    assert.equal(modInstallPayloadSchema.safeParse({ workshopId: '' }).success, false)
    assert.equal(modReorderPayloadSchema.safeParse({ workshopIds: '123' }).success, false)
    assert.equal(steamModListQuerySchema.safeParse({ page: {} }).success, false)
  })

  it('validates mod config payload option value types', () => {
    assert.deepEqual(modConfigPayloadSchema.safeParse({ options: { a: 'x', b: 2, c: true } }).success, true)
    assert.deepEqual(modConfigPayloadSchema.safeParse({ options: {} }).success, true)
    assert.equal(modConfigPayloadSchema.safeParse({ options: { a: [1] } }).success, false)
    assert.equal(modConfigPayloadSchema.safeParse({ options: { a: { nested: 1 } } }).success, false)
    assert.equal(modConfigPayloadSchema.safeParse({ options: { '': 1 } }).success, false)
  })

  it('accepts an empty or forced mod update check payload only', () => {
    assert.deepEqual(modUpdateCheckPayloadSchema.parse({}), {})
    assert.deepEqual(modUpdateCheckPayloadSchema.parse({ force: true }), { force: true })
    assert.equal(modUpdateCheckPayloadSchema.safeParse({ force: 'yes' }).success, false)
  })
})
