import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, it } from 'node:test'
import { retrySteamcmdInstall } from './steamcmd-install-retry'

const keys = ['BSP_STEAMCMD_INSTALL_MAX_ATTEMPTS', 'BSP_STEAMCMD_INSTALL_RETRY_DELAYS_MS']
const previous = keys.map(key => process.env[key])
afterEach(() => keys.forEach((key, index) => {
  if (previous[index] === undefined) delete process.env[key]
  else process.env[key] = previous[index]
}))

it('retries incomplete updates with a finite budget and preserves download artifacts', async () => {
  process.env.BSP_STEAMCMD_INSTALL_MAX_ATTEMPTS = '3'
  process.env.BSP_STEAMCMD_INSTALL_RETRY_DELAYS_MS = '1'
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-install-retry-'))
  const cache = path.join(root, 'steamapps', 'downloading', '343050', 'chunk')
  fs.mkdirSync(path.dirname(cache), { recursive: true })
  fs.writeFileSync(cache, 'partial')
  const retries: number[] = []
  let count = 0
  try {
    const result = await retrySteamcmdInstall({
      run: async () => {
        assert.equal(fs.readFileSync(cache, 'utf8'), 'partial')
        return { ok: false, output: `Error! App '343050' state is 0x${++count === 1 ? '402' : '602'} after update job.` }
      },
      isCancelled: () => false,
      onRetry: async attempt => { retries.push(attempt) },
    })
    assert.equal(result.ok, false)
    assert.equal(count, 3)
    assert.deepEqual(retries, [2, 3])
    assert.equal(fs.readFileSync(cache, 'utf8'), 'partial')
  }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
})

it('stops on success, permanent failures and cancellation during backoff', async () => {
  process.env.BSP_STEAMCMD_INSTALL_MAX_ATTEMPTS = '3'
  process.env.BSP_STEAMCMD_INSTALL_RETRY_DELAYS_MS = '1'
  for (const output of ['Success!', 'No subscription', 'Permission denied', 'Not enough disk space', 'BSP-STEAMCMD-OOM']) {
    let count = 0
    await retrySteamcmdInstall({
      run: async () => { count++; return { ok: output === 'Success!', output } },
      isCancelled: () => false,
      onRetry: async () => { assert.fail('must not retry') },
    })
    assert.equal(count, 1)
  }
  let cancelled = false
  let count = 0
  const result = await retrySteamcmdInstall({
    run: async () => { count++; return { ok: false, output: 'Missing configuration' } },
    isCancelled: () => cancelled,
    onRetry: async () => { cancelled = true },
  })
  assert.equal(result.cancelled, true)
  assert.equal(count, 1)
})
