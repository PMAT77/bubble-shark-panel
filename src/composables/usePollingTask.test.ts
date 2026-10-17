import assert from 'node:assert/strict'
import { it, type TestContext } from 'node:test'
import { effectScope } from 'vue'
import { usePollingTask, type PollingTaskOptions } from './usePollingTask'

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function fixture(t: TestContext, task: (signal: AbortSignal) => Promise<void>, options: PollingTaskOptions = {}, initiallyHidden = false) {
  const document = Object.assign(new EventTarget(), { visibilityState: initiallyHidden ? 'hidden' : 'visible' })
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true })
  const scope = effectScope()
  const poller = scope.run(() => usePollingTask(task, options))!
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => {
    scope.stop()
    if (previous) Object.defineProperty(globalThis, 'document', previous)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  return {
    poller, scope,
    visibility(hidden: boolean) {
      document.visibilityState = hidden ? 'hidden' : 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
    },
  }
}

it('queries immediately, waits 30 seconds after completion and keeps one timer on refresh', async (t) => {
  let calls = 0
  const { poller } = fixture(t, async () => { calls++ }, { intervalMs: 30_000 })
  poller.start()
  poller.start()
  await flush()
  assert.equal(calls, 1)
  t.mock.timers.tick(29_999)
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(calls, 2)
  await poller.refresh()
  assert.equal(calls, 3)
  t.mock.timers.tick(30_000)
  await flush()
  assert.equal(calls, 4)
})

it('starts hidden without requests, resumes immediately and cannot revive stopped or disposed tasks', async (t) => {
  let calls = 0
  const { poller, scope, visibility } = fixture(t, async () => { calls++ }, {
    intervalMs: 5000, immediate: false, pauseWhenHidden: true,
  }, true)
  poller.start()
  t.mock.timers.tick(60_000)
  assert.equal(calls, 0)
  visibility(false)
  await flush()
  assert.equal(calls, 1, '恢复可见时不受 immediate:false 的延迟影响')
  visibility(true)
  t.mock.timers.tick(60_000)
  assert.equal(calls, 1)
  visibility(false)
  await flush()
  assert.equal(calls, 2)
  poller.stop()
  visibility(true)
  visibility(false)
  t.mock.timers.tick(60_000)
  assert.equal(calls, 2)
  poller.start()
  t.mock.timers.tick(5000)
  await flush()
  assert.equal(calls, 3)
  scope.stop()
  visibility(true)
  visibility(false)
  poller.start()
  await poller.refresh()
  t.mock.timers.tick(60_000)
  assert.equal(calls, 3)
})

it('waits for a cancelled slow request, discards its result and resumes without overlapping', async (t) => {
  const requests: { signal: AbortSignal, resolve: () => void }[] = []
  const committed: number[] = []
  const { poller, visibility } = fixture(t, async (signal) => {
    const index = requests.length
    await new Promise<void>(resolve => requests.push({ signal, resolve }))
    signal.throwIfAborted()
    committed.push(index)
  }, { pauseWhenHidden: true })
  poller.start()
  await poller.refresh()
  t.mock.timers.tick(60_000)
  assert.equal(requests.length, 1)
  visibility(true)
  assert.equal(requests[0].signal.aborted, true)
  visibility(false)
  visibility(true)
  visibility(false)
  assert.equal(requests.length, 1)
  requests[0].resolve()
  await flush()
  assert.deepEqual(committed, [])
  assert.equal(poller.error.value, null, '取消不计为轮询失败')
  assert.equal(requests.length, 2)
  requests[1].resolve()
  await flush()
  assert.deepEqual(committed, [1])
  t.mock.timers.tick(5000)
  assert.equal(requests.length, 3)
  poller.stop()
  requests[2].resolve()
  await flush()
  t.mock.timers.tick(60_000)
  assert.deepEqual(committed, [1])
  assert.equal(requests.length, 3)
})

it('keeps default delayed polling in hidden tabs and retries real errors', async (t) => {
  let calls = 0
  const { poller, visibility } = fixture(t, async () => {
    calls++
    if (calls === 1) throw new Error('offline')
  }, { immediate: false }, true)
  poller.start()
  assert.equal(calls, 0)
  t.mock.timers.tick(5000)
  await flush()
  assert.equal(calls, 1)
  assert.equal(poller.error.value, 'offline')
  visibility(false)
  assert.equal(calls, 1, '未启用可见性暂停时不增加恢复查询')
  t.mock.timers.tick(5000)
  await flush()
  assert.equal(calls, 2)
  assert.equal(poller.error.value, null)
})
