import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import axios from 'axios'
import { build } from 'esbuild'

it('the real API interceptor neither retries nor reports cancellation, but still reports network errors', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.bsp-api-cancel-'))
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = new Map(['faToast', 'useAppAccountStore'].map(key => [key, globals[key]]))
  let errors = 0
  let logouts = 0
  globals.faToast = { error: () => errors++, warning: () => errors++ }
  globals.useAppAccountStore = () => ({ isLogin: false, requestLogout: () => logouts++ })
  try {
    const modulePath = path.join(root, 'api.mjs')
    await build({
      entryPoints: [path.resolve('src/api/index.ts')], outfile: modulePath,
      bundle: true, platform: 'node', format: 'esm', external: ['axios'],
      define: { 'import.meta.env': JSON.stringify({ DEV: false, VITE_APP_API_BASEURL: 'http://127.0.0.1:1' }) },
      plugins: [{ name: 'router-fixture', setup(builder) {
        builder.onResolve({ filter: /^@\/router$/ }, () => ({ path: 'router', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default {currentRoute:{value:{name:"instance"}},replace:()=>{throw new Error("must not navigate")}}', loader: 'js' }))
      } }],
    })
    const { default: api } = await import(pathToFileURL(modulePath).href)
    let attempts = 0
    api.defaults.adapter = () => {
      attempts++
      return Promise.reject(new axios.CanceledError('page deactivated'))
    }
    await assert.rejects(api.post('/app/instance/metrics', {}, { retry: true }), error => axios.isCancel(error))
    assert.equal(attempts, 1)
    assert.equal(errors, 0)
    assert.equal(logouts, 0)
    api.defaults.adapter = () => Promise.reject(new axios.AxiosError('network unavailable'))
    await assert.rejects(api.post('/app/instance/metrics'), /network unavailable/)
    assert.equal(errors, 1)
  }
  finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key]
      else globals[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})
