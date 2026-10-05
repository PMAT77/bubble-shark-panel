import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  appendSteamcmdBindMountOptions,
  resolveSteamcmdContainerUidGid,
  resolveSteamcmdContainerUser,
} from './steamcmd-container-user.ts'

describe('steamcmd-container-user', () => {
  afterEach(() => {
    delete process.env.BSP_STEAMCMD_RUN_USER
    delete process.env.BSP_STEAMCMD_BIND_OPTS
  })

  it('defaults to 1000:1000', () => {
    assert.equal(resolveSteamcmdContainerUser(), '1000:1000')
    assert.deepEqual(resolveSteamcmdContainerUidGid(), { uid: 1000, gid: 1000 })
  })

  it('reads BSP_STEAMCMD_RUN_USER', () => {
    process.env.BSP_STEAMCMD_RUN_USER = '0:0'
    assert.equal(resolveSteamcmdContainerUser(), '0:0')
    assert.deepEqual(resolveSteamcmdContainerUidGid(), { uid: 0, gid: 0 })
  })

  it('appends bind mount options once', () => {
    process.env.BSP_STEAMCMD_BIND_OPTS = 'rw,z'
    assert.equal(
      appendSteamcmdBindMountOptions('vol:/instances'),
      'vol:/instances:rw,z',
    )
    assert.equal(
      appendSteamcmdBindMountOptions('vol:/instances:rw,z'),
      'vol:/instances:rw,z',
    )
  })
})
