import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  isInstallPathUnderInstancesRoot,
  isPosixAbsolutePath,
  resolveHostInstanceDirFromMountSource,
  resolveRelativeInstanceDir,
  shouldRejectDirectBindFallback,
  shouldUseDirectHostBind,
} from './steamcmd-install-bind.ts'

describe('isInstallPathUnderInstancesRoot', () => {
  it('matches instance directory under instances root', () => {
    const root = '/var/lib/bubblesharkpanel/instances'
    const install = '/var/lib/bubblesharkpanel/instances/f9ab99f7-2dea-4693-acd7-787bb265d07b'
    assert.equal(isInstallPathUnderInstancesRoot(install, root), true)
  })

  it('rejects unrelated paths', () => {
    assert.equal(
      isInstallPathUnderInstancesRoot('/opt/games/dst', '/var/lib/bubblesharkpanel/instances'),
      false,
    )
  })
})

describe('shouldUseDirectHostBind', () => {
  it('uses direct bind for Windows install paths even under instances root', () => {
    const root = 'D:\\WorkStation\\bubblesharkpanel\\server\\data\\instances'
    const install = `${root}\\instance-id`
    assert.equal(shouldUseDirectHostBind(install, root), true)
  })

  it('uses direct bind for paths outside instances root', () => {
    assert.equal(
      shouldUseDirectHostBind('/opt/games/dst', '/var/lib/bubblesharkpanel/instances'),
      true,
    )
  })

  it('does not force direct bind for POSIX paths under instances root', () => {
    const root = '/var/lib/bubblesharkpanel/instances'
    const install = `${root}/instance-id`
    assert.equal(shouldUseDirectHostBind(install, root), false)
  })
})

describe('shouldRejectDirectBindFallback', () => {
  it('rejects silent fallback for POSIX paths under instances root', () => {
    const root = '/var/lib/bubblesharkpanel/instances'
    const install = `${root}/instance-id`
    assert.equal(shouldRejectDirectBindFallback(install, root), true)
  })

  it('allows fallback for Windows paths', () => {
    const root = 'D:\\data\\instances'
    const install = `${root}\\instance-id`
    assert.equal(shouldRejectDirectBindFallback(install, root), false)
  })
})

describe('isPosixAbsolutePath', () => {
  it('detects POSIX absolute paths', () => {
    assert.equal(isPosixAbsolutePath('/var/lib/bubblesharkpanel/instances/x'), true)
    assert.equal(isPosixAbsolutePath('D:\\data\\instances\\x'), false)
  })
})

describe('resolveRelativeInstanceDir', () => {
  it('returns instance id segment under instances root', () => {
    const root = '/var/lib/bubblesharkpanel/instances'
    const install = `${root}/ea0d5fdf-ac51-4ad4-a684-ba861b019d08`
    assert.equal(resolveRelativeInstanceDir(install, root), 'ea0d5fdf-ac51-4ad4-a684-ba861b019d08')
  })

  it('rejects paths outside instances root', () => {
    assert.equal(resolveRelativeInstanceDir('/opt/dst', '/var/lib/bubblesharkpanel/instances'), null)
  })
})

describe('resolveHostInstanceDirFromMountSource', () => {
  it('joins volume mountpoint with relative instance dir', () => {
    assert.equal(
      resolveHostInstanceDirFromMountSource('/var/lib/docker/volumes/bsp-instances/_data', 'instance-a'),
      path.join('/var/lib/docker/volumes/bsp-instances/_data', 'instance-a'),
    )
  })
})
