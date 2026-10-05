import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { buildSteamcmdWorkshopDownloadArgs } from '../../container/steamcmd-args'
import { DST_CLUSTER_NAME, DST_WORKSHOP_APP_ID } from './constants'
import {
  collectMissingWorkshopIds,
  detectWorkshopDownloadFailure,
  formatModDownloadFailureMessage,
  isDstWorkshopModPresent,
  resolveDstSteamWorkshopModDir,
  resolveWorkshopDownloadIds,
} from './mod-download'

const tempDirs: string[] = []

function createInstallPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-mod-download-'))
  tempDirs.push(dir)
  return dir
}

function writeModMarker(installPath: string, workshopId: string, location: 'steamapps' | 'ugc-master') {
  const modDir = location === 'steamapps'
    ? resolveDstSteamWorkshopModDir(installPath, workshopId)
    : path.join(
        installPath,
        'ugc_mods',
        DST_CLUSTER_NAME,
        'Master',
        'content',
        DST_WORKSHOP_APP_ID,
        workshopId,
      )
  fs.mkdirSync(modDir, { recursive: true })
  fs.writeFileSync(path.join(modDir, 'modinfo.lua'), 'name = "Test Mod"\n')
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('mod-download', () => {
  it('detects workshop mod in steamapps path', () => {
    const installPath = createInstallPath()
    writeModMarker(installPath, '12345', 'steamapps')
    assert.equal(isDstWorkshopModPresent(installPath, '12345'), true)
    assert.equal(isDstWorkshopModPresent(installPath, '99999'), false)
  })

  it('detects workshop mod in ugc_mods master path', () => {
    const installPath = createInstallPath()
    writeModMarker(installPath, '67890', 'ugc-master')
    assert.equal(isDstWorkshopModPresent(installPath, '67890'), true)
  })

  it('detects V2 workshop download via legacy.bin', () => {
    const installPath = createInstallPath()
    const modDir = resolveDstSteamWorkshopModDir(installPath, '501385076')
    fs.mkdirSync(modDir, { recursive: true })
    fs.writeFileSync(path.join(modDir, '1665728219799633209_legacy.bin'), Buffer.from('legacy'))
    assert.equal(isDstWorkshopModPresent(installPath, '501385076'), true)
  })

  it('detects V1 workshop download via mod.manifest', () => {
    const installPath = createInstallPath()
    const modDir = resolveDstSteamWorkshopModDir(installPath, '2074508776')
    fs.mkdirSync(modDir, { recursive: true })
    fs.writeFileSync(path.join(modDir, 'mod.manifest'), 'manifest')
    assert.equal(isDstWorkshopModPresent(installPath, '2074508776'), true)
  })

  it('collects only missing workshop ids', () => {
    const installPath = createInstallPath()
    writeModMarker(installPath, '111', 'steamapps')
    assert.deepEqual(
      collectMissingWorkshopIds(installPath, ['111', '222', '222']),
      ['222'],
    )
  })

  it('keeps already-present ids when force is set (update path)', () => {
    const installPath = createInstallPath()
    writeModMarker(installPath, '111', 'steamapps')
    // 非强制：已就绪的 Mod 不必再走 SteamCMD
    assert.deepEqual(resolveWorkshopDownloadIds(installPath, ['111', '222']), ['222'])
    // 强制更新：已就绪的 Mod 也必须交给 SteamCMD 重新校验，否则「更新」按钮永远不下载
    assert.deepEqual(resolveWorkshopDownloadIds(installPath, ['111', '222'], { force: true }), ['111', '222'])
    assert.deepEqual(resolveWorkshopDownloadIds(installPath, [' 111 ', '111'], { force: true }), ['111'])
  })

  it('formats common download failure messages', () => {
    assert.match(formatModDownloadFailureMessage('Connection timed out'), /超时/)
    assert.match(formatModDownloadFailureMessage('Access Denied'), /无法下载/)
    assert.match(formatModDownloadFailureMessage('Missing file permissions'), /权限/)
    assert.match(formatModDownloadFailureMessage(''), /网络/)
  })

  it('detects SteamCMD failures that still exit with code 0', () => {
    // 退出码为 0 但日志已报错：旧文件还在盘上，光看文件存在性会把它当成更新成功
    assert.ok(detectWorkshopDownloadFailure('ERROR! Failed to download workshop item 12345'))
    assert.ok(detectWorkshopDownloadFailure('ERROR! Access Denied'))
    assert.ok(detectWorkshopDownloadFailure('No subscription'))
    // 正常日志不能被误判
    assert.equal(detectWorkshopDownloadFailure('Success. Downloaded item 12345 to "/game/steamapps/workshop/content/322330/12345"'), null)
    assert.equal(detectWorkshopDownloadFailure(''), null)
  })
})

describe('buildSteamcmdWorkshopDownloadArgs', () => {
  it('places force_install_dir before login and chains workshop downloads', () => {
    const args = buildSteamcmdWorkshopDownloadArgs(
      '/game',
      DST_WORKSHOP_APP_ID,
      ['111', '222'],
      ['+login', 'anonymous'],
    )
    const forceIdx = args.indexOf('+force_install_dir')
    const loginIdx = args.indexOf('+login')
    const firstDownloadIdx = args.indexOf('+workshop_download_item')
    assert.ok(forceIdx >= 0)
    assert.ok(loginIdx >= 0)
    assert.ok(firstDownloadIdx >= 0)
    assert.ok(forceIdx < loginIdx)
    assert.ok(loginIdx < firstDownloadIdx)
    assert.equal(args[forceIdx + 1], '/game')
    assert.equal(args.filter(item => item === '+workshop_download_item').length, 2)
    assert.deepEqual(args.slice(firstDownloadIdx, firstDownloadIdx + 4), [
      '+workshop_download_item',
      DST_WORKSHOP_APP_ID,
      '111',
      'validate',
    ])
    assert.ok(args.includes('+quit'))
  })
})
