import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import axios, { type InternalAxiosRequestConfig } from 'axios'
import { build } from 'esbuild'

it('market errors stay local while other requests, permission healing and authentication retain their behavior', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.bsp-api-errors-'))
  const globals = globalThis as unknown as Record<string, unknown>
  const saved = new Map(['faToast', 'useAppAccountStore'].map(key => [key, globals[key]]))
  const notices: string[] = []
  let permissionRefreshes = 0
  let logouts = 0
  let passwordChangeRequired = false
  const account = {
    isLogin: true, isGuestRole: false, permissions: ['mod:read'], token: 'expired', refreshToken: 'refresh',
    getPermissions: async () => { permissionRefreshes++ },
    setMustChangePassword: (value: boolean) => { passwordChangeRequired = value },
    requestLogout: () => { logouts++; account.isLogin = false },
    applySessionTokens: (tokens: { token: string, refreshToken: string }) => Object.assign(account, tokens),
  }
  globals.faToast = { error: () => notices.push('error'), warning: () => notices.push('warning') }
  globals.useAppAccountStore = () => account
  try {
    const modulePath = path.join(root, 'api.mjs')
    await build({
      stdin: { contents: 'export {default as api} from "./src/api/index.ts"; export {default as mod} from "./src/api/modules/mod.ts"', resolveDir: process.cwd(), loader: 'ts' },
      outfile: modulePath, bundle: true, platform: 'node', format: 'esm', external: ['axios'],
      define: { 'import.meta.env': JSON.stringify({ DEV: false, VITE_APP_API_BASEURL: '/' }) },
      plugins: [{ name: 'router-fixture', setup(builder) {
        builder.onResolve({ filter: /^@\/router$/ }, () => ({ path: 'router', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export default {currentRoute:{value:{name:"mod"}},replace(){this.currentRoute.value.name="forceChangePassword"}}', loader: 'js' }))
      } }],
    })
    const { api, mod } = await import(pathToFileURL(modulePath).href)
    let attempts = 0
    api.defaults.adapter = (config: InternalAxiosRequestConfig) => {
      attempts++
      return Promise.reject(new axios.AxiosError('network unavailable', 'ERR_NETWORK', config))
    }
    await assert.rejects(mod.getSteamModList('A'), /network unavailable/)
    assert.equal(attempts, 1)
    assert.deepEqual(notices, [])
    await assert.rejects(mod.getModList('A'), /network unavailable/)
    assert.deepEqual(notices.splice(0), ['error'])

    api.defaults.adapter = async (config: unknown) => ({ status: 200, statusText: 'OK', headers: {}, config,
      data: { status: 1, error: 'Steam unavailable', code: 'COMMON_BUSINESS_RULE_VIOLATION' } })
    await assert.rejects(mod.getSteamModList('A'))
    assert.deepEqual(notices, [])
    await assert.rejects(mod.getModList('A'))
    assert.deepEqual(notices.splice(0), ['warning'])

    api.defaults.adapter = async (config: unknown) => ({ status: 200, statusText: 'OK', headers: {}, config,
      data: { status: 1, error: 'permission revoked', code: 'AUTH_FORBIDDEN' } })
    await assert.rejects(mod.getSteamModList('A'))
    assert.deepEqual(notices.splice(0), ['warning'])
    assert.equal(permissionRefreshes, 1)

    api.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      throw new axios.AxiosError('forbidden', 'ERR_BAD_REQUEST', config, undefined, {
        status: 403, statusText: 'Forbidden', headers: {}, config, data: { code: 'AUTH_FORBIDDEN' },
      })
    }
    await assert.rejects(mod.getSteamModList('A'))
    assert.deepEqual(notices.splice(0), ['error'])
    assert.equal(permissionRefreshes, 2)

    api.defaults.adapter = async (config: { url: string, suppressErrorToast?: boolean, skipAuthRefresh?: boolean }) => {
      const data = config.url.endsWith('token/refresh')
        ? { status: 1, data: { token: 'renewed', refreshToken: 'renewed-refresh' } }
        : config.skipAuthRefresh ? { status: 1, data: { items: [] } } : { status: 0, code: 'AUTH_UNAUTHORIZED' }
      if (!config.url.endsWith('token/refresh')) assert.equal(config.suppressErrorToast, true)
      return { status: 200, statusText: 'OK', headers: {}, config, data }
    }
    await mod.getSteamModList('A')
    assert.equal(account.token, 'renewed')
    assert.equal(logouts, 0)
    assert.deepEqual(notices, [])

    api.defaults.adapter = async (config: unknown) => ({ status: 200, statusText: 'OK', headers: {}, config,
      data: { status: 0, code: 'AUTH_FORCE_PASSWORD_CHANGE' } })
    await assert.rejects(mod.getSteamModList('A'))
    assert.equal(passwordChangeRequired, true)
    assert.equal(logouts, 0)

    api.defaults.adapter = async (config: unknown) => ({ status: 200, statusText: 'OK', headers: {}, config,
      data: { status: 0, code: 'AUTH_UNAUTHORIZED' } })
    await assert.rejects(mod.getSteamModList('A'))
    assert.equal(account.isLogin, false)
    assert.ok(logouts > 0)
  }
  finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key]
      else globals[key] = value
    }
    assert.equal(path.dirname(root), process.cwd())
    fs.rmSync(root, { recursive: true, force: true })
  }
})
