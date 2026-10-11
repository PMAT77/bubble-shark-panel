import assert from 'node:assert/strict'
import { test } from 'node:test'
import { refreshWorldPorts, savedWorldDraft, worldDraftChanged, type WorldDraft } from './worldDraft'

function draft(): WorldDraft {
  return {
    form: { serverPort: 10999, steamAuthPort: 8766, steamMasterPort: 12346, worldgenPreset: 'SURVIVAL_TOGETHER' },
    rules: { day: 'default' }, worldgen: { world_size: 'default' }, seed: '123',
  }
}

test('保存地上只更新地上基线，洞穴草稿仍需保存', () => {
  const baseline = { master: draft(), caves: draft() }
  const current = { master: draft(), caves: draft() }
  current.master.form.serverPort = 12000
  current.caves.rules.day = 'longday'
  baseline.master = savedWorldDraft(current.master, baseline.master, false)
  assert.equal(worldDraftChanged(current.master, baseline.master), false)
  assert.equal(worldDraftChanged(current.caves, baseline.caves), true)
  assert.equal(baseline.caves.rules.day, 'default')
})

test('已生成世界的新种子仍触发离页保护，但不激活普通保存', () => {
  const baseline = draft()
  const current = draft()
  current.seed = ''
  assert.equal(worldDraftChanged(current, baseline, true), true)
  assert.equal(worldDraftChanged(current, baseline, true, true), false)
  current.form.serverPort = 12000
  const saved = savedWorldDraft(current, baseline, true)
  assert.equal(saved.seed, '123')
  assert.equal(worldDraftChanged(current, saved, true, true), false)
  assert.equal(worldDraftChanged(current, saved, true), true)
})

test('未生成世界的种子和生成设置随普通配置保存', () => {
  const baseline = draft()
  const current = draft()
  current.seed = '456'
  current.worldgen.world_size = 'huge'
  assert.equal(worldDraftChanged(current, baseline, false, true), true)
  const saved = savedWorldDraft(current, baseline, false)
  assert.equal(worldDraftChanged(current, saved), false)
})

test('保存基线独立于后续编辑', () => {
  const current = draft()
  const baseline = savedWorldDraft(current, draft(), false)
  current.rules.day = 'longday'
  current.form.serverPort = 12000
  current.worldgen.world_size = 'huge'
  assert.equal(baseline.rules.day, 'default')
  assert.equal(baseline.form.serverPort, 10999)
  assert.equal(baseline.worldgen.world_size, 'default')
  assert.equal(worldDraftChanged(current, baseline), true)
})

test('加载前不报未保存，放弃后与加载基线一致', () => {
  assert.equal(worldDraftChanged(draft(), undefined), false)
  assert.equal(worldDraftChanged(draft(), draft()), false)
})

test('重启自动避让端口后同步未修改字段，保留另一世界的端口草稿', () => {
  const current = draft()
  const baseline = draft()
  current.form.serverPort = 13000
  refreshWorldPorts(current.form, baseline.form, { serverPort: 12000, steamAuthPort: 9766, steamMasterPort: null })
  assert.equal(current.form.serverPort, 13000)
  assert.equal(baseline.form.serverPort, 12000)
  assert.equal(current.form.steamAuthPort, 9766)
  assert.equal(baseline.form.steamAuthPort, 9766)
  assert.equal(current.form.steamMasterPort, 12346)
  assert.equal(worldDraftChanged(current, baseline), true)
})
