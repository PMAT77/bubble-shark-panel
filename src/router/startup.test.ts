import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'node:test'
import { build } from 'esbuild'
import { createMemoryHistory, createRouter } from 'vue-router'

it('initial navigation completes or rejects once, preserving auth and password-change behavior', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.agent-router-'))
  const globals = globalThis as unknown as Record<string, unknown>
  const keys = ['useAppSettingsStore', 'useAppAccountStore', 'useAppRouteStore', 'useAppMenuStore', 'useAppKeepAliveStore', 'useAppAuth', 'faToast', 'document']
  const saved = new Map(keys.map(key => [key, globals[key]]))
  try {
    const modulePath = path.join(root, 'guards.mjs')
    await build({
      stdin: {
        contents: 'export { default } from "./src/router/guards.ts"; export { resetEnsureDynamicRoutes } from "./src/router/ensure-dynamic-routes.ts"',
        resolveDir: process.cwd(), loader: 'ts',
      },
      outfile: modulePath, bundle: true, platform: 'node', format: 'esm',
      define: { 'import.meta.env.DEV': 'false' },
      plugins: [{ name: 'guard-fixtures', setup(builder) {
        builder.onResolve({ filter: /^\.\/routes$|^@vueuse\/integrations\/useNProgress$|^virtual:fantastic-admin\/turbo-console$|\.css$/ }, args => ({ path: args.path, namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
          contents: args.path === './routes' ? 'export const asyncRoutes = []'
            : args.path.includes('useNProgress') ? 'export function useNProgress(){return {isLoading:{value:false}}}'
              : args.path.startsWith('virtual:') ? 'export function warnKeepAliveComponentNameMissing(){}' : '',
          loader: 'js',
        }))
      } }],
    })
    const { default: setupGuards, resetEnsureDynamicRoutes } = await import(pathToFileURL(modulePath).href)
    globals.document = { documentElement: { scrollTop: 0 } }
    globals.faToast = { warning: () => {} }
    globals.useAppAuth = () => ({ auth: () => true })
    globals.useAppMenuStore = () => ({})
    globals.useAppKeepAliveStore = () => ({})
    globals.useAppSettingsStore = () => ({
      settings: { app: { account: { auth: true }, routeBaseOn: 'backend', home: { fullPath: '/', enable: true } }, menu: { mode: 'single' }, page: { progress: true } },
      setTitle: () => {},
    })
    for (const scenario of ['success', 'permissionFailure', 'menuFailure', 'expiredSession', 'forcePasswordChange', 'permissionForcePasswordChange']) {
      resetEnsureDynamicRoutes()
      let permissionCalls = 0
      let menuCalls = 0
      const account = {
        isLogin: true, mustChangePassword: scenario === 'forcePasswordChange',
        getPermissions: async () => {
          permissionCalls++
          if (scenario === 'permissionForcePasswordChange') account.mustChangePassword = true
          if (scenario === 'expiredSession') account.isLogin = false
          if (scenario === 'permissionFailure' || scenario === 'expiredSession') throw new Error('permission failed')
        },
      }
      const routeStore = {
        isGenerate: false,
        routes: [{ path: '/detail', name: 'detail', component: { render: () => null } }],
        systemRoutes: [], setCurrentRemoveRoutes: () => {},
        generateRoutesAtBack: async () => {
          menuCalls++
          if (scenario === 'menuFailure' || scenario === 'permissionForcePasswordChange') throw new Error('menu failed')
          routeStore.isGenerate = true
        },
      }
      globals.useAppAccountStore = () => account
      globals.useAppRouteStore = () => routeStore
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [
          { path: '/login', name: 'login', component: {} },
          { path: '/force-change-password', name: 'forceChangePassword', component: {} },
          { path: '/:all(.*)*', name: 'notFound', component: {} },
        ],
      })
      setupGuards(router)
      const errors: unknown[] = []
      router.onError(error => errors.push(error))
      if (scenario.endsWith('Failure')) {
        const ready = assert.rejects(router.isReady(), /failed/)
        await assert.rejects(router.push('/detail'), /failed/)
        await ready
        assert.equal(account.isLogin, true)
        assert.equal(router.currentRoute.value.fullPath, '/')
        assert.equal(errors.length, 1)
        await assert.rejects(router.push('/login'), /failed/)
        assert.equal(permissionCalls, 1, 'failure stays latched, without redirecting to login')
      }
      else {
        await router.push('/detail')
        await router.isReady()
        assert.equal(errors.length, 0)
        assert.equal(router.currentRoute.value.name, scenario === 'success' ? 'detail' : scenario === 'expiredSession' ? 'login' : 'forceChangePassword')
        assert.equal(permissionCalls, scenario === 'forcePasswordChange' ? 0 : 1)
        assert.equal(menuCalls, scenario === 'success' || scenario === 'permissionForcePasswordChange' ? 1 : 0)
      }
    }
  }
  finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete globals[key]
      else globals[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})
