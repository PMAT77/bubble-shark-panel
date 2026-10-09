import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it, type TestContext } from 'node:test'
import { deleteInstallLogFile, INSTALL_LOG_TAIL_BYTES, InstanceInstallLogWriter, readInstallLogTail, readInstallProgress } from './log-store'

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-install-log-'))
  const writer = new InstanceInstallLogWriter(dir, 'test')
  t.after(() => { writer.dispose(); fs.rmSync(dir, { recursive: true, force: true }) })
  writer.clear(3)
  return { dir, writer, file: path.join(dir, 'test.log') }
}

it('retains thousands of raw lines and stage history while coalescing snapshots', (t) => {
  const { dir, writer, file } = fixture(t)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const rename = t.mock.method(fs, 'renameSync')
  writer.appendLine('Connecting anonymously to Steam Public...OK')
  for (let i = 1; i <= 3000; i++) writer.appendLine(`Update state (0x61) downloading, progress: ${(i / 30).toFixed(2)}`)
  assert.equal(rename.mock.callCount(), 2, 'only stage changes are saved immediately')
  assert.equal(fs.readFileSync(file, 'utf8').trimEnd().split('\n').length, 3001)
  assert.equal(writer.progress.percent, 100)
  assert.equal(writer.progress.status, 'running', 'download 100% is not installation success')
  t.mock.timers.tick(1000)
  const progress = readInstallProgress(dir, 'test')!
  assert.equal(progress.percent, 100)
  assert.deepEqual(progress.events.map(event => event.message), ['安装任务已开始', '连接 Steam', '下载游戏文件'])
  assert.equal(readInstallLogTail(dir, 'test')!.content.split('\n').length, 500)
  assert.ok(writer.readContent().includes('progress: 0.03'))
})

it('resets percentages at stage and attempt boundaries and rejects late terminal updates', (t) => {
  const { dir, writer } = fixture(t)
  writer.appendLine('Update state (0x61) downloading, progress: 56.25')
  writer.appendLine('[SteamCMD 诊断] Update state (0x81) verifying update, progress: 99')
  writer.appendLine('progress: 80')
  assert.equal(writer.progress.phaseCode, 'download')
  assert.equal(writer.progress.percent, 56.25)
  writer.appendLine('Update state (0x81) verifying update')
  assert.equal(writer.progress.percent, null)
  writer.appendLine('Update state (0x81) verifying update, progress: 30')
  writer.waitForRetry(2, 3, 8000)
  assert.equal(writer.progress.phaseCode, 'retry')
  assert.equal(writer.progress.percent, null)
  assert.ok(writer.progress.retryAt)
  writer.beginAttempt(2, 3, true)
  assert.equal(writer.progress.phaseCode, 'connect')
  assert.equal(writer.progress.retryAt, null)
  writer.appendLine('Update state (0x61) downloading, progress: 10')
  writer.beginAttempt(1, 3, true)
  assert.equal(writer.progress.percent, null)
  writer.finish('failed', '安装已由用户中断')
  const terminal = structuredClone(writer.progress)
  writer.appendLine('Update state (0x61) downloading, progress: 99')
  writer.finish('success', '迟到的完成输出')
  assert.deepEqual(writer.progress, terminal)
  assert.deepEqual(new InstanceInstallLogWriter(dir, 'test').progress, terminal, 'reopening restores stage and events')
  writer.clear(3)
  assert.equal(writer.readContent(), '')
  assert.equal(readInstallProgress(dir, 'test')!.failure, null)
  assert.equal(readInstallProgress(dir, 'test')!.events.length, 1)
})

it('reads a bounded UTF-8 tail and cleans up both raw log and snapshot', (t) => {
  const { dir, file, writer } = fixture(t)
  fs.writeFileSync(file, Array.from({ length: 2000 }, (_, index) => `日志-${index} ${'中文'.repeat(30)}`).join('\n') + '\n')
  const read = t.mock.method(fs, 'readSync')
  const tail = readInstallLogTail(dir, 'test')!
  assert.equal(tail.truncated, true)
  assert.ok(tail.content.endsWith(`日志-1999 ${'中文'.repeat(30)}`))
  assert.ok(tail.content.split('\n').length <= 500)
  assert.ok(Buffer.byteLength(tail.content) <= INSTALL_LOG_TAIL_BYTES)
  assert.ok(!tail.content.includes('\uFFFD'))
  assert.ok(read.mock.calls.every(call => Number((call.arguments as unknown[])[3]) <= INSTALL_LOG_TAIL_BYTES))
  writer.dispose()
  deleteInstallLogFile(dir, 'test')
  assert.equal(readInstallLogTail(dir, 'test'), null)
  assert.equal(readInstallProgress(dir, 'test'), null)
})
