import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { buildHostResourceSnapshot, calculateMemoryReserveMb, cgroupPath, readCgroupMemory, sampleRuntimeResources } from './memory-budget'
import { emptyResourceSnapshot } from './dst-container-resources'
import { assessHostMemoryForHeavyOperation } from './host-resource-guard'
import type { ContainerRuntime } from './types'

it('budget reserves full panel peak and configured headroom without adding swap to the RAM cap', () => {
  assert.equal(calculateMemoryReserveMb(306, 384), 1024)
  assert.equal(calculateMemoryReserveMb(null, 0), 1280)
  assert.equal(calculateMemoryReserveMb(1000, 512), 2048)
  assert.equal(calculateMemoryReserveMb(100, 1800), 2048)
  const pool = { ...emptyResourceSnapshot(), memoryCurrentMb: 2000, memoryMaxMb: 4901 }
  const host = buildHostResourceSnapshot({ source: 'native-host', verified: true, pool, panel: { ...emptyResourceSnapshot(), memoryPeakMb: 306 },
    meminfo: 'MemTotal: 6067224 kB\nMemAvailable: 1048576 kB\nSwapTotal: 2097152 kB\nSwapFree: 1048576 kB' })
  assert.equal(host.budget.state, 'protected')
  assert.equal(host.reserveMb, 1024)
  assert.equal(host.swapTotalMb, 2048)
  assert.equal(buildHostResourceSnapshot({ source: 'unknown', pool, verified: false }).budget.state, 'unavailable')
  assert.equal(buildHostResourceSnapshot({ ...host, source: 'native-host' }).budget.state, 'legacy')
})

it('actual cgroup readings distinguish unlimited and unknown; capped RAM plus swap is a demand lower bound', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-memory-cgroup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const group = path.join(root, 'pool', 'leaf')
  fs.mkdirSync(group, { recursive: true })
  for (const [name, text] of Object.entries({ 'memory.current': String(1536 * 1048576), 'memory.peak': String(1536 * 1048576), 'memory.max': String(1536 * 1048576), 'memory.high': 'max', 'memory.swap.current': String(958 * 1048576), 'memory.events.local': 'high 0\nmax 6000\noom_kill 8', 'memory.pressure': 'full avg10=83.55 avg60=2.0 total=10' })) fs.writeFileSync(path.join(group, name), text)
  const result = readCgroupMemory(root, '/pool/leaf')
  assert.equal(result.memoryAndSwapPeakMb, 2494)
  assert.equal(result.peakLimited, true)
  assert.equal(result.memoryHighState, 'unlimited')
  assert.equal(result.memoryPressureFullAvg10, 83.55)
  assert.equal(result.oomKilled, null, 'historical counter is not a current OOM verdict')
  assert.equal(readCgroupMemory(root, '/missing').memoryMaxState, 'unknown')
  assert.equal(cgroupPath(root, '/pool/../outside'), null)
})

it('admission checks host and pool separately, respects historical demand and zero override', () => {
  const previous = process.env.BSP_HOST_MIN_AVAILABLE_MB
  delete process.env.BSP_HOST_MIN_AVAILABLE_MB
  try {
    const reading = { availableMb: 4000, totalMb: 5925, swapFreeMb: 500, swapTotalMb: 2048, poolAvailableMb: 100 }
    assert.equal(assessHostMemoryForHeavyOperation('dst-container-start', { measuredDemandMb: 3000, memoryCapMb: 1536 }, reading).ok, false)
    assert.equal(assessHostMemoryForHeavyOperation('dst-container-start', { measuredDemandMb: 3000 }, { ...reading, poolAvailableMb: 3500 }).ok, true)
    process.env.BSP_HOST_MIN_AVAILABLE_MB = '0'
    assert.equal(assessHostMemoryForHeavyOperation('dst-container-start', { measuredDemandMb: 9000 }, reading).ok, true)
  }
  finally { if (previous === undefined) delete process.env.BSP_HOST_MIN_AVAILABLE_MB; else process.env.BSP_HOST_MIN_AVAILABLE_MB = previous }
})

it('concurrent consumers share a bounded resource sample', async () => {
  let calls = 0
  const runtime = { resourceSnapshot: async () => { calls++; return emptyResourceSnapshot() } } as unknown as ContainerRuntime
  const ref = { id: 'shared-sample', name: 'shared-sample' }
  await Promise.all([sampleRuntimeResources(runtime, ref), sampleRuntimeResources(runtime, ref)])
  assert.equal(calls, 1)
})
