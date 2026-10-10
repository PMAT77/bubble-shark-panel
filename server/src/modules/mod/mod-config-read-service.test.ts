import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { resolveClusterPaths } from '../../infra/game-adapter/dst/cluster-service'
import { readModConfig } from './mod-config-read-service'

it('returns read status while preserving stored configuration priority and imported values', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-config-read-'))
  try {
    const { clusterRoot } = resolveClusterPaths(dir)
    fs.mkdirSync(path.join(clusterRoot, 'Master'), { recursive: true })
    fs.writeFileSync(path.join(clusterRoot, 'Master/modoverrides.lua'), 'return {["workshop-123"]={configuration_options={flag=true, text="001"}}}')
    const stored = await readModConfig('instance', dir, '123', '{"flag":false,"hidden":"true"}')
    assert.deepEqual(stored.options, { flag: false, hidden: 'true' })
    assert.equal(stored.definitionStatus, 'missing_file')
    assert.deepEqual(stored.definitions, [])
    const imported = await readModConfig('instance', dir, '123', null)
    assert.deepEqual(imported.options, { flag: true, text: '001' })
    assert.doesNotMatch(imported.definitionMessage ?? '', /bsp-config-read-/)
  }
  finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
