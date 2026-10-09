import assert from 'node:assert/strict'
import { it } from 'node:test'
import { formatInstallLogContent, parseInstallLogPhase, parseSteamcmdProgressPercent, summarizeInstallFailure } from './log-format'

it('preserves stage percentages and distinguishes actual SteamCMD stages', () => {
  assert.equal(parseSteamcmdProgressPercent('Update state (0x61) downloading, progress: 56.25'), 56.25)
  assert.equal(parseSteamcmdProgressPercent('[ 42%] Downloading update'), 42)
  assert.equal(parseSteamcmdProgressPercent('progress: 120'), 100)
  assert.equal(parseSteamcmdProgressPercent('progress: unknown'), null)
  for (const [state, expected] of [['downloading', 'download'], ['verifying', 'verify'], ['validating', 'verify'], ['staging', 'stage'], ['committing', 'commit']] as const) {
    assert.equal(parseInstallLogPhase(`Update state (0x61) ${state}, progress: 50`), expected)
  }
  assert.equal(parseInstallLogPhase('Connecting anonymously to Steam Public...Retrying...'), 'connect')
  assert.equal(parseInstallLogPhase("Success! App '343050' fully installed."), 'finalize')
  assert.equal(parseInstallLogPhase('正在准备游戏运行环境镜像'), 'runtime')
  for (const text of ['progress: 90', '[SteamCMD 诊断] Update state (0x61) downloading, progress: 20', '[资源快照] progress: 50', 'Unknown update message']) {
    assert.equal(parseInstallLogPhase(text), null)
  }
})

it('cleans ANSI and carriage returns without collapsing progress history', () => {
  const raw = '\u0001ERROR!\r\n[0m Update state (0x61) downloading, progress: 50.00\rUpdate state (0x61) downloading, progress: 99.00'
  assert.equal(formatInstallLogContent(raw), 'ERROR!\nUpdate state (0x61) downloading, progress: 50.00\nUpdate state (0x61) downloading, progress: 99.00')
})

it('uses evidence-based failure advice and removes technical output from the summary', () => {
  const failure = summarizeInstallFailure('SteamCMD 安装失败：磁盘写入失败。SteamCMD 输出：Not enough disk space')
  assert.equal(failure.message, '磁盘空间不足或写入失败。')
  assert.match(failure.advice, /磁盘/)
  assert.match(summarizeInstallFailure('SteamCMD 网络连接失败。SteamCMD 输出：network connection failed').advice, /网络/)
  assert.equal(summarizeInstallFailure('SteamCMD 镜像未就绪：unauthorized').code, 'image_pull_failed')
  const native = summarizeInstallFailure('SteamCMD 启动失败: spawn /tools/steamcmd EACCES')
  assert.equal(native.code, 'steamcmd_unavailable')
  assert.match(native.advice, /执行权限/)
})
