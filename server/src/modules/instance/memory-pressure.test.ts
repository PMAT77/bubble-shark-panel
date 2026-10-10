import assert from 'node:assert/strict'
import { it } from 'node:test'
import { emptyResourceSnapshot } from '../../infra/container/dst-container-resources'
import { confirmedOom, MemoryPressureWindow, shardPressure } from './memory-pressure'

it('requires reclaim every interval and 15 seconds of pressure, with no loading progress', () => {
  const window = new MemoryPressureWindow()
  const tick = (at: number, events: number, progress = 0) => window.observe({ at, severe: true, events, requireReclaim: true, lastProgressAt: progress })
  assert.equal(tick(0, 8), false)
  assert.equal(tick(5000, 9), false)
  assert.equal(tick(10000, 10), false)
  assert.equal(tick(15000, 11, 10000), false)
  assert.equal(tick(20000, 12, 10000), false)
  assert.equal(tick(25000, 13, 10000), true)
  assert.equal(tick(30000, 13), false, 'reclaim stopped')
  assert.equal(tick(35000, 14), false)
  assert.equal(tick(40000, 15), false)
  assert.equal(tick(45000, 16), true)
})

it('unknown metrics, interrupted sampling, counter reset and brief peaks reset the window', () => {
  const window = new MemoryPressureWindow()
  window.observe({ at: 0, severe: true, events: 10, requireReclaim: true })
  window.observe({ at: 5000, severe: true, events: 11, requireReclaim: true })
  assert.equal(window.observe({ at: 10000, severe: null, events: null, requireReclaim: true }), false)
  assert.equal(window.observe({ at: 15000, severe: true, events: 12, requireReclaim: true }), false)
  assert.equal(window.observe({ at: 30000, severe: true, events: 13, requireReclaim: true }), false)
  assert.equal(window.observe({ at: 35000, severe: true, events: 1, requireReclaim: true }), false)
  assert.equal(window.observe({ at: 40000, severe: false }), false)
  assert.equal(shardPressure({ ...emptyResourceSnapshot(), memoryCurrentMb: 1536, memoryMaxMb: 1536, memoryPressureFullAvg10: 0 }).severe, false)
  assert.equal(shardPressure({ ...emptyResourceSnapshot(), memoryCurrentMb: 1300, memoryMaxMb: 1536, memoryHighMb: 1229, highEvents: 9, memoryPressureFullAvg10: 83 }).severe, true)
})

it('historical OOM, unknown counters and ordinary restarts alone are not confirmed OOM', () => {
  const history = { ...emptyResourceSnapshot(), oomKillCount: 8, oomKilled: true, restarts: 4 }
  assert.equal(confirmedOom(history, history), false)
  assert.equal(confirmedOom(history, null), false)
  assert.equal(confirmedOom({ ...history, restarts: 6 }, history), false)
  assert.equal(confirmedOom({ ...history, oomKillCount: 9 }, history), true)
  assert.equal(confirmedOom({ ...history, oomKilled: true }, { ...history, oomKilled: false }), true)
})
