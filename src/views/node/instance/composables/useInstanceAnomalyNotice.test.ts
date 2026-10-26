import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { build } from 'esbuild'
import { createRenderer, nextTick, ref } from 'vue'
import type { NotificationOptions } from 'naive-ui'
import type { InstanceItem, InstanceStartupSnapshot } from '@/api/modules/instance'

it('异常通知生命周期与启动失败接管', async (t) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.bsp-anomaly-notice-'))
  const fixture = globalThis as typeof globalThis & { __bspAnomalyFixture?: unknown }
  const notifications: Array<NotificationOptions & { destroyed: boolean, destroy: () => void }> = []
  const toasts: unknown[][] = []
  let response: InstanceStartupSnapshot
  const notify = (options: NotificationOptions) => {
    const notice = { ...options, destroyed: false, destroy() { this.destroyed = true; options.onAfterLeave?.() } }
    notifications.push(notice)
    return notice
  }
  fixture.__bspAnomalyFixture = {
    notification: { error: notify, warning: notify },
    toast: { error: (...args: unknown[]) => toasts.push(args), success: () => {} },
    api: { getInstanceStartup: async () => ({ data: response }) },
  }
  const renderer = createRenderer({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const apps: Array<{ unmount: () => void }> = []
  try {
    const output = path.join(root, 'hooks.mjs')
    await build({
      stdin: { contents: `export * from './src/views/node/instance/composables/useInstanceAnomalyNotice'; export * from './src/views/node/instance/composables/useInstanceStartup'`, resolveDir: process.cwd(), loader: 'ts' },
      outfile: output, bundle: true, platform: 'node', format: 'esm', external: ['vue'],
      banner: { js: 'const faToast = globalThis.__bspAnomalyFixture.toast;' },
      plugins: [{ name: 'notification-fixture', setup(builder) {
        builder.onResolve({ filter: /^(naive-ui|@\/api\/modules\/instance|@\/utils\/hostMemoryPressure)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'naive-ui'
          ? 'export const NButton = {}; export const useNotification = () => globalThis.__bspAnomalyFixture.notification'
          : args.path.includes('hostMemoryPressure') ? 'export const showStartupSwapNotification = () => {}'
            : 'export default globalThis.__bspAnomalyFixture.api' }))
      } }],
    })
    const hooks = await import(pathToFileURL(output).href) as typeof import('./useInstanceAnomalyNotice') & typeof import('./useInstanceStartup')
    const item = ref({ id: 'one', name: '测试房间', status: 'error', runtimeWarning: '等待主世界就绪超时', lastError: '主世界启动失败：等待主世界就绪超时' } as InstanceItem)
    const active = ref(false)
    let hook!: ReturnType<typeof hooks.useInstanceAnomalyNotice>
    const app = renderer.createApp({ setup() { hook = hooks.useInstanceAnomalyNotice(item, active); return () => null } })
    apps.push(app)
    app.mount({})
    await nextTick()
    await t.test('未激活不弹出；激活后只有一条通知且配置自动收起与悬停暂停', async () => {
      assert.equal(notifications.length, 0)
      active.value = true
      await nextTick()
      assert.equal(notifications.length, 1)
      assert.equal(notifications[0].duration, 8000)
      assert.equal(notifications[0].keepAliveOnHover, true)
      assert.equal(notifications[0].closable, true)
      assert.equal(hook.anomalies.value.length, 1)
    })
    await t.test('通知关闭后仍能查看详情，轮询和返回页面不再自动弹出', async () => {
      notifications[0].destroy()
      hook.showDetails()
      assert.equal(hook.detailsVisible.value, true)
      item.value = { ...item.value }
      await nextTick()
      assert.equal(notifications.length, 1)
      active.value = false
      await nextTick()
      assert.equal(hook.detailsVisible.value, false)
      item.value = { ...item.value }
      await nextTick()
      active.value = true
      await nextTick()
      assert.equal(notifications.length, 1)
    })
    await t.test('解除后再次发生会提醒；切换实例关闭旧详情与通知', async () => {
      const failed = item.value
      item.value = { ...item.value, status: 'running', runtimeWarning: null, lastError: null }
      await nextTick()
      assert.equal(hook.anomalies.value.length, 0)
      item.value = failed
      await nextTick()
      assert.equal(notifications.length, 2)
      hook.showDetails()
      item.value = { ...failed, id: 'two', name: '另一个房间' }
      await nextTick()
      assert.equal(hook.detailsVisible.value, false)
      assert.equal(notifications.length, 3)
      const action = notifications[2].action as () => { props: { onClick: () => void } }
      action().props.onClick()
      assert.equal(hook.detailsVisible.value, true)
      assert.equal(notifications[2].destroyed, true)
    })
    await t.test('带着上轮错误开始新任务不弹异常，本轮真正失败才提醒', async () => {
      const before = notifications.length
      const initial = { taskId: 'retry-task', status: 'queued', master: { state: 'pending' }, caves: { state: 'pending' }, diagnosis: null } as InstanceStartupSnapshot
      item.value = { ...item.value, startup: initial }
      await nextTick()
      assert.equal(notifications.length, before)
      assert.equal(hook.anomalies.value.length, 0)
      assert.equal(hook.detailsVisible.value, false)
      item.value = { ...item.value, startup: { ...initial, status: 'running', master: { state: 'loading', memoryPeakMb: null } } }
      await nextTick()
      assert.equal(notifications.length, before)
      assert.equal(hook.anomalies.value.length, 0)
      item.value = { ...item.value, runtimeWarning: null, lastError: '主世界启动失败：本轮进程退出', startup: {
        ...initial, status: 'failed', master: { state: 'failed', memoryPeakMb: null, diagnosis: { code: 'exit', message: '本轮进程退出' } },
        diagnosis: { code: 'exit', message: '本轮进程退出' },
      } }
      await nextTick()
      assert.equal(notifications.length, before + 1)
      assert.deepEqual(hook.anomalies.value, [{ reason: '本轮进程退出', world: 'master' }])
    })
    await t.test('长版本错误只在主动查看的详情中保留，自动通知使用简短提示', async () => {
      const raw = `SteamCMD 版本查询失败：${'Update complete, launching Steamcmd...\n'.repeat(60)}ERROR! Timeout`
      item.value = { ...item.value, startup: null, lastError: null, runtimeWarning: null, updateCheckError: raw }
      await nextTick()
      assert.equal(notifications.at(-1)?.content, '请查看异常详情了解原因')
      assert.deepEqual(hook.anomalies.value, [{ reason: raw, world: null }])
      assert.equal(hook.detailsVisible.value, false)
      hook.showDetails()
      assert.equal(hook.detailsVisible.value, true)
      item.value = { ...item.value, updateCheckError: null }
      await nextTick()
      assert.equal(hook.detailsVisible.value, false)
    })
    await t.test('停止页面通知，列表默认失败提示保留、详情接管不重复弹失败提示', async () => {
      active.value = false
      await nextTick()
      for (const notifyFailure of [undefined, false]) {
        const taskId = `task-${String(notifyFailure)}`
        const initial = { taskId, status: 'running', startedAt: '2026-10-11T10:00:00Z', updatedAt: '2026-10-11T10:00:00Z', master: { state: 'loading' }, caves: { state: 'stopped' } } as InstanceStartupSnapshot
        response = { ...initial, status: 'failed', master: { state: 'failed', memoryPeakMb: null }, diagnosis: { code: 'timeout', message: '启动超时' } }
        const instances = ref([{ id: `startup-${taskId}`, name: '启动房间', status: 'running', startup: initial } as InstanceItem])
        let polling!: ReturnType<typeof hooks.useInstanceStartup>
        const pollingApp = renderer.createApp({ setup() {
          polling = hooks.useInstanceStartup(instances, (_id, snapshot) => { instances.value = [{ ...instances.value[0], startup: snapshot }] }, undefined, { notifyFailure })
          return () => null
        } })
        apps.push(pollingApp)
        pollingApp.mount({})
        hooks.trackStartupAccepted(instances.value[0].id, 0, taskId)
        const before = toasts.length
        polling.syncStartupPolling()
        for (let i = 0; i < 8; i++) await nextTick()
        polling.stopStartupPolling()
        assert.equal(toasts.length - before, notifyFailure === false ? 0 : 1)
      }
    })
  }
  finally {
    for (const app of apps) app.unmount()
    delete fixture.__bspAnomalyFixture
    fs.rmSync(root, { recursive: true, force: true })
  }
})
