import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import Docker from 'dockerode'
import { cancelSteamcmdInstallContainer, isSteamcmdJobRunning } from '../../infra/container'
import { ensureGameRuntimeImageReady } from '../../infra/game-adapter/runtime-image'
import { ensureContainerRuntimeReady } from './container-lifecycle'
import { prepareInstallPathForSteamcmdAsync } from './install-path'

it('Native preparation, process queries, cancellation and runtime checks never call Docker', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-native-install-'))
  const keys = ['BSP_RUNTIME_MODE', 'BSP_NATIVE_RUNTIME_DIR', 'BSP_NATIVE_STEAMCMD_PATH', 'BSP_INSTANCES_ROOT']
  const before = keys.map(key => process.env[key])
  process.env.BSP_RUNTIME_MODE = 'native'
  process.env.BSP_NATIVE_RUNTIME_DIR = path.join(root, 'runtime')
  process.env.BSP_NATIVE_STEAMCMD_PATH = process.execPath
  process.env.BSP_INSTANCES_ROOT = root
  t.after(() => {
    keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index] })
    fs.rmSync(root, { recursive: true, force: true })
  })
  const calls = ['ping', 'listContainers', 'getImage', 'getContainer'].map(method => t.mock.method(Docker.prototype, method as 'ping', () => { throw new Error('Native must not access Docker') }))
  assert.equal(await isSteamcmdJobRunning('native-empty'), false)
  await cancelSteamcmdInstallContainer('native-empty', true)
  assert.equal(await prepareInstallPathForSteamcmdAsync(path.join(root, 'instance')), undefined)
  assert.equal((await ensureGameRuntimeImageReady('343050')).ok, true)
  const runtime = await ensureContainerRuntimeReady()
  if (!runtime.ok) assert.match(runtime.message ?? '', /systemd|SteamCMD/)
  calls.forEach(call => assert.equal(call.mock.callCount(), 0))
})
