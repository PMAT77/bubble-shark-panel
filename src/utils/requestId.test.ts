import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { it } from 'node:test'
import { worldMaintenancePayloadSchema } from '../../shared/contracts/world-maintenance.ts'
import { createRequestId } from './requestId.ts'

it('uses the native UUID API when available', (t) => {
  const expected = 'e1f76aae-f969-4ab4-834a-95f3ce75e4cd'
  const native = t.mock.method(globalThis.crypto, 'randomUUID', () => expected)
  assert.equal(createRequestId(), expected)
  assert.equal(native.mock.callCount(), 1)
})

it('generates contract-valid UUID v4 IDs without the secure-context API', (t) => {
  t.mock.getter(globalThis, 'crypto', () => ({ getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }))
  const ids = Array.from({ length: 32 }, () => createRequestId())
  for (const requestId of ids) {
    assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(worldMaintenancePayloadSchema.safeParse({ instanceId: 'fixture', requestId, action: 'reset', confirmName: '测试房间' }).success, true)
  }
  assert.equal(new Set(ids).size, ids.length)
})

it('reports unsupported browsers instead of generating a weak or invalid ID', (t) => {
  t.mock.getter(globalThis, 'crypto', () => undefined)
  assert.throws(() => createRequestId(), /请更新浏览器/)
})
