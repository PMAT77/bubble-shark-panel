import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { appendPluginAudit, readPluginAudit } from './audit-store'

it('counts once, prunes at threshold and recounts recreated audit files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-audit-count-'))
  const previous = process.env.BSP_PLUGIN_AUDIT_ROOT
  process.env.BSP_PLUGIN_AUDIT_ROOT = dir
  t.after(() => {
    if (previous === undefined) delete process.env.BSP_PLUGIN_AUDIT_ROOT
    else process.env.BSP_PLUGIN_AUDIT_ROOT = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const file = path.join(dir, 'test.ndjson')
  const read = t.mock.method(fs, 'readFileSync')
  const append = () => appendPluginAudit({ pluginId: 'test', capability: 'test', action: 'test', outcome: 'ok', durationMs: 0 })
  for (let i = 0; i < 5001; i++) append()
  assert.equal(read.mock.callCount(), 1)
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2501)
  fs.unlinkSync(file)
  append()
  assert.equal(readPluginAudit({ pluginId: 'test' }).length, 1)
  const content = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, content.repeat(5000))
  append()
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2501)
})
