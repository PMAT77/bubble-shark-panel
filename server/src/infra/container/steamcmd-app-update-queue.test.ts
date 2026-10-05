import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS = '0'

const { isSteamcmdAppUpdateQueued, withSteamcmdAppUpdateLock } = await import('./steamcmd-app-update-queue.ts')

describe('withSteamcmdAppUpdateLock', () => {
  it('invokes onQueued when a second job must wait for the lock', async () => {
    let queued = 0
    const first = withSteamcmdAppUpdateLock('1', async () => {
      await new Promise(resolve => setTimeout(resolve, 40))
    })
    const second = withSteamcmdAppUpdateLock('2', async () => {}, {
      onQueued: async () => {
        queued++
      },
    })
    await Promise.all([first, second])
    assert.equal(queued, 1)
    assert.equal(isSteamcmdAppUpdateQueued(), false)
  })

  it('runs jobs sequentially not in parallel', async () => {
    const order: number[] = []
    const delay = (ms: number, id: number) => withSteamcmdAppUpdateLock(String(id), async () => {
      order.push(id)
      await new Promise(resolve => setTimeout(resolve, ms))
      order.push(-id)
    })

    await Promise.all([delay(30, 1), delay(10, 2)])
    assert.deepEqual(order, [1, -1, 2, -2])
  })
})
