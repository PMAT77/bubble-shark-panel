import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  classifySteamcmdInstallFailure,
  formatSteamcmdAppUpdateFailureMessage,
  isRetriableSteamcmdInstallOutput,
  redactSteamcmdLogLine,
  steamcmdLogSecrets,
  STEAMCMD_OOM_MARKER,
  sanitizeSteamcmdLogLine,
  STEAMCMD_TIMEOUT_MARKER,
} from './steamcmd-errors.ts'

describe('sanitizeSteamcmdLogLine', () => {
  it('strips docker multiplex control bytes', () => {
    assert.equal(sanitizeSteamcmdLogLine('\u0001ERROR! test'), 'ERROR! test')
  })

  it('strips ANSI SGR sequences', () => {
    assert.equal(
      sanitizeSteamcmdLogLine('\u001B[0mSuccess! App \'343050\' fully installed.'),
      'Success! App \'343050\' fully installed.',
    )
  })

  it('preserves SteamCMD percent brackets', () => {
    assert.equal(
      sanitizeSteamcmdLogLine('[  0%] Downloading update...'),
      '[ 0%] Downloading update...',
    )
  })
})

describe('classifySteamcmdInstallFailure', () => {
  it('treats needs to be online as network', () => {
    assert.equal(
      classifySteamcmdInstallFailure('Fatal Error: Steamcmd needs to be online to update'),
      'network',
    )
  })

  it('treats Missing configuration as incomplete without asserting a root cause', () => {
    assert.equal(
      classifySteamcmdInstallFailure('ERROR! Failed to install app \'343050\' (Missing configuration)'),
      'incomplete',
    )
  })

  it('treats 0x602 as incomplete', () => {
    assert.equal(
      classifySteamcmdInstallFailure('Error! App \'343050\' state is 0x602 after update job'),
      'incomplete',
    )
  })
})

describe('formatSteamcmdAppUpdateFailureMessage', () => {
  it('explains Missing configuration without assuming network instability', () => {
    const message = formatSteamcmdAppUpdateFailureMessage({
      appId: '343050',
      output: 'ERROR! Failed to install app \'343050\' (Missing configuration)',
      mode: 'anonymous',
      hasAccountCredentials: false,
    })
    assert.match(message, /更新未完成/)
    assert.doesNotMatch(message, /BSP_STEAMCMD_DOWNLOAD_REGION/)
    assert.doesNotMatch(message, /bind/)
    assert.doesNotMatch(message, /STEAMCMD_USERNAME/)
  })

  it('explains Missing file permissions as mount permission issue', () => {
    const message = formatSteamcmdAppUpdateFailureMessage({
      appId: '343050',
      output: 'ERROR! Failed to install app \'343050\' (Missing file permissions)',
      mode: 'anonymous',
      hasAccountCredentials: false,
    })
    assert.match(message, /Missing file permissions/)
    assert.match(message, /BSP_STEAMCMD_RUN_USER/)
  })

  it('explains No subscription for account-only games', () => {
    const message = formatSteamcmdAppUpdateFailureMessage({
      appId: '380870',
      output: 'ERROR! Failed to install app \'380870\' (No subscription)',
      mode: 'anonymous',
      hasAccountCredentials: false,
    })
    assert.match(message, /No subscription/)
    assert.match(message, /STEAMCMD_USERNAME/)
  })
})

describe('isRetriableSteamcmdInstallOutput', () => {
  it('retries network-class failures only', () => {
    assert.equal(isRetriableSteamcmdInstallOutput('Missing configuration'), true)
    assert.equal(isRetriableSteamcmdInstallOutput('Missing file permissions'), false)
    assert.equal(isRetriableSteamcmdInstallOutput('No subscription'), false)
  })

  it('retries panel timeouts so the download resumes', () => {
    const output = `${STEAMCMD_TIMEOUT_MARKER}: app_update 超过 60 分钟上限，已终止容器`
    assert.equal(classifySteamcmdInstallFailure(output), 'timeout')
    assert.equal(isRetriableSteamcmdInstallOutput(output), true)

    const message = formatSteamcmdAppUpdateFailureMessage({
      appId: '343050',
      output,
      mode: 'anonymous',
      hasAccountCredentials: false,
    })
    assert.match(message, /下载超时/)
    assert.match(message, /BSP_STEAMCMD_APP_UPDATE_TIMEOUT_MS/)
    assert.doesNotMatch(message, /BSP_STEAMCMD_CONTAINER_MEMORY_MB/)
  })
})

describe('failure evidence and redaction', () => {
  it('retries the reported 0x402 failure but prioritizes explicit causes', () => {
    const output = "Update state (0x61) downloading, progress: 2.43\nError! App '343050' state is 0x402 after update job."
    assert.equal(classifySteamcmdInstallFailure(output), 'incomplete')
    assert.equal(isRetriableSteamcmdInstallOutput(output), true)
    for (const [evidence, kind] of [
      ['Not enough disk space', 'disk'], ['Permission denied', 'permission'],
      ['No subscription', 'subscription'], [STEAMCMD_OOM_MARKER, 'oom'],
    ]) {
      assert.equal(classifySteamcmdInstallFailure(`${output}\n${evidence}\n${STEAMCMD_TIMEOUT_MARKER}`), kind)
      assert.equal(isRetriableSteamcmdInstallOutput(`${output}\n${evidence}`), false)
    }
    assert.equal(classifySteamcmdInstallFailure('Fatal Error: unexpected local failure'), 'unknown')
    assert.equal(classifySteamcmdInstallFailure('CDN selected: good.example'), 'unknown')
    assert.equal(classifySteamcmdInstallFailure('Illegal termination of worker thread, individuals can ignore'), 'unknown')
    assert.equal(classifySteamcmdInstallFailure(`${output}\n[SteamCMD 诊断] stderr.txt 未采集：Permission denied`), 'incomplete')
  })

  it('removes login and proxy secrets, URL credentials and query tokens', () => {
    const secrets = steamcmdLogSecrets(['+login', 'private-user', 'private-password'], ['http://proxy-user:proxy-password@host:7890'])
    const text = redactSteamcmdLogLine('private-user private-password proxy-password https://u:p@cdn/file?token=abc&foo=ok&authKey=def', secrets)
    assert.doesNotMatch(text, /private-user|private-password|proxy-password|u:p|abc|def/)
    assert.match(text, /foo=ok/)
  })
})
