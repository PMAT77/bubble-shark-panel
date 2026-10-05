import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { buildMasterContainerName } from '../../container/naming'
import { buildClusterIni, defaultClusterIniFields } from './cluster-ini'
import { DST_CLUSTER_NAME, DST_CONF_DIR, DST_STORAGE_DIR } from './constants'
import {
  DOCKER_SHARD_BIND_IP,
  ensureDockerShardInterconnectConfig,
  ensureNativeShardInterconnectConfig,
  NATIVE_SHARD_LOOPBACK_IP,
} from './shard-network-config'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('ensureNativeShardInterconnectConfig', () => {
  it('switches a Docker shard config back to loopback', () => {
    const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-shard-native-'))
    tempDirs.push(installPath)
    writeClusterIni(installPath, true, DOCKER_SHARD_BIND_IP, 'bsp-abc-master')

    assert.equal(ensureNativeShardInterconnectConfig(installPath), true)
    const content = fs.readFileSync(
      path.join(installPath, DST_STORAGE_DIR, DST_CONF_DIR, DST_CLUSTER_NAME, 'cluster.ini'),
      'utf8',
    )
    assert.match(content, new RegExp(`bind_ip = ${NATIVE_SHARD_LOOPBACK_IP.replaceAll('.', '\\.')}`))
    assert.match(content, new RegExp(`master_ip = ${NATIVE_SHARD_LOOPBACK_IP.replaceAll('.', '\\.')}`))
    assert.equal(ensureNativeShardInterconnectConfig(installPath), false)
  })
})

function writeClusterIni(installPath: string, shardEnabled: boolean, bindIp = '127.0.0.1', masterIp = '127.0.0.1') {
  const clusterRoot = path.join(installPath, DST_STORAGE_DIR, DST_CONF_DIR, DST_CLUSTER_NAME)
  fs.mkdirSync(clusterRoot, { recursive: true })
  const fields = defaultClusterIniFields('Test')
  fields.shardEnabled = shardEnabled
  fields.bindIp = bindIp
  fields.masterIp = masterIp
  fs.writeFileSync(path.join(clusterRoot, 'cluster.ini'), buildClusterIni(fields), 'utf8')
}

describe('ensureDockerShardInterconnectConfig', () => {
  it('patches bind_ip and master_ip when shard is enabled', () => {
    const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-shard-net-'))
    tempDirs.push(installPath)
    const instanceId = 'abc-123'
    writeClusterIni(installPath, true)

    const changed = ensureDockerShardInterconnectConfig(installPath, instanceId)
    assert.equal(changed, true)

    const content = fs.readFileSync(
      path.join(installPath, DST_STORAGE_DIR, DST_CONF_DIR, DST_CLUSTER_NAME, 'cluster.ini'),
      'utf8',
    )
    assert.match(content, new RegExp(`bind_ip = ${DOCKER_SHARD_BIND_IP}`))
    assert.match(content, new RegExp(`master_ip = ${buildMasterContainerName(instanceId)}`))
  })

  it('is idempotent when values already match', () => {
    const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-shard-net-'))
    tempDirs.push(installPath)
    const instanceId = 'abc-123'
    writeClusterIni(
      installPath,
      true,
      DOCKER_SHARD_BIND_IP,
      buildMasterContainerName(instanceId),
    )

    const changed = ensureDockerShardInterconnectConfig(installPath, instanceId)
    assert.equal(changed, false)
  })

  it('skips when shard is disabled', () => {
    const installPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-shard-net-'))
    tempDirs.push(installPath)
    writeClusterIni(installPath, false)

    const changed = ensureDockerShardInterconnectConfig(installPath, 'abc-123')
    assert.equal(changed, false)

    const content = fs.readFileSync(
      path.join(installPath, DST_STORAGE_DIR, DST_CONF_DIR, DST_CLUSTER_NAME, 'cluster.ini'),
      'utf8',
    )
    assert.match(content, /bind_ip = 127\.0\.0\.1/)
    assert.match(content, /master_ip = 127\.0\.0\.1/)
  })
})
