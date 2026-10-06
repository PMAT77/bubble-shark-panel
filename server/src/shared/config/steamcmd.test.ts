import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  buildSteamcmdContainerEnv,
  loadSteamcmdRuntimeConfig,
  formatSteamcmdDownloadRegionForLog,
  resolveSteamcmdAppUpdateTimeoutMs,
  resolveSteamcmdInstallMaxAttempts,
  resolveSteamcmdInstallRetryDelaysMs,
} from './steamcmd.ts'

const ENV_KEYS = [
  'BSP_STEAMCMD_DOWNLOAD_REGION',
  'GSH_STEAMCMD_DOWNLOAD_REGION',
  'BSP_STEAMCMD_HTTP_PROXY',
  'BSP_STEAMCMD_HTTPS_PROXY',
  'BSP_STEAMCMD_NO_PROXY',
  'BSP_STEAMCMD_NETWORK_MODE',
  'BSP_STEAMCMD_INSTALL_MAX_ATTEMPTS',
  'BSP_STEAMCMD_INSTALL_RETRY_DELAYS_MS',
  'BSP_STEAMCMD_APP_UPDATE_TIMEOUT_MS',
] as const

function clearSteamcmdEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
}

describe('loadSteamcmdRuntimeConfig', () => {
  afterEach(() => {
    clearSteamcmdEnv()
  })

  it('defaults install max attempts to 5', () => {
    assert.equal(resolveSteamcmdInstallMaxAttempts(), 5)
  })

  it('parses download region and network mode', () => {
    process.env.BSP_STEAMCMD_DOWNLOAD_REGION = 'cn'
    process.env.BSP_STEAMCMD_NETWORK_MODE = 'host'
    const config = loadSteamcmdRuntimeConfig()
    assert.equal(config.downloadRegion, 'cn')
    assert.equal(config.networkMode, 'host')
  })

  it('parses retry delays from comma-separated env', () => {
    process.env.BSP_STEAMCMD_INSTALL_RETRY_DELAYS_MS = '5000,10000'
    assert.deepEqual(resolveSteamcmdInstallRetryDelaysMs(), [5000, 10000])
  })

  it('defaults app_update timeout to 60 minutes and parses overrides', () => {
    assert.equal(resolveSteamcmdAppUpdateTimeoutMs(), 60 * 60 * 1000)
    process.env.BSP_STEAMCMD_APP_UPDATE_TIMEOUT_MS = '7200000'
    assert.equal(resolveSteamcmdAppUpdateTimeoutMs(), 7200000)
    process.env.BSP_STEAMCMD_APP_UPDATE_TIMEOUT_MS = 'abc'
    assert.equal(resolveSteamcmdAppUpdateTimeoutMs(), 60 * 60 * 1000)
  })

  it('builds proxy env for SteamCMD container', () => {
    process.env.BSP_STEAMCMD_HTTPS_PROXY = 'http://127.0.0.1:7890'
    process.env.BSP_STEAMCMD_DOWNLOAD_REGION = 'cn'
    const env = buildSteamcmdContainerEnv()
    assert.ok(env.includes('https_proxy=http://127.0.0.1:7890'))
    assert.ok(!env.some(value => value.startsWith('STEAMCMD_FORCE_DOWNLOAD_REGION=')))
  })

  it('reads legacy region aliases only for a deprecation notice', () => {
    process.env.GSH_STEAMCMD_DOWNLOAD_REGION = 'cn'
    assert.equal(loadSteamcmdRuntimeConfig().downloadRegion, 'cn')
    assert.match(formatSteamcmdDownloadRegionForLog('cn'), /已忽略/)
    assert.match(formatSteamcmdDownloadRegionForLog(''), /自动选择/)
  })
})
