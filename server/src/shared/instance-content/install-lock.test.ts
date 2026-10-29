import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { withInstallPathLock } from './install-lock'

it('serializes one installation while letting other installations write independently', async () => {
  const directory = path.join(os.tmpdir(), 'bsp-install-lock-fixture')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const events: string[] = []
  const first = withInstallPathLock(directory, async () => { events.push('first'); await gate; events.push('first done') })
  await Promise.resolve()
  const second = withInstallPathLock(directory, async () => { events.push('second') })
  await withInstallPathLock(`${directory}-other`, async () => { events.push('other') })
  assert.deepEqual(events, ['first', 'other'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(events, ['first', 'other', 'first done', 'second'])
})

it('cancels a waiting writer without allowing its successor to overtake the active writer', async () => {
  const directory = path.join(os.tmpdir(), 'bsp-install-lock-cancel')
  let release!: () => void
  const first = withInstallPathLock(directory, () => new Promise<void>(resolve => { release = resolve }))
  await Promise.resolve()
  const controller = new AbortController()
  const cancelled = withInstallPathLock(directory, async () => assert.fail('cancelled writer ran'), { signal: controller.signal })
  controller.abort(new Error('cancelled fixture'))
  await assert.rejects(cancelled, /cancelled fixture/)
  let entered = false
  const next = withInstallPathLock(directory, async () => { entered = true })
  await Promise.resolve()
  assert.equal(entered, false)
  release()
  await Promise.all([first, next])
  assert.equal(entered, true)
})

it('allows a SteamCMD adapter to reuse its calling installation pipeline lock', async () => {
  const directory = path.join(os.tmpdir(), 'bsp-install-lock-reentrant')
  let calls = 0
  await withInstallPathLock(directory, () => withInstallPathLock(directory, async () => { calls++ }))
  assert.equal(calls, 1)
})
