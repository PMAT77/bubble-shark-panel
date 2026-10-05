import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, it } from 'node:test'
import Fastify from 'fastify'
import { registerAuthModule } from '../auth/index'
import { registerModModule } from './index'
import { closeDatabase, initDatabase, createGameInstance, createUserRecord, replaceUserPermissions, addUserInstanceGrants } from '../../shared/db/index'
import { hashPassword } from '../../shared/db/connection'
import { getModAccessStatus } from './mod-access-service'
import { observeSteamAccess } from '../../infra/game-adapter/dst/steam-access-observation'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-mod-access-'))
const app = Fastify()
const originalFetch = globalThis.fetch
let networkRequests = 0
let token = ''
before(async () => {
  await initDatabase(path.join(root, 'db.sqlite'), path.resolve('server/drizzle'), { seedDevelopmentUsers: false })
  const installPath = path.join(root, 'instance')
  fs.mkdirSync(installPath)
  await createGameInstance({ id: 'access-instance', nodeId: 'local-node', name: 'Access test', gameCode: '343050', status: 'stopped', installPath })
  await createUserRecord({ id: 'access-reader', account: 'reader', passwordHash: hashPassword('123456'), status: 1, avatar: '', email: '', mustChangePassword: false })
  await replaceUserPermissions('access-reader', ['mod:read'])
  await addUserInstanceGrants('access-reader', ['access-instance'], null)
  globalThis.fetch = async () => { networkRequests += 1; throw new Error('offline fixture') }
  registerAuthModule(app)
  registerModModule(app)
  const login = await app.inject({ method: 'POST', url: '/app/account/login', payload: { account: 'reader', password: '123456' } })
  token = JSON.parse(login.body).data.token
})
after(async () => {
  await app.close()
  globalThis.fetch = originalFetch
  closeDatabase()
  fs.rmSync(root, { recursive: true, force: true })
})
it('allows a scoped reader to observe without probing, rejects ungranted instances and writes', async () => {
  const beforeRequests = networkRequests
  const response = await app.inject({ url: '/app/instances/access-instance/mods/access-status', headers: { token } })
  const body = JSON.parse(response.body)
  assert.equal(body.error, '')
  assert.equal(body.data.files.status, 'unknown')
  assert.equal(networkRequests, beforeRequests)
  const denied = await app.inject({ url: '/app/instances/ungranted/mods/access-status', headers: { token } })
  assert.ok(JSON.parse(denied.body).error)
  const write = await app.inject({ method: 'POST', url: '/app/instances/access-instance/mods/download-queue/start', headers: { token }, payload: { retryFailed: false } })
  assert.ok(JSON.parse(write.body).error)
})
it('exposes independent outcomes and safe configuration booleans without credentials', () => {
  const keys = ['BSP_STEAM_HTTP_PROXY', 'BSP_STEAMCMD_HTTP_PROXY', 'BSP_STEAM_RELAY_TOKEN', 'BSP_STEAM_WEBAPI_KEY']
  const saved = keys.map(key => process.env[key])
  try {
    process.env.BSP_STEAM_HTTP_PROXY = 'http://name:secret-password@proxy.invalid:7890'
    process.env.BSP_STEAMCMD_HTTP_PROXY = 'http://name:secret-password@proxy.invalid:7890'
    process.env.BSP_STEAM_RELAY_TOKEN = 'secret-token'
    process.env.BSP_STEAM_WEBAPI_KEY = 'secret-key'
    observeSteamAccess('market', { status: 'success', message: '市场列表请求成功' })
    observeSteamAccess('files', { status: 'failed', message: '本次文件下载失败' }, 'access-instance')
    const data = getModAccessStatus('access-instance')
    assert.equal(data.market.status, 'success')
    assert.equal(data.files.status, 'failed')
    assert.equal(data.configuration.httpProxyConfigured, true)
    assert.equal(data.configuration.steamcmdProxyConfigured, true)
    assert.doesNotMatch(JSON.stringify(data), /secret-password|secret-token|secret-key|proxy\.invalid/)
  }
  finally { keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] }) }
})
