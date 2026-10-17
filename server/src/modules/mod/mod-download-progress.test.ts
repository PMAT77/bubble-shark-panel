import assert from 'node:assert/strict'
import { it } from 'node:test'
import { normalizeModDownloadProgress } from './mod-download-progress'

it('derives percent from real bytes, ignores duplicates, and resets for a new attempt', () => {
  const first = normalizeModDownloadProgress({ downloadedBytes: 40, totalBytes: 100, percent: 99 })!
  assert.equal(first.percent, 40)
  assert.deepEqual(normalizeModDownloadProgress({ ...first, downloadedBytes: 40 }, first), first)
  assert.deepEqual(normalizeModDownloadProgress({ ...first, downloadedBytes: 20 }, first), first)
  assert.equal(normalizeModDownloadProgress({ ...first, downloadedBytes: 2 })?.percent, 2)
  assert.equal(normalizeModDownloadProgress({ ...first, totalBytes: Number.NaN }, first), first)
  assert.deepEqual(normalizeModDownloadProgress({ downloadedBytes: 0, totalBytes: 0, percent: 0 }), { downloadedBytes: 0, totalBytes: 0, percent: 100 })
})
