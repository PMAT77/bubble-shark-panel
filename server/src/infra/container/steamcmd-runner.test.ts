import assert from 'node:assert/strict'

import { describe, it } from 'node:test'

import { buildSteamcmdAppUpdateArgs, buildSteamcmdWorkshopDownloadArgs } from './steamcmd-args.ts'



describe('buildSteamcmdAppUpdateArgs', () => {

  it('places force_install_dir before login and updates target app only', () => {

    const args = buildSteamcmdAppUpdateArgs('/game', '343050', ['+login', 'anonymous'])

    const forceIdx = args.indexOf('+force_install_dir')

    const loginIdx = args.indexOf('+login')

    const appUpdateIdx = args.indexOf('+app_update')

    assert.ok(forceIdx >= 0)

    assert.ok(loginIdx >= 0)

    assert.ok(appUpdateIdx >= 0)

    assert.ok(forceIdx < loginIdx, `expected force_install_dir before login, got: ${args.join(' ')}`)

    assert.ok(loginIdx < appUpdateIdx, `expected login before app_update, got: ${args.join(' ')}`)

    assert.equal(args[forceIdx + 1], '/game')

    assert.equal(args[appUpdateIdx + 1], '343050')

    assert.equal(args.filter(item => item === '+app_update').length, 1)

    assert.ok(args.includes('linux'))

  })

  it('ignores legacy region options for both game and workshop commands', () => {
    const args = buildSteamcmdAppUpdateArgs('/game', '343050', ['+login', 'anonymous'], {
      downloadRegion: 'cn',
    })
    assert.deepEqual(args, buildSteamcmdAppUpdateArgs('/game', '343050', ['+login', 'anonymous']))
    const workshop = buildSteamcmdWorkshopDownloadArgs('/game', '322330', ['123'], ['+login', 'anonymous'], { downloadRegion: 'cn' })
    assert.deepEqual(workshop, buildSteamcmdWorkshopDownloadArgs('/game', '322330', ['123'], ['+login', 'anonymous']))
    assert.ok(workshop.indexOf('+force_install_dir') < workshop.indexOf('+login'))
    assert.ok(workshop.includes('validate'))
  })

})


