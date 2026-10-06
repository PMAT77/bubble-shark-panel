import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createRuntimeMetricsPoller } from './runtimeMetricsPoller'

it('never overlaps slow requests and discards a stopped generation before restarting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const requests: { signal: AbortSignal, resolve: (value: number) => void }[] = []
  const committed: number[] = []
  const poller = createRuntimeMetricsPoller({
    request: signal => new Promise<number>(resolve => requests.push({ signal, resolve })),
    commit: value => committed.push(value),
    onError: () => assert.fail('unexpected error'),
  })
  t.after(() => poller.stop())
  poller.start()
  t.mock.timers.tick(20000)
  assert.equal(requests.length, 1)
  const merged = poller.refresh()
  poller.stop()
  assert.equal(requests[0].signal.aborted, true)
  poller.start()
  assert.equal(requests.length, 1)
  requests[0].resolve(1)
  await merged
  await Promise.resolve()
  assert.deepEqual(committed, [])
  assert.equal(requests.length, 2)
  requests[1].resolve(2)
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(committed, [2])
  t.mock.timers.tick(4999)
  assert.equal(requests.length, 2)
  t.mock.timers.tick(1)
  assert.equal(requests.length, 3)
  poller.stop()
  requests[2].resolve(3)
  await Promise.resolve()
  assert.deepEqual(committed, [2])
})
