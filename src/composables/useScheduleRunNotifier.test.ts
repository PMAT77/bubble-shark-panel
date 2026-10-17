import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { build } from 'esbuild'
import { createRenderer, ref } from 'vue'
import type { ScheduleTaskItem } from '../../shared/contracts/schedule'

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

it('gates notifications by permission and visibility, catches up once and retains the failure limit', async (t) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.bsp-schedule-polling-'))
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true })
  const globals = globalThis as typeof globalThis & { __bspScheduleFixture?: unknown }
  const allowed = ref(false)
  const notices: object[] = []
  const requests: AbortSignal[] = []
  let fail = false
  let release: (() => void) | undefined
  let slow = false
  let task = { id: 'task', instanceId: 'instance', kind: 'backup', lastRunAt: 'historical', lastRunStatus: 'ok' } as ScheduleTaskItem
  globals.__bspScheduleFixture = {
    allowed,
    notification: Object.fromEntries(['success', 'error', 'warning', 'info'].map(kind => [kind, (notice: object) => notices.push(notice)])),
    api: {
      getScheduleList: async (_id: unknown, { signal }: { signal: AbortSignal }) => {
        requests.push(signal)
        if (fail) throw new Error('offline')
        const snapshot = structuredClone(task)
        if (slow) await new Promise<void>(resolve => { release = resolve })
        return { data: [snapshot] }
      },
    },
    instanceApi: { getInstanceOptions: async () => ({ data: [{ id: 'instance', name: '测试实例' }] }) },
  }
  let unmount: (() => void) | undefined
  t.after(() => {
    unmount?.()
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    delete globals.__bspScheduleFixture
    assert.equal(path.dirname(root), process.cwd())
    fs.rmSync(root, { recursive: true, force: true })
  })
  const hookFile = path.join(root, 'hook.mjs')
  await build({
    entryPoints: [path.resolve('src/composables/useScheduleRunNotifier.ts')],
    outfile: hookFile, bundle: true, platform: 'node', format: 'esm', external: ['vue'],
    alias: { '@': path.resolve('src') },
    banner: { js: 'const useAppAuth = () => ({ auth: () => globalThis.__bspScheduleFixture.allowed.value }); const useRouter = () => ({ resolve: () => ({ href: "/tasks" }), push() {} });' },
    plugins: [{ name: 'schedule-fixture', setup(builder) {
      builder.onResolve({ filter: /^(?:@\/api\/modules\/(?:schedule|instance)|naive-ui)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'naive-ui'
        ? 'export const useNotification = () => globalThis.__bspScheduleFixture.notification'
        : `export default globalThis.__bspScheduleFixture.${args.path.endsWith('instance') ? 'instanceApi' : 'api'}`, loader: 'js' }))
    } }],
  })
  const { useScheduleRunNotifier, suppressScheduleRunNotificationOnce } = await import(pathToFileURL(hookFile).href) as typeof import('./useScheduleRunNotifier')
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
  const mount = () => {
    const app = renderer.createApp({ setup() { useScheduleRunNotifier(); return () => null } })
    app.mount({})
    unmount = () => app.unmount()
  }
  const visibility = (hidden: boolean) => {
    document.visibilityState = hidden ? 'hidden' : 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  mount()
  await flush()
  assert.equal(requests.length, 0, '无查看权限不查询')
  allowed.value = true
  await flush()
  assert.equal(requests.length, 1)
  assert.equal(notices.length, 0, '首次查询不通知历史执行')
  t.mock.timers.tick(29_999)
  assert.equal(requests.length, 1)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(requests.length, 2)
  visibility(true)
  task = { ...task, lastRunAt: 'latest' }
  t.mock.timers.tick(90_000)
  assert.equal(requests.length, 2)
  visibility(false)
  await flush()
  assert.equal(requests.length, 3)
  assert.equal(notices.length, 1, '返回后补发最新执行一次')
  suppressScheduleRunNotificationOnce(task.id)
  task = { ...task, lastRunAt: 'manual' }
  t.mock.timers.tick(30_000)
  await flush()
  assert.equal(notices.length, 1, '手动执行保持通知抑制')
  t.mock.timers.tick(30_000)
  await flush()
  assert.equal(notices.length, 1, '同一次执行不重复通知')

  slow = true
  task = { ...task, lastRunAt: 'cancelled' }
  t.mock.timers.tick(30_000)
  allowed.value = false
  assert.equal(requests.at(-1)?.aborted, true)
  release!()
  await flush()
  visibility(true)
  visibility(false)
  t.mock.timers.tick(60_000)
  assert.equal(notices.length, 1, '权限丢失后忽略迟到结果')
  const beforeResume = requests.length
  slow = false
  allowed.value = true
  await flush()
  assert.equal(requests.length, beforeResume + 1)
  assert.equal(notices.length, 2)

  slow = true
  t.mock.timers.tick(30_000)
  const beforeCancellations = requests.length
  for (let i = 0; i < 5; i++) {
    visibility(true)
    assert.equal(requests.at(-1)?.aborted, true)
    release!()
    await flush()
    visibility(false)
    await flush()
  }
  assert.equal(requests.length, beforeCancellations + 5, '连续取消不消耗失败次数')
  slow = false
  release!()
  await flush()

  fail = true
  const beforeFailures = requests.length
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(30_000)
    await flush()
    assert.equal(requests.length, beforeFailures + 1 + i)
  }
  const stoppedAt = requests.length
  visibility(true)
  visibility(false)
  t.mock.timers.tick(90_000)
  assert.equal(requests.length, stoppedAt, '可见性切换不绕过失败停止状态')
  fail = false
  allowed.value = false
  allowed.value = true
  await flush()
  assert.equal(requests.length, stoppedAt + 1, '恢复权限可以重启')
  unmount!()
  unmount = undefined
  mount()
  await flush()
  assert.equal(requests.length, stoppedAt + 2, '重新挂载可以重启')
  const beforeUnmount = requests.length
  unmount!()
  unmount = undefined
  visibility(true)
  visibility(false)
  t.mock.timers.tick(90_000)
  assert.equal(requests.length, beforeUnmount)
})
