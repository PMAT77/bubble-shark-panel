import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, it } from 'node:test'
import { ContentTransaction, recoverContentTransaction } from './content-transaction'

const roots: string[] = []
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-content-tx-'))
  roots.push(root)
  const source = path.join(root, 'source')
  const live = path.join(root, 'mods', '123')
  fs.mkdirSync(source)
  fs.mkdirSync(live, { recursive: true })
  fs.writeFileSync(path.join(source, 'content'), 'new')
  fs.writeFileSync(path.join(live, 'content'), 'old')
  return { root, source, live }
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

it('restores every directory and protected configuration after partial replacement fails', async () => {
  const { root, source, live } = fixture()
  const second = path.join(root, 'mods', '456')
  const config = path.join(root, 'config.lua')
  fs.writeFileSync(config, 'old config')
  const transaction = new ContentTransaction(root, { mods: ['old'] })
  await transaction.prepareDirectory(source, live)
  await transaction.prepareDirectory(source, second)
  const rename = fs.renameSync
  fs.renameSync = ((from, to) => {
    if (String(to) === second) throw new Error('injected rename failure')
    return rename(from, to)
  }) as typeof fs.renameSync
  try { assert.throws(() => transaction.apply(), /injected/) }
  finally { fs.renameSync = rename }
  let restored: unknown
  transaction.rollback(snapshot => restored = snapshot)
  assert.deepEqual(restored, { mods: ['old'] })
  assert.equal(fs.readFileSync(path.join(live, 'content'), 'utf8'), 'old')
  assert.equal(fs.existsSync(second), false)
  assert.equal(fs.readFileSync(config, 'utf8'), 'old config')
})

it('recovers applied files, configuration and database snapshot after restart; recovery is idempotent', async () => {
  const { root, source, live } = fixture()
  const config = path.join(root, 'config.lua')
  fs.writeFileSync(config, 'old config')
  const transaction = new ContentTransaction(root, { port: 10999 })
  await transaction.prepareDirectory(source, live)
  transaction.apply()
  transaction.protect(config)
  fs.writeFileSync(config, 'new config')
  let restored: unknown
  assert.equal(recoverContentTransaction(root, snapshot => restored = snapshot), true)
  assert.deepEqual(restored, { port: 10999 })
  assert.equal(fs.readFileSync(path.join(live, 'content'), 'utf8'), 'old')
  assert.equal(fs.readFileSync(config, 'utf8'), 'old config')
  assert.equal(recoverContentTransaction(root, () => assert.fail()), false)
})

it('retains committed content even if the journal needs cleanup after restart', async () => {
  const { root, source, live } = fixture()
  const transaction = new ContentTransaction(root, null)
  await transaction.prepareDirectory(source, live)
  transaction.apply()
  const rm = fs.rmSync
  fs.rmSync = ((file, options) => {
    if (String(file) === transaction.root) throw new Error('injected cleanup failure')
    return rm(file, options)
  }) as typeof fs.rmSync
  try { transaction.commit() } finally { fs.rmSync = rm }
  recoverContentTransaction(root, () => assert.fail('committed DB must not be rolled back'))
  assert.equal(fs.readFileSync(path.join(live, 'content'), 'utf8'), 'new')
})
