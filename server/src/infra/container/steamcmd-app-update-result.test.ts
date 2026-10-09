import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { validateSteamcmdAppUpdateResult } from './steamcmd-app-update-result'
import { isRetriableSteamcmdInstallOutput } from './steamcmd-errors'
import { resolveSteamcmdInstallPhase } from '../../shared/instance-install/log-format'

it('rejects success following an aborted update, verifies local files, and identifies stages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-result-'))
  try {
    fs.mkdirSync(path.join(root, 'steamapps'))
    fs.mkdirSync(path.join(root, 'bin64'))
    fs.mkdirSync(path.join(root, 'data'))
    fs.writeFileSync(path.join(root, 'bin64', 'dontstarve_dedicated_server_nullrenderer_x64'), 'fixture')
    fs.writeFileSync(path.join(root, 'data', 'fixture'), 'fixture')
    const manifest = path.join(root, 'steamapps', 'appmanifest_343050.acf')
    fs.writeFileSync(manifest, '"AppState" { "appid" "343050" "StateFlags" "4" "buildid" "123" "InstalledDepots" { "343052" { "manifest" "5351080740317260085" } } }')
    const success = { ok: true, output: "Success! App '343050' fully installed." }
    assert.equal(validateSteamcmdAppUpdateResult(success, root, '343050').ok, true)
    for (const error of ['Update state (0x0) : Timed out waiting for update to start, bailing.', 'Waiting for user info...ERROR! (Timed out)']) {
      const result = validateSteamcmdAppUpdateResult({ ...success, output: `${error}\n${success.output}` }, root, '343050')
      assert.equal(result.ok, false)
      assert.equal(isRetriableSteamcmdInstallOutput(result.output), true)
    }
    fs.rmSync(manifest)
    assert.equal(validateSteamcmdAppUpdateResult(success, root, '343050').ok, false)
    assert.equal(resolveSteamcmdInstallPhase('Connecting anonymously to Steam Public...Retrying...'), '连接 Steam')
    assert.equal(resolveSteamcmdInstallPhase('Update state (0x61) downloading, progress: 20'), '下载游戏文件')
    assert.equal(resolveSteamcmdInstallPhase('Update state (0x81) verifying update, progress: 50'), '校验游戏文件')
    assert.equal(resolveSteamcmdInstallPhase('[资源快照] MemAvailable: 5000'), null)
  }
  finally { fs.rmSync(root, { recursive: true, force: true }) }
})
