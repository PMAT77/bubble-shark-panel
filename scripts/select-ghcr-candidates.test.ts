import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

test('GHCR cleanup only deletes versions belonging to this run with exclusively candidate tags', () => {
  const candidate = 'candidate-123-1'
  const version = (id: number, tags: string[] | null) => ({ id, metadata: { container: { tags } } })
  const pages = [
    [version(1, [candidate]), version(2, [candidate, 'v0.15.4']), version(3, [])],
    [version(4, [candidate, 'v0.15.3', 'v0.15.4']), version(5, [candidate, 'latest']),
      version(6, ['candidate-other-1']), version(7, [candidate, 'candidate-123-2']),
      version(8, null), { id: 9 }],
  ]
  const result = execFileSync(process.execPath, ['scripts/select-ghcr-candidates.mjs', candidate], {
    input: JSON.stringify(pages),
    encoding: 'utf8',
  })
  assert.equal(result, '1\n7\n')
})
