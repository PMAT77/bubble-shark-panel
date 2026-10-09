import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS = '0'

const { isSteamcmdAppUpdateQueued, withSteamcmdAppUpdateLock } = await import('./steamcmd-app-update-queue.ts')

describe('withSteamcmdAppUpdateLock', () => {
  it('cancels a queued job immediately without releasing the active job', async () => {
    let release!: () => void
    const first = withSteamcmdAppUpdateLock('active', () => new Promise<void>(resolve => { release = resolve }))
    await Promise.resolve()
    const controller = new AbortController()
    const cancelled = withSteamcmdAppUpdateLock('cancelled', async () => assert.fail('cancelled body ran'), { signal: controller.signal })
    const rejection = assert.rejects(cancelled, /cancel queued/)
    controller.abort(new Error('cancel queued'))
    await rejection
    let lastRan = false
    const last = withSteamcmdAppUpdateLock('last', async () => { lastRan = true })
    await Promise.resolve()
    assert.equal(lastRan, false)
    release()
    await Promise.all([first, last])
  })
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

for (const mode of ['sync', 'async', 'body']) {
  it('releases ' + mode + ' failure without overtaking the preceding job', async () => {
    const { isSteamcmdAppUpdateBusy } = await import('./steamcmd-app-update-queue.ts')
    const order: string[] = []
    let release!: () => void
    const first = withSteamcmdAppUpdateLock('first', async () => {
      order.push('first')
      await new Promise<void>(resolve => { release = resolve })
      order.push('first finished')
    })
    await Promise.resolve()
    const failed = withSteamcmdAppUpdateLock('failed', async () => {
      throw new Error('body failed')
    }, { onQueued: () => {
      if (mode === 'sync') throw new Error('sync failed')
      if (mode === 'async') return Promise.reject(new Error('async failed'))
    } })
    const rejected = assert.rejects(failed, /failed/)
    const last = withSteamcmdAppUpdateLock('last', async () => { order.push('last') })
    await Promise.resolve()
    assert.deepEqual(order, ['first'])
    release()
    await Promise.all([first, rejected, last])
    assert.deepEqual(order, ['first', 'first finished', 'last'])
    assert.equal(isSteamcmdAppUpdateBusy(), false)
    assert.equal(isSteamcmdAppUpdateQueued(), false)
  })
}
