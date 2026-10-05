import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  mapDbInstallLogStatusToResponse,
  shouldAllowInstallDespiteUpToDate,
  shouldSkipSteamcmdForReadyInstall,
} from './install-service.ts'

describe('mapDbInstallLogStatusToResponse', () => {
  it('maps installing without log meta to running', () => {
    assert.equal(mapDbInstallLogStatusToResponse(null, 'installing'), 'running')
  })

  it('maps error to failed when log meta unknown', () => {
    assert.equal(mapDbInstallLogStatusToResponse(null, 'error'), 'failed')
  })
})

describe('shouldAllowInstallDespiteUpToDate', () => {
  it('allows force reinstall', () => {
    assert.equal(shouldAllowInstallDespiteUpToDate({
      status: 'stopped',
      gameCode: '343050',
    }, '/var/lib/bubblesharkpanel/instances/x', true), true)
  })

  it('allows error status without force', () => {
    assert.equal(shouldAllowInstallDespiteUpToDate({
      status: 'error',
      gameCode: '343050',
    }, '/var/lib/bubblesharkpanel/instances/x'), true)
  })

  it('allows stopped when game files missing on disk', () => {
    assert.equal(shouldAllowInstallDespiteUpToDate({
      status: 'stopped',
      gameCode: '343050',
    }, '/nonexistent/path/for-bsp-test'), true)
  })
})

describe('shouldSkipSteamcmdForReadyInstall', () => {
  it('does not skip an explicit validation or an unknown remote version', () => {
    assert.equal(shouldSkipSteamcmdForReadyInstall({
      localBuildId: '25540104', remoteBuildId: '25540104', forceSteamcmd: true,
    }), false)
    assert.equal(shouldSkipSteamcmdForReadyInstall({ localBuildId: '25540104' }), false)
  })
  it('skips when build ids match and no update flag', () => {
    assert.equal(shouldSkipSteamcmdForReadyInstall({
      updateAvailable: false,
      remoteBuildId: '23001980',
      localBuildId: '23001980',
    }), true)
  })

  it('runs steam when updateAvailable is true', () => {
    assert.equal(shouldSkipSteamcmdForReadyInstall({
      updateAvailable: true,
      remoteBuildId: '23001981',
      localBuildId: '23001980',
    }), false)
  })

  it('runs steam when local build differs from remote', () => {
    assert.equal(shouldSkipSteamcmdForReadyInstall({
      updateAvailable: false,
      remoteBuildId: '23001981',
      localBuildId: '23001980',
    }), false)
  })
})
