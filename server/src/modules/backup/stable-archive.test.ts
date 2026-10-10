import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { archiveStableWorldSave } from './backup-service'
import { resolveShardSaveDir } from '../../infra/game-adapter/dst/shard-layout'
it('归档时自动保存改变源文件则丢弃并重试，连续变化不报告成功', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-stable-archive-'))
  try {
    const save = resolveShardSaveDir(dir, 'master')
    fs.mkdirSync(save, { recursive: true })
    const source = path.join(save, 'shardindex'); fs.writeFileSync(source, 'before')
    const target = path.join(dir, 'archive.tar.gz')
    let calls = 0
    await archiveStableWorldSave(path.join(dir, 'klei-storage'), target, undefined, async () => {
      fs.writeFileSync(target, 'archive'); calls += 1
      if (calls === 1) fs.writeFileSync(source, 'changed during first archive')
    })
    assert.equal(calls, 2)
    assert.ok(fs.existsSync(target))
    calls = 0
    await assert.rejects(archiveStableWorldSave(path.join(dir, 'klei-storage'), target, undefined, async () => {
      fs.writeFileSync(target, 'incomplete'); fs.writeFileSync(source, 'x'.repeat(++calls + 50))
    }), /两次尝试/)
    assert.equal(calls, 2)
    assert.equal(fs.existsSync(target), false)
  }
  finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
