import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import axios from 'axios'
import { build } from 'esbuild'

it('startup requests use short timeouts; refresh network errors preserve the session and a valid refresh retries once', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.agent-auth-'))
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = new Map(['faToast', 'useAppAccountStore'].map(key => [key, globals[key]]))
  let logouts = 0
  const account = {
    isLogin: true, token: 'expired-token', refreshToken: 'valid-refresh',
    requestLogout: () => { logouts++; account.isLogin = false },
    applySessionTokens: (tokens: { token: string, refreshToken: string }) => Object.assign(account, tokens),
  }
  globals.faToast = { error: () => {}, warning: () => {} }
  globals.useAppAccountStore = () => account
  try {
    const modulePath = path.join(root, 'api.mjs')
    await build({
      stdin: { contents: 'export {default as api} from "./src/api/index.ts"; export {default as app} from "./src/api/modules/app.ts"', resolveDir: process.cwd(), loader: 'ts' },
      outfile: modulePath, bundle: true, platform: 'node', format: 'esm', external: ['axios'],
      define: { 'import.meta.env': JSON.stringify({ DEV: false, VITE_APP_API_BASEURL: '/' }) },
      plugins: [{ name: 'router-fixture', setup(builder) {
        builder.onResolve({ filter: /^@\/router$/ }, () => ({ path: 'router', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default {currentRoute:{value:{name:"instance"}}}', loader: 'js' }))
      } }],
    })
    const { api, app } = await import(pathToFileURL(modulePath).href)
    let refreshes = 0
    api.defaults.adapter = async (config: { url: string, timeout: number, skipAuthRefresh?: boolean }) => {
      assert.equal(config.timeout, 15_000)
      if (config.url.endsWith('token/refresh')) {
        refreshes++
        throw new axios.AxiosError('refresh timed out', 'ECONNABORTED', config)
      }
      return { status: 200, statusText: 'OK', headers: {}, config, data: { status: 0, code: 'AUTH_UNAUTHORIZED', data: {} } }
    }
    await assert.rejects(app.permission(), /refresh timed out/)
    assert.equal(refreshes, 1)
    assert.equal(logouts, 0)
    assert.equal(account.isLogin, true)
    let protectedRequests = 0
    api.defaults.adapter = async (config: { url: string, timeout: number, skipAuthRefresh?: boolean }) => {
      assert.equal(config.timeout, 15_000)
      let data
      if (config.url.endsWith('token/refresh')) {
        refreshes++
        data = { status: 1, data: { token: 'new-token', refreshToken: 'new-refresh' } }
      }
      else {
        protectedRequests++
        data = config.skipAuthRefresh ? { status: 1, data: [] } : { status: 0, code: 'AUTH_UNAUTHORIZED', data: {} }
      }
      return { status: 200, statusText: 'OK', headers: {}, config, data }
    }
    await app.routeList()
    assert.equal(refreshes, 2)
    assert.equal(protectedRequests, 2)
    assert.equal(account.token, 'new-token')
    assert.equal(logouts, 0)
    api.defaults.adapter = async (config: { timeout: number }) => {
      assert.equal(config.timeout, 15_000)
      return { status: 200, statusText: 'OK', headers: {}, config, data: { status: 0, code: 'AUTH_UNAUTHORIZED', data: {} } }
    }
    await assert.rejects(app.permission())
    assert.equal(account.isLogin, false)
    assert.ok(logouts > 0)
  }
  finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key]
      else globals[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})
