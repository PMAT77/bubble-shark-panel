import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { build } from 'esbuild'
import { createRenderer } from 'vue'
import { worldMaintenancePayloadSchema, type WorldMaintenanceOperation, type WorldMaintenancePayload } from '../../shared/contracts/world-maintenance.ts'

it('world maintenance submits over HTTP and recovers from local and request failures', async (t) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.bsp-world-maintenance-'))
  const fixture = globalThis as typeof globalThis & { __bspMaintenanceFixture?: unknown }
  const httpCrypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }
  let browserCrypto: typeof httpCrypto | undefined = httpCrypto
  t.mock.getter(globalThis, 'crypto', () => browserCrypto)
  const requests: WorldMaintenancePayload[] = []
  const notices: unknown[][] = []
  let current: WorldMaintenanceOperation | null = null
  let requestFailure = false
  let nextState: WorldMaintenanceOperation['state'] = 'completed'
  fixture.__bspMaintenanceFixture = {
    toast: { error: (...args: unknown[]) => notices.push(args) },
    api: {
      status: async () => ({ data: current }),
      begin: async (payload: WorldMaintenancePayload) => {
        requests.push(worldMaintenancePayloadSchema.parse(payload))
        if (requestFailure) throw new Error('Request failed')
        current = { id: payload.requestId, state: nextState } as WorldMaintenanceOperation
        return { data: current }
      },
      continue: async (_instanceId: string, operationId: string, withoutBackup: boolean) => {
        assert.equal(operationId, current?.id)
        assert.equal(withoutBackup, false)
        current = { ...current, state: 'cancelled' } as WorldMaintenanceOperation
        return { data: current }
      },
    },
  }
  let unmount: (() => void) | undefined
  try {
    const hookFile = path.join(root, 'hook.mjs')
    await build({
      entryPoints: [path.resolve('src/composables/useWorldMaintenance.ts')],
      outfile: hookFile, bundle: true, platform: 'node', format: 'esm', external: ['vue'],
      banner: { js: 'const faToast = globalThis.__bspMaintenanceFixture.toast;' },
      plugins: [{ name: 'maintenance-fixture', setup(builder) {
        builder.onResolve({ filter: /^@\/api\/modules\/world-maintenance$/ }, () => ({ path: 'fixture', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default globalThis.__bspMaintenanceFixture.api', loader: 'js' }))
      } }],
    })
    const { useWorldMaintenance } = await import(pathToFileURL(hookFile).href) as typeof import('./useWorldMaintenance.ts')
    let hook!: ReturnType<typeof useWorldMaintenance>
    // Mount the real hook so its polling and unmount cleanup run normally, without a DOM dependency.
    const renderer = createRenderer({
      createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
      insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
      parentNode: () => null, nextSibling: () => null,
    })
    const app = renderer.createApp({ setup() {
      hook = useWorldMaintenance('fixture')
      return () => null
    } })
    app.mount({})
    unmount = () => app.unmount()
    await Promise.resolve()

    await t.test('reset submits once and preserves the backup confirmation state', async () => {
      nextState = 'awaiting_confirmation'
      const pending = hook.submit({ action: 'reset', confirmName: '测试房间' }, 'reset')
      await hook.submit({ action: 'reset', confirmName: '测试房间' }, 'reset')
      await pending
      assert.equal(requests.length, 1)
      assert.equal(requests[0].backupBefore, true)
      assert.equal(hook.operation.value?.state, 'awaiting_confirmation')
      assert.equal(hook.busy.value, true)
      assert.equal(hook.submitting.value, false)
      await hook.continueWithoutBackup(false)
      assert.equal(hook.operation.value?.state, 'cancelled')
      assert.equal(hook.busy.value, false)
      assert.equal(notices.length, 0)
    })

    await t.test('save, rollback and shard regeneration use the same HTTP fallback', async () => {
      nextState = 'completed'
      hook.backupBefore.value = false
      await hook.submit({ action: 'save' }, 'save')
      await hook.submit({ action: 'rollback', sessionId: '1111111111111111', snapshotId: 1 }, 'rollback')
      await hook.submit({ action: 'regenerate', confirmName: '测试房间', shard: 'master', worldSeed: '42' }, 'regenerate')
      assert.deepEqual(requests.map(request => request.action), ['reset', 'save', 'rollback', 'regenerate'])
      assert.equal(new Set(requests.map(request => request.requestId)).size, requests.length)
      assert.equal(requests[3].backupBefore, false)
    })

    await t.test('ID failures show feedback without blocking another attempt', async () => {
      browserCrypto = undefined
      await hook.submit({ action: 'reset', confirmName: '测试房间' }, 'reset')
      assert.equal(requests.length, 4)
      assert.equal(notices.length, 1)
      assert.equal(notices[0][0], '无法发起世界维护')
      assert.equal(hook.submitting.value, false)
      assert.equal(hook.busy.value, false)
      assert.equal(hook.activeKey.value, null)
      browserCrypto = httpCrypto
      await hook.submit({ action: 'reset', confirmName: '测试房间' }, 'reset')
      assert.equal(requests.length, 5)
    })

    await t.test('API failures release the button without duplicating the API error toast', async () => {
      requestFailure = true
      await hook.submit({ action: 'reset', confirmName: '测试房间' }, 'reset')
      assert.equal(requests.length, 6)
      assert.equal(notices.length, 1)
      assert.equal(hook.submitting.value, false)
      assert.equal(hook.busy.value, false)
      assert.equal(hook.activeKey.value, null)
    })
  }
  finally {
    unmount?.()
    delete fixture.__bspMaintenanceFixture
    fs.rmSync(root, { recursive: true, force: true })
  }
})
