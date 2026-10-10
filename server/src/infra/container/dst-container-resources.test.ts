import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  formatDstResourceLimitsForLog,
  resolveDstContainerResourceLimits,
  resolveInstanceResourceSettings,
  resolveRecommendedShardMemoryMb,
} from './dst-container-resources.ts'

describe('resolveDstContainerResourceLimits', () => {
  afterEach(() => {
    delete process.env.BSP_DST_CONTAINER_MEMORY_MB
    delete process.env.BSP_DST_CONTAINER_CPU_QUOTA
    delete process.env.BSP_SHARD_READY_WAIT_SEC
  })

  it('returns undefined when env unset', () => {
    assert.equal(resolveDstContainerResourceLimits(), undefined)
  })

  it('parses memory and cpu limits', () => {
    process.env.BSP_DST_CONTAINER_MEMORY_MB = '2048'
    process.env.BSP_DST_CONTAINER_CPU_QUOTA = '1.5'
    const limits = resolveDstContainerResourceLimits()
    assert.equal(limits?.memory, 2048 * 1024 * 1024)
    assert.equal(limits?.nanoCpus, 1_500_000_000)
    assert.match(formatDstResourceLimitsForLog(limits), /2048 MiB/)
    assert.match(formatDstResourceLimitsForLog(limits), /1.50 核/)
  })

  it('treats zero as unlimited', () => {
    process.env.BSP_DST_CONTAINER_MEMORY_MB = '0'
    assert.equal(resolveDstContainerResourceLimits(), undefined)
  })

  it('resolves inherited, explicit and unlimited settings independently per shard', () => {
    process.env.BSP_DST_CONTAINER_MEMORY_MB = '2560'
    process.env.BSP_DST_CONTAINER_CPU_QUOTA = '1.5'
    assert.deepEqual(resolveInstanceResourceSettings(null), { masterMemoryMb: 2560, cavesMemoryMb: 2560, shardReadyWaitSec: 300 })
    const settings = resolveInstanceResourceSettings({ masterMemoryMb: 3072, cavesMemoryMb: 0, shardReadyWaitSec: 450 })
    assert.deepEqual(settings, { masterMemoryMb: 3072, cavesMemoryMb: null, shardReadyWaitSec: 450 })
    assert.deepEqual(resolveDstContainerResourceLimits({ memory: 0 }), { memory: 0, nanoCpus: 1_500_000_000 })
    process.env.BSP_SHARD_READY_WAIT_SEC = '600'
    assert.equal(resolveInstanceResourceSettings().shardReadyWaitSec, 600)
  })

  it('recommends headroom above estimates and measured peaks rounded up to 256 MiB', () => {
    assert.equal(resolveRecommendedShardMemoryMb(40), 2560)
    assert.equal(resolveRecommendedShardMemoryMb(40, 3000), 3840)
    assert.equal(resolveRecommendedShardMemoryMb(100), 4608)
  })
})
