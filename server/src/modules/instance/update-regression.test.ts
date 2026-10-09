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
  getSystemBackupSettings, saveSystemBackupSettings,
} from '../../shared/db'
import { createMember, createRole } from '../system/rbac-service'
import { clearRemoteBuildCache, fetchRemoteBuildId, REMOTE_BUILD_CACHE_MS } from '../../shared/steam-update/build-id'
import { resolveDockerStatus } from '../../infra/docker'
import { runSteamcmdAppInfoInContainer } from '../../infra/container/steamcmd-runner'
import { runSteamcmdJob } from '../../infra/container/steamcmd-job'
import { checkInstancesForUpdates, getInstanceUpdateCheckJobStatus, refreshInstanceUpdateStatusAfterInstall, refreshInstanceUpdateStatusAfterSeed } from './update-check'
import { getInstanceInstallProgress, isInstallJobActive, reconcileStaleInstallingInstances, startInstallJob } from './install-service'
import { findInstallSeedDonor } from './install-seed'
import { cancelInstallJob, getInstallLogsDirPath } from './install-service'
import { InstanceInstallLogWriter, readInstallProgress } from '../../shared/instance-install/log-store'
import { ensureDstLayout } from '../../infra/game-adapter/dst/cluster-config'
import { redactSteamcmdLogLine } from '../../infra/container/steamcmd-errors'

const app = Fastify({ logger: false })
const root = fs.mkdtempSync(path.join(process.cwd(), '.bsp-update-regression-'))
const envKeys = ['DB_PATH', 'BSP_RUNTIME_MODE', 'BSP_INSTANCES_ROOT', 'BSP_PANEL_CONTAINER_NAME', 'BSP_INSTALL_DEFER_DST_IMAGE_PULL', 'SERVER_LOG_DIR', 'BSP_UNIT_TEST', 'BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS', 'BSP_STEAMCMD_INSTALL_MAX_ATTEMPTS', 'BSP_STEAMCMD_INSTALL_RETRY_DELAYS_MS'] as const
const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]))
process.env.DB_PATH = path.join(root, 'test.sqlite')
process.env.BSP_RUNTIME_MODE = 'docker'
process.env.BSP_INSTANCES_ROOT = path.join(root, 'instances')
process.env.BSP_PANEL_CONTAINER_NAME = 'bsp-update-regression-panel'
process.env.SERVER_LOG_DIR = path.join(root, 'logs')
process.env.BSP_UNIT_TEST = '1'
process.env.BSP_INSTALL_DEFER_DST_IMAGE_PULL = '1'
process.env.BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS = '0'
process.env.BSP_STEAMCMD_INSTALL_MAX_ATTEMPTS = '2'
process.env.BSP_STEAMCMD_INSTALL_RETRY_DELAYS_MS = '0'

let token = ''
let queryOutput = ''
let queryExitCode = 0
let hang = false
let queries = 0
let updates = 0
let queryDelayMs = 0
let updateOutput = "Success! App '343050' fully installed.\n"

function metadata(publicBuild = '25643504') {
  return `"343050" {\n"depots" {\n${Array.from({ length: 120 }, (_, i) => `"depot${i}" { "manifests" { "public" { "gid" "1" } } }`).join('\n')}
"343052" { "config" { "oslist" "linux" } "manifests" { "public" { "gid" "5351080740317260085" } } }
"branches" { "public" { "buildid" "${publicBuild}" }
"beforemacoschanges" { "buildid" "12576213" }
"updatebeta" { "buildid" "25540104" } } } }`
}

function localMetadata(build: string, gid = '5351080740317260085', state = '4') {
  return `"AppState" { "appid" "343050" "StateFlags" "${state}" "buildid" "${build}"
"InstalledDepots" { "343052" { "manifest" "${gid}" } } }\n`
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
  fs.writeFileSync(path.join(installPath, 'steamapps', 'appmanifest_343050.acf'), localMetadata(build))
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
  assert.equal(readInstallProgress(getInstallLogsDirPath(), id)?.phaseCode, 'complete')
}

before(async () => {
  mock.method(Docker.prototype, 'ping', async () => 'OK')
  mock.method(Docker.prototype, 'listContainers', async () => [])
  mock.method(Docker.prototype, 'info', async () => ({ MemTotal: 16 * 1024 ** 3 }))
  // POSIX 实例路径需要真实的面板挂载映射；Windows 直 bind 不经过这一分支。
  mock.method(Docker.prototype, 'getContainer', () => ({
    inspect: async () => ({
      Mounts: [{ Type: 'bind', Source: process.env.BSP_INSTANCES_ROOT!, Destination: process.env.BSP_INSTANCES_ROOT! }],
      State: { Running: false },
    }),
  }))
  mock.method(Docker.prototype, 'getImage', () => ({ inspect: async () => ({ Id: 'fixture' }) }))
  mock.method(os, 'freemem', () => 16 * 1024 ** 3)
  mock.method(fs, 'chownSync', () => {})
  mock.method(fs.promises, 'chown', async () => {})
  mock.method(Docker.prototype, 'createContainer', async (options: Docker.ContainerCreateOptions) => {
    const cmd = options.Cmd ?? []
    const query = cmd.includes('+app_info_print')
    const text = query ? queryOutput : updateOutput
    const exitCode = query ? queryExitCode : 0
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
      : new Promise<{ StatusCode: number }>(resolve => setTimeout(() => resolve({ StatusCode: exitCode }), query ? queryDelayMs : 0))
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

  it('coalesces concurrent checks and refreshes expired five-minute caches', async () => {
    clearRemoteBuildCache()
    const count = queries
    queryDelayMs = 20
    assert.deepEqual(await Promise.all([fetchRemoteBuildId('', '343050'), fetchRemoteBuildId('', '343050')]), ['25643504', '25643504'])
    assert.equal(queries, count + 1)
    queryDelayMs = 0
    const now = Date.now()
    const clock = mock.method(Date, 'now', () => now + REMOTE_BUILD_CACHE_MS + 1)
    try {
      assert.equal(await fetchRemoteBuildId('', '343050'), '25643504')
      assert.equal(queries, count + 2)
    }
    finally { clock.mock.restore(); clearRemoteBuildCache() }
  })

  it('an invalidated slow query cannot erase a newer successful cache', async () => {
    clearRemoteBuildCache()
    const count = queries
    queryDelayMs = 100
    queryExitCode = 1
    const old = fetchRemoteBuildId('', '343050')
    while (queries === count) await new Promise(resolve => setTimeout(resolve, 1))
    clearRemoteBuildCache('343050')
    queryDelayMs = 0
    queryExitCode = 0
    queryOutput = metadata('25643505')
    try {
      assert.equal(await fetchRemoteBuildId('', '343050'), '25643505')
      assert.equal(await old, null)
      assert.equal(await fetchRemoteBuildId('', '343050'), '25643505')
      assert.equal(queries, count + 2)
    }
    finally { queryOutput = metadata(); clearRemoteBuildCache() }
  })

  it('installation finalization and restart reconciliation never rewrite the manifest', async () => {
    const current = await instance()
    const manifest = path.join(current.installPath!, 'steamapps', 'appmanifest_343050.acf')
    await refreshInstanceUpdateStatusAfterInstall(current.id, current.installPath!, '343050', '')
    assert.equal(fs.readFileSync(manifest, 'utf8'), localMetadata('25540104'))
    assert.equal((await getGameInstanceById(current.id))?.updateAvailable, true)
    await updateGameInstanceRuntime(current.id, { status: 'installing' })
    assert.equal(ensureDstLayout(current.installPath!, { instanceName: current.name }).ok, true)
    const writer = new InstanceInstallLogWriter(getInstallLogsDirPath(), current.id)
    writer.clear()
    writer.appendLine('Update state (0x61) downloading, progress: 56.25')
    writer.flush()
    await reconcileStaleInstallingInstances(app)
    const recovered = readInstallProgress(getInstallLogsDirPath(), current.id)!
    assert.equal(recovered.status, 'success')
    assert.equal(recovered.phaseCode, 'complete')
    assert.ok(recovered.events.some(event => event.message === '下载游戏文件'))
    assert.equal(fs.readFileSync(manifest, 'utf8'), localMetadata('25540104'))
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
    queryOutput = 'ERROR! Failed to connect to Steam network.\n'
    const result = await checkInstancesForUpdates({ steamcmdCommand: '', instanceIds: [current.id], force: true })
    queryExitCode = 0
    assert.equal(result.items[0].remoteBuildId, null)
    assert.match(result.items[0].message ?? '', /SteamCMD 版本查询失败/)
    assert.match(result.items[0].message ?? '', /Failed to connect to Steam network/)
    queryOutput = metadata().slice(0, -2)
    const malformed = await checkInstancesForUpdates({ steamcmdCommand: '', instanceIds: [current.id], force: true })
    assert.equal(malformed.items[0].remoteBuildId, null)
    assert.match(malformed.items[0].message ?? '', /未返回完整/)
    queryOutput = metadata()
  })

  it('the manual check endpoint reuses a fresh successful public build cache', async () => {
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
    assert.equal(result.result?.items[0].remoteBuildId, '25643504')
    assert.equal(queries, count)
    queryOutput = metadata()
    clearRemoteBuildCache()
  })

  it('equal Build IDs with old depot contents are detected and ordinary update is accepted', async () => {
    const current = await instance('25643504')
    const manifest = path.join(current.installPath!, 'steamapps', 'appmanifest_343050.acf')
    fs.writeFileSync(manifest, localMetadata('25643504', '6231402285857230600'))
    await updateGameInstanceRuntime(current.id, { localBuildId: '25643504', remoteBuildId: '25643504', updateAvailable: false })
    const result = await checkInstancesForUpdates({ steamcmdCommand: '', instanceIds: [current.id], force: true })
    assert.equal(result.items[0].localBuildId, result.items[0].remoteBuildId)
    assert.equal(result.items[0].updateAvailable, true)
    assert.match(result.items[0].message ?? '', /内容清单.*不一致/)
    const count = updates
    const response = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token }, payload: { id: current.id } })
    assert.equal(JSON.parse(response.body).error, '', response.body)
    await waitForInstall(current.id)
    assert.equal(updates, count + 1)
  })

  it('only complete and matching content metadata is latest; incomplete records remain unknown', async () => {
    const current = await instance('25643504')
    const manifest = path.join(current.installPath!, 'steamapps', 'appmanifest_343050.acf')
    const check = async () => (await checkInstancesForUpdates({ steamcmdCommand: '', instanceIds: [current.id], force: true })).items[0]
    const latest = await check()
    assert.equal(latest.updateAvailable, false)
    assert.equal(latest.localBuildId, latest.remoteBuildId)
    assert.equal(latest.message, undefined)
    for (const content of ['"buildid" "25643504"', localMetadata('25643504').slice(0, -3),
      localMetadata('25643504').replace('"343050"', '"322330"'),
      localMetadata('25643504').replace('5351080740317260085', 'unknown'),
      `${localMetadata('25643504')} "AppState" { "buildid" "1" }`]) {
      fs.writeFileSync(manifest, content)
      const result = await check()
      assert.equal(result.localBuildId, '25643504')
      assert.equal(result.updateState, 'unknown')
      assert.ok(result.message)
    }
    fs.writeFileSync(manifest, localMetadata('25643504', '5351080740317260085', '6'))
    assert.equal((await check()).updateAvailable, true)
    fs.writeFileSync(manifest, localMetadata('25643504'))
    fs.rmSync(path.join(current.installPath!, 'bin64'), { recursive: true })
    assert.equal((await check()).updateAvailable, true)
    fs.mkdirSync(path.join(current.installPath!, 'bin64'))
    fs.writeFileSync(path.join(current.installPath!, 'bin64', 'dontstarve_dedicated_server_nullrenderer_x64'), 'binary')
    queryOutput = metadata().replace('"343052" {', '"343054" { "config" { "oslist" "linux" } "manifests" { "public" { "gid" "1234" } } } "343052" {')
    assert.equal((await check()).updateAvailable, true, 'missing Linux depot cannot be latest')
    queryOutput = metadata().replace('"gid" "5351080740317260085"', '"gid" "unknown"')
    assert.equal((await check()).updateState, 'unknown', 'incomplete remote content metadata cannot be latest')
    queryOutput = metadata()
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

  it('installation completes before a slow failing version query and ordinary unknown updates are rejected', async () => {
    const current = await instance('25643504')
    queryExitCode = 1
    queryDelayMs = 300
    try {
      const res = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token }, payload: { id: current.id, force: true } })
      assert.equal(JSON.parse(res.body).error, '', res.body)
      await waitForInstall(current.id)
      assert.equal((await getGameInstanceById(current.id))?.installLogStatus, 'success')
      assert.equal((await getGameInstanceById(current.id))?.updateCheckedAt, null)
      const deadline = Date.now() + 2000
      while (!(await getGameInstanceById(current.id))?.updateCheckedAt && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      const checked = await getGameInstanceById(current.id)
      assert.equal(checked?.status, 'stopped')
      assert.equal(checked?.updateState, 'unknown')
      assert.match(checked?.updateCheckError ?? '', /SteamCMD/)
      const count = updates
      const rejected = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token }, payload: { id: current.id } })
      assert.match(JSON.parse(rejected.body).error, /无法确认/)
      assert.equal(updates, count)
    }
    finally { queryExitCode = 0; queryDelayMs = 0; clearRemoteBuildCache() }
  })

  it('retries an aborted update even with exit zero and a success line, then records failure', async () => {
    const current = await instance()
    const count = updates
    updateOutput = "Update state (0x0) : Timed out waiting for update to start, bailing.\nSuccess! App '343050' fully installed.\n"
    try {
      const res = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token }, payload: { id: current.id, force: true } })
      assert.equal(JSON.parse(res.body).error, '', res.body)
      const deadline = Date.now() + 5000
      while (isInstallJobActive(current.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(isInstallJobActive(current.id), false)
      const failed = await getGameInstanceById(current.id)
      assert.equal(failed?.status, 'error')
      assert.equal(failed?.installLogStatus, 'failed')
      assert.match(failed?.lastError ?? '', /连接|未完成|超时/)
      assert.match(new InstanceInstallLogWriter(getInstallLogsDirPath(), current.id).readContent(), /Timed out waiting/)
      assert.equal(updates, count + 2)
      const progress = readInstallProgress(getInstallLogsDirPath(), current.id)!
      assert.equal(progress.status, 'failed')
      assert.equal(progress.attempt, 2)
      assert.equal(progress.percent, null)
      assert.ok(progress.events.some(event => /第 2\/2 次尝试/.test(event.message)))
    }
    finally { updateOutput = "Success! App '343050' fully installed.\n" }
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

describe('installation progress and raw log routes', () => {
  it('task identity rejects old snapshots and old database writes', async () => {
    const current = await instance()
    const writer = new InstanceInstallLogWriter(getInstallLogsDirPath(), current.id)
    writer.clear(2, { taskId: 'old-task', kind: 'install', runtimeMode: 'docker', backup: false })
    writer.setPhase('download')
    writer.setMeasuredPercent(56.25)
    writer.flush()
    await updateGameInstanceRuntime(current.id, { installTaskId: 'new-task', installPercent: 20, installLogStatus: 'running' })
    await updateGameInstanceRuntime(current.id, { status: 'error', installLogStatus: 'failed', whereInstallTaskId: 'old-task' })
    const saved = (await getGameInstanceById(current.id))!
    assert.equal(saved.installLogStatus, 'running')
    const snapshot = getInstanceInstallProgress(saved)!
    assert.equal(snapshot.taskId, 'new-task')
    assert.equal(snapshot.percent, null)
    assert.equal(snapshot.overallPercent, 20)
    writer.dispose()
  })

  it('an actual copy failure stops without downloading through SteamCMD', async () => {
    await instance('25643504')
    clearRemoteBuildCache()
    queryOutput = metadata()
    const recipientPath = path.join(root, 'instances', 'copy-failure-target')
    const recipient = await createGameInstance({ nodeId: 'local-node', name: '复制失败', gameCode: '343050', status: 'pending_install', installPath: recipientPath })
    const original = fs.createWriteStream
    const stream = mock.method(fs, 'createWriteStream', (...args: Parameters<typeof fs.createWriteStream>) => {
      if (String(args[0]).startsWith(recipientPath)) throw new Error('ENOSPC: no space left on device')
      return original(...args)
    })
    const beforeUpdates = updates
    try {
      assert.equal(startInstallJob(app, { instanceId: recipient.id, instanceName: recipient.name, installPath: recipientPath, appId: '343050', steamcmdCommand: 'steamcmd' }), 'started')
      while (isInstallJobActive(recipient.id)) await new Promise(resolve => setTimeout(resolve, 10))
      const failed = (await getGameInstanceById(recipient.id))!
      assert.equal(failed.installLogStatus, 'failed')
      assert.match(failed.lastError ?? '', /复制|磁盘/)
      assert.equal(updates, beforeUpdates)
    }
    finally { stream.mock.restore() }
  })

  it('restart requires a matching completion checkpoint even if old files and layout are complete', async () => {
    const current = await instance()
    ensureDstLayout(current.installPath!, { instanceName: current.name })
    const writer = new InstanceInstallLogWriter(getInstallLogsDirPath(), current.id)
    writer.clear(1, { taskId: 'interrupted-update', kind: 'update', runtimeMode: 'docker', backup: false })
    writer.progress.readyToCommit = false
    writer.flush()
    await updateGameInstanceRuntime(current.id, { status: 'installing', installLogStatus: 'running', installTaskId: 'interrupted-update' })
    await reconcileStaleInstallingInstances(app)
    assert.equal((await getGameInstanceById(current.id))?.installLogStatus, 'failed')
    writer.dispose()
  })
  it('backup failure stops an accepted update before any game file write', async () => {
    const current = await instance()
    fs.mkdirSync(path.join(current.installPath!, 'klei-storage'))
    const settings = await getSystemBackupSettings()
    await saveSystemBackupSettings({ autoBackupBeforeUpdate: true })
    const original = fs.mkdirSync
    const failure = mock.method(fs, 'mkdirSync', (...args: Parameters<typeof fs.mkdirSync>) => {
      if (String(args[0]).includes('backups')) throw new Error('ENOSPC: no space left on device')
      return original(...args)
    })
    const beforeUpdates = updates
    try {
      const res = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token }, payload: { id: current.id, force: true } })
      assert.equal(JSON.parse(res.body).error, '', res.body)
      while (isInstallJobActive(current.id)) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(updates, beforeUpdates)
      assert.equal((await getGameInstanceById(current.id))?.installLogStatus, 'failed')
    }
    finally { failure.mock.restore(); await saveSystemBackupSettings(settings) }
  })
  it('HTTP stop records cancellation even if the cached Docker readiness check is unavailable', async () => {
    const current = await instance()
    hang = true
    try {
      const res = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token }, payload: { id: current.id, force: true } })
      assert.equal(JSON.parse(res.body).error, '', res.body)
      const stopped = await app.inject({ method: 'POST', url: '/app/instance/stop', headers: { token }, payload: { id: current.id } })
      assert.equal(JSON.parse(stopped.body).error, '', stopped.body)
      assert.equal((await getGameInstanceById(current.id))?.installLogStatus, 'cancelled')
      const log = await app.inject({ method: 'GET', url: '/app/instance/install-log?id=' + current.id + '&view=summary', headers: { token } })
      assert.equal(JSON.parse(log.body).data.status, 'cancelled')
    }
    finally { hang = false }
  })

  it('log initialization failure records a terminal failure and releases the task', async () => {
    const current = await instance()
    const original = fs.writeFileSync
    const failure = mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]).endsWith(current.id + '.log')) throw new Error('EACCES: permission denied writing install log')
      return original(...args)
    })
    try {
      const res = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token }, payload: { id: current.id, force: true } })
      assert.equal(JSON.parse(res.body).error, '', res.body)
      while (isInstallJobActive(current.id)) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal((await getGameInstanceById(current.id))?.installLogStatus, 'failed')
      assert.match((await getGameInstanceById(current.id))?.lastError ?? '', /权限|无法写入/)
    }
    finally { failure.mock.restore() }
  })

  it('runtime image failure cannot record installation success', async () => {
    const current = await instance()
    const beforeUpdates = updates
    const image = mock.method(Docker.prototype, 'getImage', () => ({ inspect: async () => {
      if (updates > beforeUpdates) throw new Error('image unavailable')
      return { Id: 'fixture' }
    } }))
    const pull = mock.method(Docker.prototype, 'pull', (_image: string, callback: (error: Error) => void) => callback(new Error('unauthorized')))
    try {
      const res = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token }, payload: { id: current.id, force: true } })
      assert.equal(JSON.parse(res.body).error, '', res.body)
      while (isInstallJobActive(current.id)) await new Promise(resolve => setTimeout(resolve, 10))
      const failed = await getGameInstanceById(current.id)
      assert.equal(failed?.installLogStatus, 'failed')
      assert.equal(failed?.lastErrorPhase, 'install')
      assert.notEqual(failed?.installPercent, 100)
      assert.match(failed?.lastError ?? '', /镜像|仓库/)
    }
    finally { image.mock.restore(); pull.mock.restore() }
  })

  it('restart does not treat an incomplete manifest or pending row as success', async () => {
    const current = await instance()
    fs.rmSync(path.join(current.installPath!, 'steamapps', 'appmanifest_343050.acf'))
    await updateGameInstanceRuntime(current.id, { status: 'pending_install', installLogStatus: 'running' })
    await reconcileStaleInstallingInstances(app)
    assert.equal((await getGameInstanceById(current.id))?.installLogStatus, 'failed')
  })
  it('persists cancellation on the active recorder and reconciles interrupted snapshots after restart', async () => {
    const current = await instance()
    hang = true
    try {
      const res = await app.inject({ method: 'POST', url: '/app/instance/update', headers: { token }, payload: { id: current.id, force: true } })
      assert.equal(JSON.parse(res.body).error, '', res.body)
      await cancelInstallJob(current.id)
      const deadline = Date.now() + 3000
      while (isInstallJobActive(current.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(isInstallJobActive(current.id), false)
      const cancelled = readInstallProgress(getInstallLogsDirPath(), current.id)!
      assert.equal(cancelled.status, 'cancelled')
      assert.equal(cancelled.failure, null)
      assert.ok(!cancelled.events.some(event => /安装完成，可以启动/.test(event.message)))
    }
    finally { hang = false }
    const unfinished = await instance()
    fs.rmSync(path.join(unfinished.installPath!, 'bin64'), { recursive: true })
    const writer = new InstanceInstallLogWriter(getInstallLogsDirPath(), unfinished.id)
    writer.clear()
    writer.appendLine('Update state (0x61) downloading, progress: 43.21')
    writer.flush()
    await updateGameInstanceRuntime(unfinished.id, { status: 'installing', installLogStatus: 'running' })
    await reconcileStaleInstallingInstances(app)
    const interrupted = readInstallProgress(getInstallLogsDirPath(), unfinished.id)!
    assert.equal(interrupted.status, 'failed')
    assert.equal(interrupted.phaseCode, 'download')
    assert.equal(interrupted.percent, null)
    assert.match(interrupted.failure!.message, /服务重启/)
  })

  it('reads only snapshots for summaries and streams the complete redacted log for download', async () => {
    const current = await instance()
    await updateGameInstanceRuntime(current.id, { status: 'installing', installLogStatus: 'running' })
    const writer = new InstanceInstallLogWriter(getInstallLogsDirPath(), current.id)
    writer.clear(2)
    try {
      writer.appendLine('Connecting anonymously to Steam Public...OK')
      writer.appendLine(redactSteamcmdLogLine('https://name:password@example.test/download?token=secret'))
      for (let i = 1; i <= 2500; i++) writer.appendLine(`Update state (0x61) downloading, progress: ${(i / 25).toFixed(2)}`)
      writer.flush()
      const read = mock.method(fs, 'readFileSync')
      const summary = await app.inject({ url: `/app/instance/install-log?id=${current.id}&view=summary`, headers: { token } })
      const data = JSON.parse(summary.body).data
      assert.equal(data.content, '')
      assert.equal(data.progress.percent, 100)
      assert.equal(data.status, 'running')
      assert.deepEqual(data.progress.events.map((event: { message: string }) => event.message), ['安装任务已开始', '连接 Steam', '下载游戏文件'])
      assert.ok(!read.mock.calls.some(call => String(call.arguments[0]).endsWith(`${current.id}.log`)))
      read.mock.restore()
      const raw = await app.inject({ url: `/app/instance/install-log?id=${current.id}`, headers: { token } })
      const preview = JSON.parse(raw.body).data
      assert.equal(preview.content.split('\n').length, 500)
      assert.equal(preview.rawTruncated, true)
      const download = await app.inject({ url: `/app/instance/install-log/download?id=${current.id}`, headers: { token } })
      assert.equal(download.statusCode, 200)
      assert.match(download.headers['content-disposition'] as string, /filename\*=UTF-8/)
      assert.equal(download.body, fs.readFileSync(path.join(getInstallLogsDirPath(), `${current.id}.log`), 'utf8'))
      assert.match(download.body, /progress: 0.04/)
      assert.doesNotMatch(download.body, /password|token=secret/)
      writer.finish('failed', '安装已由用户中断')
      await updateGameInstanceRuntime(current.id, { status: 'error', installLogStatus: 'failed', lastError: '安装已由用户中断', lastErrorPhase: 'install' })
      const reopened = JSON.parse((await app.inject({ url: `/app/instance/install-log?id=${current.id}&view=summary`, headers: { token } })).body).data
      assert.equal(reopened.status, 'failed')
      assert.equal(reopened.progress.phaseCode, 'download')
      assert.equal(reopened.progress.percent, null)
      assert.match(reopened.progress.failure.message, /中断/)
      assert.equal(readInstallProgress(getInstallLogsDirPath(), current.id)!.status, 'failed')
    }
    finally { writer.dispose() }
  })

  it('supports old logs without snapshots and enforces instance and permission checks', async () => {
    const current = await instance()
    const dir = getInstallLogsDirPath()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${current.id}.log`), 'old install log\n')
    const response = await app.inject({ url: `/app/instance/install-log?id=${current.id}&view=summary`, headers: { token } })
    assert.equal(JSON.parse(response.body).data.content, '暂无阶段记录，请展开原始日志查看。')
    assert.equal(JSON.parse(response.body).data.progress, null)
    const raw = await app.inject({ url: `/app/instance/install-log?id=${current.id}`, headers: { token } })
    assert.equal(JSON.parse(raw.body).data.content, 'old install log')
    const noGrant = await instance('25643504', false)
    const denied = await app.inject({ url: `/app/instance/install-log/download?id=${noGrant.id}`, headers: { token } })
    assert.equal(denied.statusCode, 403)
    const role = await createRole({ name: '安装日志无权限角色', permissions: ['instance:read'] })
    assert.ok(role.ok)
    const member = await createMember({ account: 'log-reader', password: 'Log-Reader#2026', roleId: role.data.roleId })
    assert.ok(member.ok)
    await updateUserMustChangePassword(member.data.userId, false)
    await addUserInstanceGrants(member.data.userId, [current.id], member.data.userId)
    const login = await app.inject({ method: 'POST', url: '/app/account/login', payload: { account: 'log-reader', password: 'Log-Reader#2026' } })
    const readerToken = JSON.parse(login.body).data.token
    for (const endpoint of ['install-log', 'install-log/download']) {
      const result = await app.inject({ url: `/app/instance/${endpoint}?id=${current.id}`, headers: { token: readerToken } })
      assert.match(JSON.parse(result.body).error, /权限/)
    }
  })
})
