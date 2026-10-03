import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it, mock } from 'node:test'
import Docker from 'dockerode'
import Fastify from 'fastify'
import { registerAuthModule } from '../auth'
import { registerInstanceModule } from './index'
import {
  addUserInstanceGrants, closeDatabase, createGameInstance, findUserByAccount,
  getGameInstanceById, initDatabase, updateGameInstanceRuntime, updateUserMustChangePassword,
} from '../../shared/db'
import { createMember, createRole } from '../system/rbac-service'
import { clearRemoteBuildCache, fetchRemoteBuildId } from '../../shared/steam-update/build-id'
import { resolveDockerStatus } from '../../infra/docker'
import { runSteamcmdAppInfoInContainer } from '../../infra/container/steamcmd-runner'
import { runSteamcmdJob } from '../../infra/container/steamcmd-job'
import { checkInstancesForUpdates, getInstanceUpdateCheckJobStatus, refreshInstanceUpdateStatusAfterInstall, refreshInstanceUpdateStatusAfterSeed } from './update-check'
import { isInstallJobActive, reconcileStaleInstallingInstances } from './install-service'
import { findInstallSeedDonor } from './install-seed'

const app = Fastify({ logger: false })
const root = fs.mkdtempSync(path.join(process.cwd(), '.gsh-update-regression-'))
const envKeys = ['DB_PATH', 'GSH_RUNTIME_MODE', 'GSH_INSTANCES_ROOT', 'GSH_PANEL_CONTAINER_NAME', 'GSH_INSTALL_DEFER_DST_IMAGE_PULL', 'SERVER_LOG_DIR', 'GSH_UNIT_TEST'] as const
const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]))
process.env.DB_PATH = path.join(root, 'test.sqlite')
process.env.GSH_RUNTIME_MODE = 'docker'
process.env.GSH_INSTANCES_ROOT = path.join(root, 'instances')
process.env.GSH_PANEL_CONTAINER_NAME = 'gsh-update-regression-panel'
process.env.SERVER_LOG_DIR = path.join(root, 'logs')
process.env.GSH_UNIT_TEST = '1'
process.env.GSH_INSTALL_DEFER_DST_IMAGE_PULL = '1'

let token = ''
let queryOutput = ''
let queryExitCode = 0
let hang = false
let queries = 0
let updates = 0

function metadata(publicBuild = '25643504') {
  return `"343050" {\n"depots" {\n${Array.from({ length: 120 }, (_, i) => `"depot${i}" { "manifests" { "public" { "gid" "1" } } }`).join('\n')}
"branches" { "public" { "buildid" "${publicBuild}" }
"beforemacoschanges" { "buildid" "12576213" }
"updatebeta" { "buildid" "25540104" } } } }`
}

function framed(text: string) {
  const payload = Buffer.from(text)
  const header = Buffer.alloc(8)
  header[0] = 1
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

async function instance(build = '25540104', grant = true) {
  const installPath = path.join(root, 'instances', `instance-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(path.join(installPath, 'bin64'), { recursive: true })
  fs.mkdirSync(path.join(installPath, 'data'), { recursive: true })
  fs.mkdirSync(path.join(installPath, 'steamapps'), { recursive: true })
  fs.writeFileSync(path.join(installPath, 'bin64', 'dontstarve_dedicated_server_nullrenderer_x64'), 'binary')
  fs.writeFileSync(path.join(installPath, 'data', 'resource'), 'resource')
  fs.writeFileSync(path.join(installPath, 'version.txt'), '747465\n')
  fs.writeFileSync(path.join(installPath, 'steamapps', 'appmanifest_343050.acf'), `"buildid" "${build}"\n`)
  const created = await createGameInstance({ nodeId: 'local-node', name: '版本回归', gameCode: '343050', status: 'stopped', installPath })
  const admin = await findUserByAccount('superadmin')
  if (grant) {
    await addUserInstanceGrants(admin!.id, [created.id], admin!.id)
  }
  return created
}

async function waitForInstall(id: string) {
  const deadline = Date.now() + 10000
  while (isInstallJobActive(id) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(isInstallJobActive(id), false, '安装任务应结束')
  const current = await getGameInstanceById(id)
  assert.equal(current?.status, 'stopped', current?.lastError ?? current?.lastCommand ?? undefined)
}

before(async () => {
  mock.method(Docker.prototype, 'ping', async () => 'OK')
  mock.method(Docker.prototype, 'listContainers', async () => [])
  mock.method(Docker.prototype, 'info', async () => ({ MemTotal: 16 * 1024 ** 3 }))
  // POSIX 实例路径需要真实的面板挂载映射；Windows 直 bind 不经过这一分支。
  mock.method(Docker.prototype, 'getContainer', () => ({
    inspect: async () => ({
      Mounts: [{ Type: 'bind', Source: process.env.GSH_INSTANCES_ROOT!, Destination: process.env.GSH_INSTANCES_ROOT! }],
      State: { Running: false },
    }),
  }))
  mock.method(Docker.prototype, 'getImage', () => ({ inspect: async () => ({ Id: 'fixture' }) }))
  mock.method(os, 'freemem', () => 16 * 1024 ** 3)
  mock.method(fs, 'chownSync', () => {})
  mock.method(Docker.prototype, 'createContainer', async (options: Docker.ContainerCreateOptions) => {
    const cmd = options.Cmd ?? []
    const query = cmd.includes('+app_info_print')
    const text = query ? queryOutput : "Success! App '343050' fully installed.\n"
    if (query) {
      queries++
    }
    else {
      updates++
      const bind = options.HostConfig?.Binds?.[0]
      const target = bind?.replace(/:\/[^:]+(?::.*)?$/, '')
      if (target) {
        fs.mkdirSync(path.join(target, 'bin64'), { recursive: true })
        fs.writeFileSync(path.join(target, 'bin64', 'dontstarve_dedicated_server_nullrenderer_x64'), 'binary')
      }
    }
    const frame = framed(text)
    let release: (value: { StatusCode: number }) => void = () => {}
    const waiting = hang ? new Promise<{ StatusCode: number }>((resolve) => { release = resolve })
      : Promise.resolve({ StatusCode: query ? queryExitCode : 0 })
    return {
      start: async () => {},
      logs: async () => Readable.from([frame.subarray(0, 11), frame.subarray(11, 47), frame.subarray(47)]),
      wait: () => waiting,
      inspect: async () => ({ State: { Running: hang } }),
      kill: async () => { release({ StatusCode: 137 }) },
      remove: async () => {},
    } as unknown as Docker.Container
  })
  await resolveDockerStatus(true)
  await initDatabase(process.env.DB_PATH!, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle'), {
    adminUsername: 'superadmin', adminPassword: '123456', seedDevelopmentUsers: false,
  })
  registerAuthModule(app)
  registerInstanceModule(app)
  await app.ready()
  const login = await app.inject({ method: 'POST', url: '/app/account/login', payload: { account: 'superadmin', password: '123456' } })
  token = JSON.parse(login.body).data.token
  queryOutput = metadata()
})

after(async () => {
  await app.close()
  closeDatabase()
  mock.restoreAll()
  clearRemoteBuildCache()
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(root, { recursive: true, force: true })
})

describe('game update regression', () => {
  it('Docker retains complete framed output, rejects overflow and times out', async () => {
    const result = await runSteamcmdAppInfoInContainer('343050')
    assert.equal(result.ok, true)
    assert.match(result.output, /"public" \{ "buildid" "25643504"/)
    assert.ok(result.output.split('\n').length > 80)
    queryOutput = ' '.repeat(1024 * 1024 + 1)
    assert.equal((await runSteamcmdAppInfoInContainer('343050')).ok, false)
    queryOutput = metadata()
    hang = true
    const timed = await runSteamcmdJob({ image: 'fixture', cmd: ['+app_info_print'], kind: 'app-info', timeoutMs: 20 })
    assert.equal(timed.ok, false)
    assert.equal(timed.timedOut, true)
    hang = false
  })

  it('manual refresh ignores valid cache, and failures never reuse cached public versions', async () => {
    clearRemoteBuildCache()
    const count = queries
    assert.equal(await fetchRemoteBuildId('', '343050'), '25643504')
    assert.equal(await fetchRemoteBuildId('', '343050'), '25643504')
    assert.equal(queries, count + 1)
    queryExitCode = 1
    assert.equal(await fetchRemoteBuildId('', '343050', { force: true }), null)
    queryExitCode = 0
    queryOutput = metadata().slice(0, -2)
    assert.equal(await fetchRemoteBuildId('', '343050', { force: true }), null)
    queryOutput = metadata()
  })

  it('installation finalization and restart reconciliation never rewrite the manifest', async () => {
    const current = await instance()
    const manifest = path.join(current.installPath!, 'steamapps', 'appmanifest_343050.acf')
    await refreshInstanceUpdateStatusAfterInstall(current.id, current.installPath!, '343050', '')
    assert.equal(fs.readFileSync(manifest, 'utf8'), '"buildid" "25540104"\n')
    assert.equal((await getGameInstanceById(current.id))?.updateAvailable, true)
    await updateGameInstanceRuntime(current.id, { status: 'installing' })
    await reconcileStaleInstallingInstances(app)
    assert.equal(fs.readFileSync(manifest, 'utf8'), '"buildid" "25540104"\n')
    assert.equal((await getGameInstanceById(current.id))?.updateAvailable, true)
    fs.rmSync(manifest)
    await refreshInstanceUpdateStatusAfterSeed(current.id, current.installPath!, '343050', {
      instanceId: 'donor', instanceName: 'donor', installPath: '',
      localBuildId: '25643504', remoteBuildId: '25643504', updateAvailable: false,
    })
    assert.equal((await getGameInstanceById(current.id))?.localBuildId, null)
    assert.equal(fs.existsSync(manifest), false)
  })

  it('failed checks return unknown with an explanation', async () => {
    const current = await instance()
    queryExitCode = 1
    const result = await checkInstancesForUpdates({ steamcmdCommand: '', instanceIds: [current.id], force: true })
    queryExitCode = 0
    assert.equal(result.items[0].remoteBuildId, null)
    assert.match(result.items[0].message ?? '', /无法获取/)
  })

  it('the manual check endpoint queries again even when the public build cache is valid', async () => {
    const current = await instance()
    await fetchRemoteBuildId('', '343050', { force: true })
    const count = queries
    queryOutput = metadata('25643505')
    const response = await app.inject({ method: 'POST', url: '/app/instance/check-updates', headers: { token }, payload: { ids: [current.id] } })
    assert.equal(JSON.parse(response.body).error, '', response.body)
    const deadline = Date.now() + 2000
    while (getInstanceUpdateCheckJobStatus().checking && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const result = getInstanceUpdateCheckJobStatus()
    assert.equal(result.error, null)
    assert.equal(result.result?.items[0].remoteBuildId, '25643505')
    assert.equal(queries, count + 1)
    queryOutput = metadata()
    clearRemoteBuildCache()
  })

  it('ordinary updates refresh stale equal database builds and accepted updates execute SteamCMD', async () => {
    const current = await instance()
    await updateGameInstanceRuntime(current.id, { localBuildId: '25540104', remoteBuildId: '25540104', updateAvailable: false })
    const count = updates
    const response = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token }, payload: { id: current.id } })
    const body = JSON.parse(response.body)
    assert.equal(body.error, '', response.body)
    assert.equal(body.data.isSuccess, true)
    await waitForInstall(current.id)
    assert.equal(updates, count + 1)
  })

  it('forced recovery executes SteamCMD even when public and local builds match', async () => {
    const current = await instance('25643504')
    await updateGameInstanceRuntime(current.id, { localBuildId: '25643504', remoteBuildId: '25643504', updateAvailable: false })
    const count = updates
    const response = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token }, payload: { id: current.id, force: true } })
    assert.equal(JSON.parse(response.body).error, '', response.body)
    await waitForInstall(current.id)
    assert.equal(updates, count + 1)
  })

  it('forced recovery bypasses donor copy even when recipient game files are incomplete', async () => {
    const current = await instance('25643504')
    fs.rmSync(path.join(current.installPath!, 'bin64'), { recursive: true })
    const count = updates
    const response = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token }, payload: { id: current.id, force: true } })
    assert.equal(JSON.parse(response.body).error, '', response.body)
    await waitForInstall(current.id)
    assert.equal(updates, count + 1)
  })

  it('running instances and unauthorized requests cannot force recovery', async () => {
    const current = await instance()
    await updateGameInstanceRuntime(current.id, { status: 'running' })
    const count = updates
    const running = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token }, payload: { id: current.id, force: true } })
    assert.match(JSON.parse(running.body).error, /先停止实例/)
    const noGrant = await instance('25643504', false)
    const denied = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token }, payload: { id: noGrant.id, force: true } })
    assert.match(JSON.parse(denied.body).error, /没有该实例的访问权限/)
    const role = await createRole({ name: '更新回归只读角色', permissions: ['instance:read'] })
    assert.ok(role.ok)
    const member = await createMember({ account: 'update-reader', password: 'Reader-Password#2026', roleId: role.data.roleId })
    assert.ok(member.ok)
    await updateUserMustChangePassword(member.data.userId, false)
    await addUserInstanceGrants(member.data.userId, [noGrant.id], member.data.userId)
    const login = await app.inject({ method: 'POST', url: '/app/account/login', payload: { account: 'update-reader', password: 'Reader-Password#2026' } })
    assert.equal(JSON.parse(login.body).error, '', login.body)
    const readerToken = JSON.parse(login.body).data.token
    const noPermission = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token: readerToken }, payload: { id: noGrant.id, force: true } })
    assert.match(JSON.parse(noPermission.body).error, /权限/)
    assert.equal(updates, count)
  })

  it('donor selection verifies current public rather than trusting stale or missing metadata', async () => {
    const recipient = await instance()
    const donor = await findInstallSeedDonor({ recipientId: recipient.id, recipientPath: recipient.installPath!, appId: '343050' })
    assert.equal(donor?.localBuildId, '25643504')
    assert.equal(donor?.remoteBuildId, '25643504')
    queryExitCode = 1
    assert.equal(await findInstallSeedDonor({ recipientId: recipient.id, recipientPath: recipient.installPath!, appId: '343050' }), null)
    queryExitCode = 0
  })
})
