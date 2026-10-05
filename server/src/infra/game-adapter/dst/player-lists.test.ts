import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import {
  buildPlayerList,
  normalizeKuId,
  normalizePlayerEntries,
  parsePlayerList,
  PLAYER_LIST_MAX_ENTRIES,
  readPlayerList,
  resolvePlayerListPath,
  savePlayerList,
  validatePlayerListEntries,
} from './player-lists'

const tempRoots: string[] = []

function createTempClusterRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-player-lists-'))
  tempRoots.push(root)
  return root
}

after(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('player-lists', () => {
  it('accepts KU ids and rejects other tokens', () => {
    assert.equal(normalizeKuId('KU_abc123'), 'KU_abc123')
    assert.equal(normalizeKuId('  KU_abc123  '), 'KU_abc123')
    assert.equal(normalizeKuId('KU_abc123 备注文字'), 'KU_abc123')
    // 实测真实 userid 含 `-`（KU_3rpxG-xy）：字符集漏掉它，这个账号就加不进任何名单
    assert.equal(normalizeKuId('KU_3rpxG-xy'), 'KU_3rpxG-xy')
    assert.equal(normalizeKuId('ku_lowercase'), null)
    assert.equal(normalizeKuId('steamid64'), null)
    assert.equal(normalizeKuId(''), null)
  })

  it('parses a list file, skipping blanks and comments and deduplicating by case', () => {
    const content = [
      '\uFEFF# 由面板写入',
      '',
      'KU_aaa111',
      'KU_bbb222  这行后面有备注',
      'KU_AAA111',
      '; 分号也是注释',
      'not-a-ku-id',
      '   ',
    ].join('\n')

    const parsed = parsePlayerList(content)
    assert.deepEqual(parsed.entries, [{ kuId: 'KU_aaa111' }, { kuId: 'KU_bbb222' }])
    assert.equal(parsed.warnings.length, 1)
    assert.match(parsed.warnings[0]!, /第 7 行/)
  })

  it('serializes only KU ids, one per line, and drops invalid entries', () => {
    const content = buildPlayerList([
      { kuId: 'KU_aaa111' },
      { kuId: 'bad-id' },
      { kuId: 'KU_AAA111' },
      { kuId: 'KU_ccc333' },
    ])
    assert.equal(content, 'KU_aaa111\nKU_ccc333\n')
    assert.equal(buildPlayerList([]), '')
    assert.deepEqual(normalizePlayerEntries([{ kuId: ' KU_aaa111 ' }]), [{ kuId: 'KU_aaa111' }])
  })

  it('reports invalid entries and the entry count limit', () => {
    assert.deepEqual(validatePlayerListEntries([{ kuId: 'KU_ok123' }]), [])
    assert.match(validatePlayerListEntries([{ kuId: 'nope' }])[0]!, /玩家 ID 无效/)

    const overflow = Array.from({ length: PLAYER_LIST_MAX_ENTRIES + 1 }, (_, index) => ({
      kuId: `KU_overflow${index}`,
    }))
    assert.match(validatePlayerListEntries(overflow)[0]!, /不能超过/)
  })

  it('treats a missing list file as an empty list', () => {
    const clusterRoot = createTempClusterRoot()
    const result = readPlayerList(clusterRoot, 'admin')
    assert.deepEqual(result, { entries: [], fileExists: false, warnings: [] })
    assert.equal(
      resolvePlayerListPath(clusterRoot, 'admin'),
      path.join(clusterRoot, 'adminlist.txt'),
    )
  })

  it('round-trips a saved list and backs up the previous file', () => {
    const clusterRoot = createTempClusterRoot()
    const saved = savePlayerList(clusterRoot, 'whitelist', [
      { kuId: 'KU_first01' },
      { kuId: 'KU_second02' },
    ])
    assert.deepEqual(saved, [{ kuId: 'KU_first01' }, { kuId: 'KU_second02' }])

    const filePath = resolvePlayerListPath(clusterRoot, 'whitelist')
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'KU_first01\nKU_second02\n')

    const reread = readPlayerList(clusterRoot, 'whitelist')
    assert.equal(reread.fileExists, true)
    assert.deepEqual(reread.entries, saved)
    assert.deepEqual(reread.warnings, [])

    savePlayerList(clusterRoot, 'whitelist', [{ kuId: 'KU_third03' }])
    const backups = fs.readdirSync(clusterRoot).filter(name => name.startsWith('whitelist.txt.bak.'))
    assert.equal(backups.length, 1)
    assert.equal(readPlayerList(clusterRoot, 'whitelist').entries.length, 1)
  })

  it('refuses to write an invalid list', () => {
    const clusterRoot = createTempClusterRoot()
    assert.throws(() => savePlayerList(clusterRoot, 'block', [{ kuId: 'not-a-ku-id' }]), /玩家 ID 无效/)
    assert.equal(fs.existsSync(resolvePlayerListPath(clusterRoot, 'block')), false)
  })
})
