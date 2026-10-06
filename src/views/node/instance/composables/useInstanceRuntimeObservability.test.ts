import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { build } from 'esbuild'
import { effectScope, ref } from 'vue'

it('inactive observability stays stopped after instance changes and reactivation discards old results', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.bsp-observability-'))
  const calls: { signal: AbortSignal, resolve: (value: unknown) => void }[] = []
  const hookFile = path.join(root, 'hook.mjs')
  const fixture = globalThis as typeof globalThis & { __bspMetricsFixture?: unknown }
  fixture.__bspMetricsFixture = {
    getInstanceMetrics: (_ids: string[], { signal }: { signal: AbortSignal }) => new Promise(resolve => calls.push({ signal, resolve })),
  }
  const scope = effectScope()
  try {
    await build({
      entryPoints: [path.resolve('src/views/node/instance/composables/useInstanceRuntimeObservability.ts')],
      outfile: hookFile, bundle: true, platform: 'node', format: 'esm', external: ['vue'],
      plugins: [{ name: 'metrics-fixture', setup(builder) {
        builder.onResolve({ filter: /^@\/api\/modules\/instance$/ }, () => ({ path: 'fixture', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default globalThis.__bspMetricsFixture', loader: 'js' }))
      } }],
    })
    const { useInstanceRuntimeObservability } = await import(pathToFileURL(hookFile).href)
    const instances = ref([{ id: 'one', status: 'running' }])
    const hook = scope.run(() => useInstanceRuntimeObservability(instances))
    hook.syncRuntimeObservabilityPolling()
    assert.equal(calls.length, 1)
    hook.stopRuntimeObservability()
    assert.equal(calls[0].signal.aborted, true)
    instances.value = [{ id: 'two', status: 'running' }]
    assert.equal(calls.length, 1)
    hook.syncRuntimeObservabilityPolling()
    calls[0].resolve({ data: { items: { one: { memoryMb: 999 } } } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(hook.getMetricsForInstance('one'), null)
    assert.equal(calls.length, 2)
    calls[1].resolve({ data: { items: { two: { memoryMb: 123 } } } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(hook.getMetricsForInstance('two').memoryMb, 123)
    hook.stopRuntimeObservability()
  }
  finally {
    scope.stop()
    delete fixture.__bspMetricsFixture
    fs.rmSync(root, { recursive: true, force: true })
  }
})
