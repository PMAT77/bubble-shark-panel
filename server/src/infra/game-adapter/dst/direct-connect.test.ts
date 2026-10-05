import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { clearDstConnectHostCache } from './connect-host'
import { ensureDstCavesShardConfig, ensureDstClusterConfig } from './cluster-config'
import {
  buildDstConnectInfo,
  buildDstDirectConnectCommand,
  isProxyEnvConfigured,
  resolvePreferredConnectMode,
} from './direct-connect'

describe('direct-connect', () => {
  it('buildDstDirectConnectCommand omits password when empty', () => {
    assert.equal(buildDstDirectConnectCommand('192.168.1.8', 10999), 'c_connect("192.168.1.8", 10999)')
  })

  it('buildDstDirectConnectCommand escapes quotes in password', () => {
    assert.equal(
      buildDstDirectConnectCommand('10.0.0.1', 10999, 'say "hi"'),
      'c_connect("10.0.0.1", 10999, "say \\"hi\\"")',
    )
  })

  it('resolvePreferredConnectMode falls back to local for outbound-probe addresses', () => {
    assert.equal(
      resolvePreferredConnectMode({ source: 'ip_echo', isPlaceholder: false, hasLanCommand: false }),
      'local',
    )
    assert.equal(
      resolvePreferredConnectMode({ source: 'cloud_metadata', isPlaceholder: false, hasLanCommand: false }),
      'public',
    )
    assert.equal(
      resolvePreferredConnectMode({ source: 'env', isPlaceholder: false, hasLanCommand: false }),
      'public',
    )
    assert.equal(
      resolvePreferredConnectMode({ source: 'placeholder', isPlaceholder: true, hasLanCommand: true }),
      'lan',
    )
    assert.equal(
      resolvePreferredConnectMode({ source: 'placeholder', isPlaceholder: true, hasLanCommand: false }),
      'local',
    )
  })

  it('isProxyEnvConfigured detects proxy variables in either case', () => {
    assert.equal(isProxyEnvConfigured({}), false)
    assert.equal(isProxyEnvConfigured({ HTTP_PROXY: 'http://127.0.0.1:7892' }), true)
    assert.equal(isProxyEnvConfigured({ https_proxy: 'http://127.0.0.1:7892' }), true)
    assert.equal(isProxyEnvConfigured({ ALL_PROXY: '   ' }), false)
  })

  it('buildDstConnectInfo returns structured connect payload', async () => {
    const previous = process.env.BSP_DST_CONNECT_HOST
    process.env.BSP_DST_CONNECT_HOST = '203.0.113.10'
    clearDstConnectHostCache()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-direct-connect-'))
    ensureDstClusterConfig(dir, { instanceName: 'Test Room', gamePort: 11001 })
    try {
      const info = await buildDstConnectInfo(dir, { gamePort: 11001, running: true })
      assert.equal(info.roomName, 'Test Room')
      assert.equal(info.port, 11001)
      assert.equal(info.host, '203.0.113.10')
      assert.ok(info.command.includes('c_connect('))
      assert.match(info.localCommand, /127\.0\.0\.1/)
      assert.ok(info.udpPorts.includes(11001))
      assert.equal(info.running, true)
      // 手动配置的地址视为可信，默认仍展示公网档
      assert.equal(info.preferredMode, 'public')
    }
    finally {
      clearDstConnectHostCache()
      if (previous === undefined) {
        delete process.env.BSP_DST_CONNECT_HOST
      }
      else {
        process.env.BSP_DST_CONNECT_HOST = previous
      }
    }
  })

  it('buildDstConnectInfo appends caves UDP ports once the caves shard exists', async () => {
    const previous = process.env.BSP_DST_CONNECT_HOST
    process.env.BSP_DST_CONNECT_HOST = '203.0.113.10'
    clearDstConnectHostCache()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-direct-connect-caves-'))
    ensureDstClusterConfig(dir, { instanceName: 'Caves Room', gamePort: 10999 })
    try {
      const before = await buildDstConnectInfo(dir, { gamePort: 10999, running: true })
      assert.deepEqual(before.udpPorts, [10999, 8766, 12346])
      ensureDstCavesShardConfig(dir, 10999)
      const after = await buildDstConnectInfo(dir, { gamePort: 10999, running: true })
      assert.deepEqual(after.udpPorts, [10999, 8766, 12346, 11000, 8768, 12348])
    }
    finally {
      if (previous === undefined) {
        delete process.env.BSP_DST_CONNECT_HOST
      }
      else {
        process.env.BSP_DST_CONNECT_HOST = previous
      }
      clearDstConnectHostCache()
    }
  })
})
