import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { isInstallSeedEnabled, shouldDeferDstImagePullOnInstall } from './install.ts'

describe('install config', () => {
  afterEach(() => {
    delete process.env.BSP_INSTALL_SEED_ENABLED
    delete process.env.BSP_INSTALL_DEFER_DST_IMAGE_PULL
  })

  it('enables install seed by default', () => {
    assert.equal(isInstallSeedEnabled(), true)
  })

  it('disables install seed when env is 0', () => {
    process.env.BSP_INSTALL_SEED_ENABLED = '0'
    assert.equal(isInstallSeedEnabled(), false)
  })

  it('always prepares the runtime image before installation succeeds', () => {
    assert.equal(shouldDeferDstImagePullOnInstall(), false)
  })

  it('pulls dst image on install when defer disabled', () => {
    process.env.BSP_INSTALL_DEFER_DST_IMAGE_PULL = '1'
    assert.equal(shouldDeferDstImagePullOnInstall(), false)
  })
})
