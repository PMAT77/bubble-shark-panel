import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createRenderer, nextTick, ref } from 'vue'
import { useTaskRowProgress, type TaskRowProgress } from './useTaskRowProgress'

it('tracks observed attempts, resets retries, pauses failures and cleans success timers', async t => {
  const globals = { document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {} }
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  t.after(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) } })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const tasks = ref<TaskRowProgress[]>([{ id: '1', taskId: 'history', percent: 100, state: 'success' }])
  let hook!: ReturnType<typeof useTaskRowProgress>
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
  const app = renderer.createApp({ setup() { hook = useTaskRowProgress(tasks); return () => null } })
  app.mount({})
  try {
    assert.deepEqual(hook.rowProps('1'), {})
    tasks.value = [{ id: '1', taskId: 'current', percent: null, state: 'active' }]
    await nextTick()
    assert.equal(hook.rowProps('1').style?.['--task-progress-ratio'], '0')
    tasks.value[0]!.percent = 50
    await nextTick()
    assert.equal(hook.rowProps('1').style?.['--task-progress-ratio'], '0.5')
    tasks.value[0]!.state = 'failed'
    await nextTick()
    assert.match(hook.rowProps('1').class!, /task-progress-paused/)
    tasks.value = [{ id: '1', taskId: 'retry', percent: 2, state: 'active' }]
    await nextTick()
    assert.equal(hook.rowProps('1').style?.['--task-progress-ratio'], '0.02')
    tasks.value[0]!.state = 'success'
    await nextTick()
    assert.match(hook.rowProps('1').class!, /task-progress-finishing/)
    t.mock.timers.tick(900)
    assert.match(hook.rowProps('1').class!, /task-progress-fading/)
    hook.reset()
    tasks.value = [{ id: '1', taskId: 'next-instance', percent: 20, state: 'active' }]
    await nextTick()
    t.mock.timers.tick(250)
    assert.equal(hook.rowProps('1').style?.['--task-progress-ratio'], '0.2')
  }
  finally { app.unmount() }
  t.mock.timers.tick(2000)
  assert.deepEqual(hook.rowProps('1'), {})
})
