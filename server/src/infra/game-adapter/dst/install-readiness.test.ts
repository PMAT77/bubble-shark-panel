import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { buildGameFilesBlockedMessage, diagnoseDstInstallReadiness } from './install-readiness'

describe('diagnoseDstInstallReadiness', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeTempInstallDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-install-ready-'))
    tempDirs.push(dir)
    return dir
  }

  it('rejects binary-only install without data directory', () => {
    const installPath = makeTempInstallDir()
    fs.mkdirSync(path.join(installPath, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(installPath, 'bin', 'dontstarve_dedicated_server_nullrenderer'), 'bin')

    const result = diagnoseDstInstallReadiness(installPath)
    assert.equal(result.ready, false)
    assert.equal(result.code, 'missing_game_data')
  })

  it('accepts install when binary and non-empty data exist', () => {
    const installPath = makeTempInstallDir()
    fs.mkdirSync(path.join(installPath, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(installPath, 'bin', 'dontstarve_dedicated_server_nullrenderer'), 'bin')
    fs.mkdirSync(path.join(installPath, 'data', 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(installPath, 'data', 'scripts', 'main.lua'), '-- game')

    const result = diagnoseDstInstallReadiness(installPath)
    assert.equal(result.ready, true)
    assert.equal(result.code, 'ok')
  })
})

/**
 * 启动被阻断时给出的原因。
 *
 * 「实例是 error」不等于「安装没做好」：内存不足、端口占用这类启动/运行期失败同样是 error，
 * 把它们的原文当作"游戏文件未就绪"的说明，用户就会去重装服务端文件——而那解决不了问题。
 */
describe('buildGameFilesBlockedMessage', () => {
  const missingDir = { ready: false, code: 'missing_install_dir' as const, message: '安装目录不存在' }

  it('takes the previous install error as the reason when the install phase failed', () => {
    const message = buildGameFilesBlockedMessage(missingDir, {
      instanceStatus: 'error',
      lastErrorPhase: 'install',
      lastError: '安装失败：SteamCMD 退出码 8',
    })
    assert.match(message, /SteamCMD 退出码 8/)
  })

  it('does not report a runtime failure as the reason why game files are missing', () => {
    const message = buildGameFilesBlockedMessage(missingDir, {
      instanceStatus: 'error',
      lastErrorPhase: 'runtime',
      lastError: '宿主机可用内存不足（当前约 3365 MiB，可用 swap 约 0 MiB）',
    })
    assert.doesNotMatch(message, /可用内存不足/)
    assert.match(message, /安装目录不存在/)
  })

  it('falls back to install semantics when the phase is unknown (旧数据没有这个字段)', () => {
    const message = buildGameFilesBlockedMessage(missingDir, {
      instanceStatus: 'error',
      lastErrorPhase: null,
      lastError: '安装失败：磁盘空间不足',
    })
    assert.match(message, /磁盘空间不足/)
  })
})
