import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { after, afterEach, it } from 'node:test'
import { runNativeSteamcmdJob, cancelNativeSteamcmdJob, runSteamcmdWorkshopDownloadNative } from './native-steamcmd-runner'
import { parsePublicBuildIdFromAppInfo } from '../../shared/steam-update/app-info'
import { registerNativeSteamcmdProcess, cancelRecordedNativeSteamcmdProcess } from './native-steamcmd-process'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-steamcmd-query-'))
const previousPath = process.env.BSP_NATIVE_STEAMCMD_PATH
const envKeys = ['HOME', 'BSP_STEAMCMD_DOWNLOAD_REGION', 'GSH_STEAMCMD_DOWNLOAD_REGION', 'STEAMCMD_FORCE_DOWNLOAD_REGION', 'BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS', 'BSP_NATIVE_RUNTIME_DIR']
const previousEnv = envKeys.map(key => process.env[key])
afterEach(() => envKeys.forEach((key, index) => {
  if (previousEnv[index] === undefined) delete process.env[key]
  else process.env[key] = previousEnv[index]
}))
process.env.BSP_NATIVE_STEAMCMD_PATH = process.execPath
after(() => {
  if (previousPath === undefined) {
    delete process.env.BSP_NATIVE_STEAMCMD_PATH
  }
  else {
    process.env.BSP_NATIVE_STEAMCMD_PATH = previousPath
  }
  fs.rmSync(root, { recursive: true, force: true })
})

async function run(source: string, timeoutMs = 5000, options: Partial<Parameters<typeof runNativeSteamcmdJob>[0]> = {}) {
  const script = path.join(root, 'fake-steamcmd.cjs')
  fs.writeFileSync(script, source)
  return runNativeSteamcmdJob({ kind: 'app-info', timeoutMs, ...options, args: [script, ...(options.args ?? [])] })
}

it('collects split stdout including more than 80 lines and an unterminated final line', async () => {
  const result = await run(`
    process.stdout.write('"343050" {\\n"depots" {\\n');
    for (let i = 0; i < 100; i++) console.log('"depot' + i + '" { "public" { "gid" "1" } }');
    process.stdout.write('"branches" { "pub');
    setTimeout(() => process.stdout.write('lic" { "buildid" "25643504" } "updatebeta" { "buildid" "25540104" } } } }'), 20);
  `)
  assert.equal(result.ok, true)
  assert.equal(parsePublicBuildIdFromAppInfo(result.output, '343050'), '25643504')
})

it('rejects excess output, nonzero exits and timeouts', async () => {
  const excess = await run(`process.stdout.write(' '.repeat(1024 * 1024 + 1))`)
  assert.equal(excess.ok, false)
  assert.match(excess.output, /超过 1 MiB/)
  const failed = await run(`console.log('"appid" "343050"'); process.exitCode = 1`)
  assert.equal(failed.ok, false)
  const timeout = await run('setInterval(() => {}, 1000)', 100)
  assert.equal(timeout.ok, false)
  assert.equal(timeout.timedOut, true)
})

it('terminates safely when writing installation progress fails', async () => {
  const result = await run("console.log('READY'); setInterval(() => {}, 1000)", 5000, {
    onLogLine: () => { throw new Error('EACCES: install log unavailable') },
  })
  assert.equal(result.ok, false)
  assert.match(result.output, /EACCES/)
})

it('collects only this native job diagnostics and redacts secrets', async () => {
  process.env.HOME = root
  const logs = path.join(root, 'Steam', 'logs')
  fs.mkdirSync(logs, { recursive: true })
  fs.writeFileSync(path.join(logs, 'content_log.txt'), 'OLD: Not enough disk space\n')
  const received: string[] = []
  const result = await run(`
    const fs = require('fs'); const path = require('path');
    const logs = path.join(process.env.HOME, 'Steam', 'logs');
    console.log('Logging directory: ' + logs);
    setTimeout(() => {
      fs.appendFileSync(path.join(logs, 'content_log.txt'), 'CURRENT: HTTP error 503 user-secret pass-secret\\n');
      fs.writeFileSync(path.join(logs, 'stderr.txt'), 'https://u:p@cdn/file?token=secret-token\\n');
      console.log("Error! App '343050' state is 0x402 after update job.");
      process.exitCode = 8;
    }, 20);
  `, 5000, { kind: 'app-update', args: ['+login', 'user-secret', 'pass-secret'], onLogLine: line => received.push(line) })
  assert.equal(result.ok, false)
  assert.match(result.output, /CURRENT: HTTP error 503/)
  assert.match(result.output, /0x402/)
  assert.doesNotMatch(result.output, /OLD:|Not enough disk|user-secret|pass-secret|u:p|secret-token/)
  assert.match(received.join('\n'), /content_log.txt/)
})

it('ignores canonical and legacy region configs and the old injected environment', async () => {
  for (const key of ['BSP_STEAMCMD_DOWNLOAD_REGION', 'GSH_STEAMCMD_DOWNLOAD_REGION']) {
    process.env[key] = 'cn'
    process.env.STEAMCMD_FORCE_DOWNLOAD_REGION = 'china'
    const result = await run("console.log('REGION:' + String(process.env.STEAMCMD_FORCE_DOWNLOAD_REGION))")
    assert.match(result.output, /REGION:undefined/)
    delete process.env[key]
  }
})

it('honors a cancellation before spawn and during the workshop start callback', async () => {
  await cancelNativeSteamcmdJob('before-spawn')
  const result = await run("throw new Error('must not start')", 5000, { kind: 'app-update', cancelKey: 'before-spawn' })
  assert.equal(result.cancelled, true)
  assert.doesNotMatch(result.output, /must not start/)
  process.env.BSP_STEAMCMD_INTER_JOB_COOLDOWN_MS = '0'
  const workshop = await runSteamcmdWorkshopDownloadNative({
    hostInstallPath: root, workshopIds: ['123'], cancelKey: 'workshop-before-spawn',
    onDownloadStart: () => cancelNativeSteamcmdJob('workshop-before-spawn'),
  })
  assert.equal(workshop.cancelled, true)
})

it('cancels a running native job and permits a later job with the same key', async () => {
  const result = await run("console.log('READY'); setInterval(() => {}, 1000)", 5000, {
    kind: 'app-update', cancelKey: 'running-native',
    onLogLine: line => { if (line === 'READY') void cancelNativeSteamcmdJob('running-native') },
  })
  assert.equal(result.cancelled, true)
  assert.equal(result.timedOut, false)
  const later = await run("console.log('DONE')", 5000, { cancelKey: 'running-native' })
  assert.equal(later.ok, true)
})

it('kills a Linux process group including a child ignoring SIGTERM', { skip: process.platform !== 'linux' }, async () => {
  const pidFile = path.join(root, 'descendant.pid')
  const result = await run(`
    const {spawn} = require('child_process'); const fs = require('fs');
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000)"], {stdio: ['ignore', 'pipe', 'inherit']});
    child.stdout.once('data', () => { fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); console.log('READY'); });
    setInterval(() => {}, 1000);
  `, 1000, { kind: 'app-update' })
  assert.equal(result.timedOut, true)
  const pid = Number(fs.readFileSync(pidFile, 'utf8'))
  // Linux 上已死亡但尚未被 init 回收的子进程可能短暂处于 zombie 状态。
  const stat = `/proc/${pid}/stat`
  if (fs.existsSync(stat)) assert.match(fs.readFileSync(stat, 'utf8'), /\) Z /)
})

it('cleans a recorded Linux process after losing the in-memory task, without killing reused PIDs', { skip: process.platform !== 'linux' }, async (t) => {
  process.env.BSP_NATIVE_RUNTIME_DIR = root
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const closed = once(child, 'close')
  t.after(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* 已结束。 */ } })
  await once(child.stdout!, 'data')
  const forget = registerNativeSteamcmdProcess('restarted', child.pid!)
  const file = path.join(root, 'steamcmd-jobs', 'restarted.json')
  const recorded = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.writeFileSync(file, JSON.stringify({ ...recorded, started: '0' }))
  await cancelRecordedNativeSteamcmdProcess('restarted')
  assert.doesNotThrow(() => process.kill(child.pid!, 0), 'a reused identity is not killed')
  registerNativeSteamcmdProcess('restarted', child.pid!)
  await cancelRecordedNativeSteamcmdProcess('restarted')
  assert.equal(fs.existsSync(file), false)
  await closed
  assert.throws(() => process.kill(child.pid!, 0))
  forget()
})

it('emits native carriage-return progress before the process exits, including split CRLF', async () => {
  const received: string[] = []
  const result = await run(`
    process.stdout.write('Update state (0x61) downloading, progress: 56.25\\r');
    setTimeout(() => process.stderr.write('checkpoint\\n'), 40);
    setTimeout(() => process.stdout.write('\\nUpdate state (0x81) verifying update, progress: 2'), 80);
  `, 5000, { kind: 'app-update', onLogLine: line => received.push(line) })
  assert.equal(result.ok, true)
  assert.deepEqual(received, [
    'Update state (0x61) downloading, progress: 56.25',
    'checkpoint',
    'Update state (0x81) verifying update, progress: 2',
  ])
})
