import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  formatDstResourceLimitsForLog,
  resolveDstContainerResourceLimits,
} from './dst-container-resources.ts'

describe('resolveDstContainerResourceLimits', () => {
  afterEach(() => {
    delete process.env.BSP_DST_CONTAINER_MEMORY_MB
    delete process.env.BSP_DST_CONTAINER_CPU_QUOTA
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
})
