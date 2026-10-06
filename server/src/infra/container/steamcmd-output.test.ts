import assert from 'node:assert/strict'
import { it } from 'node:test'
import { SteamcmdOutput, STEAMCMD_APP_INFO_MAX_BYTES } from './steamcmd-output'

it('preserves app-info beyond 80 lines and keeps install diagnostics short', () => {
  const info = new SteamcmdOutput(true)
  const install = new SteamcmdOutput(false)
  for (let i = 0; i < 150; i++) {
    info.acceptChunk(`line ${i}\n`)
    install.acceptChunk(`line ${i}\n`)
    info.push(`line ${i}`)
    install.push(`line ${i}`)
  }
  assert.equal(info.output.split('\n').length, 150)
  assert.equal(info.output.split('\n')[0], 'line 0')
  assert.equal(install.output.split('\n').length, 20)
  assert.equal(install.output.split('\n')[0], 'line 130')
})

it('discards over-limit app-info instead of returning parseable partial data', () => {
  const info = new SteamcmdOutput(true)
  info.acceptChunk('"public" { "buildid" "25643504" }\n')
  info.push('"public" { "buildid" "25643504" }')
  assert.equal(info.acceptChunk('字'.repeat(STEAMCMD_APP_INFO_MAX_BYTES / 3)), false)
  info.push('字'.repeat(STEAMCMD_APP_INFO_MAX_BYTES / 3))
  info.push('"updatebeta" { "buildid" "25540104" }')
  assert.equal(info.overflowed, true)
  assert.match(info.output, /超过 1 MiB/)
  assert.doesNotMatch(info.output, /buildid/)
})

it('counts untrimmed chunks and rejects excess before a line is complete', () => {
  const info = new SteamcmdOutput(true)
  assert.equal(info.acceptChunk(' '.repeat(STEAMCMD_APP_INFO_MAX_BYTES)), true)
  assert.equal(info.acceptChunk('x'), false)
  assert.equal(info.overflowed, true)
  assert.match(info.output, /超过 1 MiB/)
})

it('keeps the principal error and timeout marker alongside bounded diagnostics', () => {
  const output = new SteamcmdOutput(false)
  output.push("Error! App '343050' state is 0x402 after update job.")
  output.push('GSH-STEAMCMD-TIMEOUT: failed after timeout')
  output.push('BSP-STEAMCMD-OOM: Docker 确认容器被 OOM 终止')
  for (let i = 0; i < 100; i++) output.push(`progress ${i}`)
  output.pushDiagnostic('[SteamCMD 诊断] content_log.txt')
  output.pushDiagnostic('Not enough disk space')
  assert.match(output.output, /0x402/)
  assert.match(output.output, /GSH-STEAMCMD-TIMEOUT/)
  assert.match(output.output, /BSP-STEAMCMD-OOM/)
  assert.match(output.output, /Not enough disk space/)
})
