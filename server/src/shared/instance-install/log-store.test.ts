import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { InstanceInstallLogWriter } from './log-store'

it('amortizes trimming while preserving order and recent lines', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-install-log-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const writer = new InstanceInstallLogWriter(dir, 'test')
  writer.clear()
  const read = t.mock.method(fs, 'readFileSync')
  const write = t.mock.method(fs, 'writeFileSync')
  for (let i = 0; i < 600; i++) writer.appendLine(`line-${i}`)
  assert.equal(read.mock.callCount(), 1)
  // appendFileSync 内部也调用 writeFileSync；只统计覆盖写入。
  assert.equal(write.mock.calls.filter(call => call.arguments[2] === 'utf8').length, 1)
  const content = writer.readContent()
  assert.equal(content.trim().split('\n').length, 350)
  assert.ok(content.indexOf('line-250') < content.indexOf('line-599'))
  assert.ok(content.includes('line-599'))
})
