import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { build } from 'esbuild'
import { compileScript, parse } from 'vue/compiler-sfc'
import { createRenderer, h, KeepAlive, ref } from 'vue'
import type { ScheduleTaskItem } from '../../../../shared/contracts/schedule'

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

it('loads once on mount, polls running tasks only while active and visible, and ignores cancelled results', async (t) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.bsp-schedule-page-'))
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true })
  const globals = globalThis as typeof globalThis & { __bspSchedulePage?: unknown }
  const allowed = ref(true)
  const showing = ref(true)
  const requests: AbortSignal[] = []
  let instanceRequests = 0
  let slow = false
  let release: (() => void) | undefined
  let status: ScheduleTaskItem['lastRunStatus'] = 'running'
  globals.__bspSchedulePage = {
    allowed,
    api: { getScheduleList: async (_id: unknown, { signal }: { signal: AbortSignal }) => {
      requests.push(signal)
      const snapshot = status
      if (slow) await new Promise<void>(resolve => { release = resolve })
      return { data: [{ id: 'task', lastRunStatus: snapshot }] }
    } },
    instanceApi: { getInstanceOptions: async () => { instanceRequests++; return { data: [] } } },
  }
  let unmount: (() => void) | undefined
  t.after(() => {
    unmount?.()
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    delete globals.__bspSchedulePage
    assert.equal(path.dirname(root), process.cwd())
    fs.rmSync(root, { recursive: true, force: true })
  })
  const pageFile = path.join(root, 'page.mjs')
  await build({
    entryPoints: [path.resolve('src/views/ops/schedules/index.vue')],
    outfile: pageFile, bundle: true, platform: 'node', format: 'esm', external: ['vue'],
    alias: { '@': path.resolve('src') },
    banner: { js: 'const useAppAuth = () => ({ auth: () => globalThis.__bspSchedulePage.allowed.value }); const useAppSettingsStore = () => ({ mode: "pc" }); const useRoute = () => ({ query: {} }); const useRouter = () => ({});' },
    plugins: [{ name: 'schedule-page-fixture', setup(builder) {
      builder.onLoad({ filter: /index\.vue$/ }, args => {
        const { descriptor } = parse(fs.readFileSync(args.path, 'utf8'))
        const script = compileScript(descriptor, { id: 'schedule-polling', genDefaultAs: 'SchedulePage' })
        return { contents: `${script.content.replace('__expose();', '__expose({ get rows() { return rows.value }, get loading() { return loading.value } });')}\nSchedulePage.render = () => null; export default SchedulePage;`, loader: 'ts' }
      })
      builder.onResolve({ filter: /^(?:@\/api\/modules\/(?:schedule|instance)|naive-ui)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'naive-ui'
        ? 'export const NButton={},NDataTable={},NEmpty={},NForm={},NFormItem={},NInput={},NInputNumber={},NModal={},NSelect={},NSpace={},NSwitch={},NTag={},NTime={},NTimePicker={},NTooltip={}; export const useDialog=()=>({}); export const useNotification=()=>({});'
        : `export default globalThis.__bspSchedulePage.${args.path.endsWith('instance') ? 'instanceApi' : 'api'}`, loader: 'js' }))
    } }],
  })
  const { default: SchedulePage } = await import(pathToFileURL(pageFile).href)
  const page = ref<{ rows: ScheduleTaskItem[] }>()
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null })
  const app = renderer.createApp({ setup: () => () => h(KeepAlive, null, { default: () => showing.value ? h(SchedulePage, { ref: page }) : null }) })
  const visibility = (hidden: boolean) => {
    document.visibilityState = hidden ? 'hidden' : 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  app.mount({})
  unmount = () => app.unmount()
  await flush()
  assert.equal(requests.length, 1, 'mounted 与 activated 合并为一次加载')
  assert.equal(instanceRequests, 1)
  t.mock.timers.tick(4999)
  assert.equal(requests.length, 1)
  t.mock.timers.tick(1)
  await flush()
  assert.equal(requests.length, 2)
  visibility(true)
  t.mock.timers.tick(60_000)
  assert.equal(requests.length, 2)
  status = 'ok'
  visibility(false)
  await flush()
  assert.equal(requests.length, 3)
  assert.equal(page.value?.rows[0].lastRunStatus, 'ok')
  t.mock.timers.tick(60_000)
  assert.equal(requests.length, 3, '终态停止 5 秒轮询')

  showing.value = false
  await flush()
  status = 'running'
  showing.value = true
  await flush()
  assert.equal(requests.length, 4)
  slow = true
  status = 'failed'
  t.mock.timers.tick(5000)
  assert.equal(requests.length, 5)
  showing.value = false
  await flush()
  assert.equal(requests[4].aborted, true)
  release!()
  await flush()
  visibility(true)
  visibility(false)
  t.mock.timers.tick(60_000)
  assert.equal(requests.length, 5, '离开页面后不被可见性或迟到响应重启')
  slow = false
  status = 'ok'
  showing.value = true
  await flush()
  assert.equal(requests.length, 6)
  assert.equal(page.value?.rows[0].lastRunStatus, 'ok')
  allowed.value = false
  visibility(true)
  visibility(false)
  t.mock.timers.tick(60_000)
  assert.equal(requests.length, 6)
  allowed.value = true
  await flush()
  assert.equal(requests.length, 7)
  app.unmount()
  unmount = undefined
  visibility(true)
  visibility(false)
  t.mock.timers.tick(60_000)
  assert.equal(requests.length, 7)
})
