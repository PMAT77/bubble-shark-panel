import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readBrandEnv, resolveBrandEnvSource } from '../shared/brand-env'
import { buildShardContainerName, shardNameCandidates } from '../server/src/infra/container/naming'
import { NativeSystemdRuntime } from '../server/src/infra/container/native-systemd-runtime'
import { buildNativeReleaseAssetName } from '../server/src/modules/system/panel-update-native'
import { buildOfflineArchiveName } from '../server/src/modules/system/panel-update-offline'

test('brand aliases preserve process/file precedence, canonical overrides and explicit empty values', () => {
  assert.equal(readBrandEnv('BSP_KEY', { GSH_KEY: 'process' }, { BSP_KEY: 'file' }), 'process')
  assert.equal(readBrandEnv('BSP_KEY', { BSP_KEY: 'new', GSH_KEY: 'old' }), 'new')
  assert.equal(readBrandEnv('BSP_KEY', { BSP_KEY: '', GSH_KEY: 'old' }), '')
  assert.equal(readBrandEnv('BSP_KEY', {}, { GSH_KEY: 'file' }), 'file')
  assert.equal(readBrandEnv('GSH_KEY', { BSP_KEY: 'new' }), 'new')
  assert.equal(resolveBrandEnvSource({ GSH_RUNTIME_MODE: 'native' }, { BSP_RUNTIME_MODE: 'docker' }).BSP_RUNTIME_MODE, 'native')
})
test('new resource names and legacy services coexist without duplicating an existing shard', async t => {
  assert.deepEqual(shardNameCandidates('bsp-id-master'), ['bsp-id-master', 'gsh-id-master'])
  assert.equal(buildShardContainerName('id', 'master'), 'bsp-id-master')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-compat-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runtime = new NativeSystemdRuntime({ runtimeDir: root, unitDir: root })
  fs.writeFileSync(path.join(root, 'gsh-id-master.service'), '[Service]')
  assert.deepEqual(await runtime.findByName('bsp-id-master'), { name: 'gsh-id-master', id: 'gsh-id-master.service' })
  fs.writeFileSync(path.join(root, 'bsp-id-master.service'), '[Service]')
  assert.equal((await runtime.findByName('bsp-id-master'))?.name, 'bsp-id-master')
})
test('historical assets keep their published names; v0.15.0 uses the new brand', () => {
  assert.equal(buildNativeReleaseAssetName('v0.14.0'), 'game-server-hub-native-v0.14.0-linux-x64.tar.gz')
  assert.equal(buildNativeReleaseAssetName('v0.15.0'), 'bubblesharkpanel-native-v0.15.0-linux-x64.tar.gz')
  assert.equal(buildOfflineArchiveName('v1.0.0'), 'bubblesharkpanel-v1.0.0-docker-image.tar.gz')
  assert.equal(buildOfflineArchiveName('v0.4.2'), 'game-server-hub-v0.4.2-docker-image.tar.gz')
})
