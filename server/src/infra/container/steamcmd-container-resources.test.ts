import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatSteamcmdMemoryLimitForLog,
  resolveSteamcmdContainerMemoryLimits,
} from './steamcmd-container-resources.ts'

describe('resolveSteamcmdContainerMemoryLimits', () => {
  it('defaults app-update to unlimited when env unset', () => {
    const prev = process.env.BSP_STEAMCMD_CONTAINER_MEMORY_MB
    delete process.env.BSP_STEAMCMD_CONTAINER_MEMORY_MB
    delete process.env.BSP_STEAMCMD_CONTAINER_MEMORY_SWAP_MB
    assert.equal(resolveSteamcmdContainerMemoryLimits('app-update'), undefined)
    if (prev !== undefined) {
      process.env.BSP_STEAMCMD_CONTAINER_MEMORY_MB = prev
    }
  })

  it('applies explicit app-update cap', () => {
    process.env.BSP_STEAMCMD_CONTAINER_MEMORY_MB = '4096'
    const limits = resolveSteamcmdContainerMemoryLimits('app-update')
    delete process.env.BSP_STEAMCMD_CONTAINER_MEMORY_MB
    assert.ok(limits)
    assert.equal(limits!.Memory, 4096 * 1024 * 1024)
    assert.equal(limits!.MemorySwap, limits!.Memory)
  })

  it('returns undefined when memory limit set to 0', () => {
    process.env.BSP_STEAMCMD_CONTAINER_MEMORY_MB = '0'
    assert.equal(resolveSteamcmdContainerMemoryLimits('app-update'), undefined)
    delete process.env.BSP_STEAMCMD_CONTAINER_MEMORY_MB
  })
})

describe('formatSteamcmdMemoryLimitForLog', () => {
  it('formats GiB label', () => {
    const text = formatSteamcmdMemoryLimitForLog({
      Memory: 4 * 1024 * 1024 * 1024,
      MemorySwap: 4 * 1024 * 1024 * 1024,
    })
    assert.match(text, /4096 MiB/)
    assert.match(text, /硬上限/)
    assert.match(text, /非预留/)
  })
})
