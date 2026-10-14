import assert from 'node:assert/strict'
import { it } from 'node:test'
import { SteamcmdTimeout, STEAMCMD_BOOTSTRAP_TIMEOUT_MS, formatSteamcmdTimeoutMessage } from './steamcmd-timeout'

it('allows a slow bootstrap past the original task budget and starts a fresh task budget once', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let expired = false
  const timeout = new SteamcmdTimeout(10 * 60 * 1000, () => { expired = true })
  timeout.observe('[  0%] Checking for available updates...')
  t.mock.timers.tick(20 * 60 * 1000)
  assert.equal(expired, false)
  timeout.observe('[ 90%] Downloading update (22225 of 24695 KB)...')
  timeout.observe('Steam Console Client (c) Valve Corporation - version 1')
  t.mock.timers.tick(9 * 60 * 1000)
  timeout.observe('Loading Steam API...OK')
  timeout.observe('Downloading update (1 of 2 KB)...')
  t.mock.timers.tick(60 * 1000)
  assert.equal(expired, true)
  assert.equal(timeout.expiredPhase, 'task')
  timeout.dispose()
})

it('keeps the bootstrap deadline absolute across progress, self-restarts and repeated startup logs', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let calls = 0
  const timeout = new SteamcmdTimeout(90_000, () => { calls++ })
  t.mock.timers.tick(30_000)
  timeout.observe('Downloading update (1 of 24695 KB)...')
  t.mock.timers.tick(STEAMCMD_BOOTSTRAP_TIMEOUT_MS - 60_000)
  timeout.observe('Restarting SteamCMD...')
  timeout.observe('Checking for available updates...')
  t.mock.timers.tick(30_000)
  assert.equal(calls, 1)
  assert.equal(timeout.expiredPhase, 'bootstrap')
  timeout.observe('Loading Steam API...OK')
  t.mock.timers.tick(STEAMCMD_BOOTSTRAP_TIMEOUT_MS)
  assert.equal(calls, 1)
  assert.match(formatSteamcmdTimeoutMessage('bootstrap', 90_000, '进程'), /自更新超过 60 分钟/)
  timeout.dispose()
})

it('retains configured task budgets when bootstrap output is unknown or already complete', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  for (const budget of [90_000, 10 * 60 * 1000, 60 * 60 * 1000, 123_456]) {
    let expired = false
    const timeout = new SteamcmdTimeout(budget, () => { expired = true })
    t.mock.timers.tick(budget - 1)
    timeout.observe('unrecognized progress 99%')
    timeout.observe('Steam Console Client (c) Valve Corporation')
    timeout.observe('Checking for available updates...')
    t.mock.timers.tick(1)
    assert.equal(expired, true)
    assert.equal(timeout.expiredPhase, 'task')
    timeout.dispose()
  }
})

it('ignores diagnostic history and disposes deadlines after completion or cancellation', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let calls = 0
  const timeout = new SteamcmdTimeout(100, () => { calls++ })
  timeout.observe('[SteamCMD 诊断] Checking for available updates...')
  t.mock.timers.tick(100)
  assert.equal(timeout.expiredPhase, 'task')
  assert.equal(calls, 1)
  const stopped = new SteamcmdTimeout(100, () => { calls++ })
  stopped.observe('Checking for available updates...')
  stopped.dispose()
  stopped.observe('Loading Steam API...OK')
  t.mock.timers.tick(STEAMCMD_BOOTSTRAP_TIMEOUT_MS)
  assert.equal(calls, 1)
})
