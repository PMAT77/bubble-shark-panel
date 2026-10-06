import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createReconciliationCache } from './reconciliation-cache'

it('merges concurrent reads, expires after one second and invalidates after writes', async () => {
  let calls = 0
  let revision = 0
  let now = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const reconcile = createReconciliationCache(async () => { calls++; await gate; return true }, () => revision, () => now)
  const reads = [reconcile(), reconcile(), reconcile()]
  assert.equal(calls, 1)
  release()
  await Promise.all(reads)
  await reconcile()
  assert.equal(calls, 1)
  revision++
  await reconcile()
  assert.equal(calls, 2)
  now = 1000
  await reconcile()
  assert.equal(calls, 3)
})

it('does not cache failures, unknown probes or results invalidated during a run', async () => {
  let calls = 0
  let revision = 0
  const reconcile = createReconciliationCache(async () => {
    calls++
    if (calls === 1) throw new Error('unreachable')
    if (calls === 2) return false
    revision++
    return true
  }, () => revision)
  await assert.rejects(reconcile(), /unreachable/)
  await reconcile()
  await reconcile()
  await reconcile()
  assert.equal(calls, 4)
})
