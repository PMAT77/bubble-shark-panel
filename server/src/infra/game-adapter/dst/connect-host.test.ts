import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CONNECT_HOST_PLACEHOLDER,
  clearDstConnectHostCache,
  isPublicIpv4,
  pickConnectHostFromInterfacePublicIps,
  resolveDstConnectHost,
} from './connect-host'

describe('connect-host', () => {
  it('isPublicIpv4 rejects RFC1918 and loopback', () => {
    assert.equal(isPublicIpv4('203.0.113.10'), true)
    assert.equal(isPublicIpv4('192.168.1.1'), false)
    assert.equal(isPublicIpv4('10.0.0.1'), false)
    assert.equal(isPublicIpv4('127.0.0.1'), false)
    assert.equal(isPublicIpv4('172.16.0.1'), false)
  })

  it('pickConnectHostFromInterfacePublicIps does not fall back to private IP', () => {
    const resolved = pickConnectHostFromInterfacePublicIps([])
    assert.equal(resolved.host, CONNECT_HOST_PLACEHOLDER)
    assert.equal(resolved.source, 'placeholder')
    assert.equal(resolved.isPlaceholder, true)
    assert.notEqual(resolved.source, 'interface_private')
  })

  it('pickConnectHostFromInterfacePublicIps uses first public NIC address', () => {
    const resolved = pickConnectHostFromInterfacePublicIps(['203.0.113.8', '198.51.100.2'])
    assert.equal(resolved.host, '203.0.113.8')
    assert.equal(resolved.source, 'interface_public')
    assert.equal(resolved.isPlaceholder, false)
  })

  it('resolveDstConnectHost prefers BSP_DST_CONNECT_HOST', async () => {
    const previous = process.env.BSP_DST_CONNECT_HOST
    process.env.BSP_DST_CONNECT_HOST = '203.0.113.55'
    clearDstConnectHostCache()
    try {
      const resolved = await resolveDstConnectHost()
      assert.equal(resolved.host, '203.0.113.55')
      assert.equal(resolved.source, 'env')
      assert.equal(resolved.isPlaceholder, false)
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
})
