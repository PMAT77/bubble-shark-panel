import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { it } from 'node:test'
import { buildSteamcmdCachedAppUpdateCommand } from './steamcmd-depot-cache'

it('preserves Depot manifests across fresh SteamCMD homes and passes arguments literally', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-depot-cache-'))
  try {
    const install = path.join(root, 'game with spaces')
    const cache = path.join(install, '.bsp-steamcmd/depotcache')
    const literal = 'password with $dollars `backticks` and "quotes"'
    const run = (home: string, code: string) => {
      const cmd = buildSteamcmdCachedAppUpdateCommand(install, ['-e', code, '--', literal])
      cmd[5] = process.execPath
      const result = spawnSync(cmd[0], cmd.slice(1), { env: { ...process.env, HOME: home }, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    const firstHome = path.join(root, 'first-home')
    fs.mkdirSync(path.join(firstHome, 'Steam/depotcache'), { recursive: true })
    fs.writeFileSync(path.join(firstHome, 'Steam/depotcache/image.manifest'), 'preloaded')
    run(firstHome, `require('node:fs').writeFileSync(process.env.HOME + '/Steam/depotcache/343052.manifest', process.argv[1])`)
    assert.equal(fs.readFileSync(path.join(cache, 'image.manifest'), 'utf8'), 'preloaded')
    assert.equal(fs.readFileSync(path.join(cache, '343052.manifest'), 'utf8'), literal)
    const secondHome = path.join(root, 'second-home')
    run(secondHome, `require('node:assert/strict').equal(require('node:fs').readFileSync(process.env.HOME + '/Steam/depotcache/343052.manifest', 'utf8'), process.argv[1])`)
    run(secondHome, '')
    assert.equal(fs.readlinkSync(path.join(secondHome, 'Steam/depotcache')), cache)
  }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
})
