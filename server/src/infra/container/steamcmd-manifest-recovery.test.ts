import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { prepareSteamcmdManifestRecovery } from './steamcmd-manifest-recovery'

const oldGid = '5351080740317260085'
const newGid = '8683614463113575289'
const manifest = `"AppState" { "appid" "343050" "StateFlags" "6" "buildid" "25643504"
"InstalledDepots" { "343052" { "manifest" "${oldGid}" } } }`
const denied = `[SteamCMD 诊断] CDepotDownloadMgr::BYldRequestDepotManifest(App: 343050, Depot: 343052, Manifest: ${oldGid}, branch: ): Failed to get manifest request code, 'Access Denied'`
const output = `[SteamCMD 诊断] /depot/343052/manifest/${newGid}/5/code - manifest request received 200 (OK) HTTP response\n${denied}\nError! App '343050' state is 0x6 after update job.`
const roots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-manifest-recovery-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'steamapps'))
  const file = path.join(root, 'steamapps', 'appmanifest_343050.acf')
  fs.writeFileSync(file, manifest)
  return { root, file, input: { hostInstallPath: root, appId: '343050' } }
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('old Depot manifest recovery', () => {
  it('backs up only matching metadata and leaves retry execution to the existing budget', () => {
    const { root, file, input } = fixture()
    for (const name of ['game.bin', 'world.save', 'steamapps/downloading.partial']) fs.writeFileSync(path.join(root, name), name)
    const lines: string[] = []
    const result = prepareSteamcmdManifestRecovery({ ok: false, output, exitCode: 8 }, { ...input, onLogLine: line => lines.push(line) })
    assert.equal(result.ok, false)
    assert.equal(result.exitCode, 8)
    assert.equal(fs.existsSync(file), false)
    const backups = fs.readdirSync(path.dirname(file)).filter(name => name.includes('.denied-'))
    assert.equal(backups.length, 1)
    assert.equal(fs.readFileSync(path.join(path.dirname(file), backups[0]), 'utf8'), manifest)
    for (const name of ['game.bin', 'world.save', 'steamapps/downloading.partial']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), name)
    assert.match(result.output, /下一次尝试.*不增加重试次数/)
    assert.equal(lines.length, 1)
    prepareSteamcmdManifestRecovery({ ok: false, output }, input)
    assert.equal(fs.readdirSync(path.dirname(file)).filter(name => name.includes('.denied-')).length, 1)
  })

  for (const [name, text] of [
    ['no successful new manifest', denied],
    ['same manifest denied', output.replaceAll(newGid, oldGid)],
    ['other application', output.replace('App: 343050', 'App: 1')],
    ['other depot', output.replace('Depot: 343052', 'Depot: 1006')],
    ['other installed manifest', output.replace(`Manifest: ${oldGid}`, 'Manifest: 99')],
    ['unrelated access denial', 'Access Denied: directory permissions'],
    ['unconfirmed cleanup', `${output}\n无法确认 Docker 安装任务已停止`],
  ]) {
    it(`preserves metadata for ${name}`, () => {
      const { file, input } = fixture()
      prepareSteamcmdManifestRecovery({ ok: false, output: text }, input)
      assert.equal(fs.readFileSync(file, 'utf8'), manifest)
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['appmanifest_343050.acf'])
    })
  }
  for (const state of [{ ok: true }, { cancelled: true }, { timedOut: true }, { oomKilled: true }]) {
    it(`preserves metadata when ${JSON.stringify(state)}`, () => {
      const { file, input } = fixture()
      prepareSteamcmdManifestRecovery({ ok: false, output, ...state }, input)
      assert.equal(fs.readFileSync(file, 'utf8'), manifest)
    })
  }
  it('does not recover after cancellation or change another app manifest', () => {
    const { file, input } = fixture()
    prepareSteamcmdManifestRecovery({ ok: false, output }, { ...input, signal: AbortSignal.abort() })
    assert.equal(fs.readFileSync(file, 'utf8'), manifest)
    fs.writeFileSync(file, manifest.replace('"appid" "343050"', '"appid" "1"'))
    prepareSteamcmdManifestRecovery({ ok: false, output }, input)
    assert.equal(fs.existsSync(file), true)
  })
  it('leaves malformed metadata untouched', () => {
    const { file, input } = fixture()
    fs.writeFileSync(file, `${manifest.slice(0, -1)}`)
    prepareSteamcmdManifestRecovery({ ok: false, output }, input)
    assert.equal(fs.existsSync(file), true)
  })
  it('does not follow a manifest symlink', { skip: process.platform === 'win32' }, () => {
    const { root, file, input } = fixture()
    const original = path.join(root, 'original.acf')
    fs.renameSync(file, original)
    fs.symlinkSync(original, file)
    prepareSteamcmdManifestRecovery({ ok: false, output }, input)
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true)
    assert.equal(fs.readFileSync(original, 'utf8'), manifest)
  })
})
