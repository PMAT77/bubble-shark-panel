import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import { gzipSync } from 'node:zlib'
import { DEFAULT_TAR_EXTRACT_LIMITS, createDirectoryArchive, extractArchive, getDirectorySizeBytes, replaceDirectory } from './archive'

let workDir: string

/** 手工构造 tar.gz：需要精确控制条目名（如路径逃逸样本），系统 tar 不便生成 */
function buildTarGz(entries: Array<{ name: string; content: string }>): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const content = Buffer.from(entry.content, 'utf8')
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'utf8')
    header.write('0000000\0', 108, 8, 'utf8')
    header.write('0000000\0', 116, 8, 'utf8')
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
    header.write('00000000000\0', 136, 12, 'utf8')
    header.write('        ', 148, 8, 'utf8')
    header.write('0', 156, 1, 'utf8')
    header.write('ustar\0', 257, 6, 'utf8')
    header.write('00', 263, 2, 'utf8')
    let sum = 0
    for (const byte of header) {
      sum += byte
    }
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
    blocks.push(header)
    const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512)
    content.copy(padded)
    blocks.push(padded)
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function writeTree(root: string) {
  const saveDir = path.join(root, 'DoNotStarveTogether', 'Cluster_1', 'Master', 'save')
  fs.mkdirSync(saveDir, { recursive: true })
  fs.writeFileSync(path.join(saveDir, 'world.txt'), '世界存档内容-1')
  fs.writeFileSync(path.join(root, 'cluster.ini'), '[gameplay]\nmax_players = 16\n')
  fs.writeFileSync(path.join(root, 'cluster_token.txt'), 'pds-g^n^token')
}

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-archive-test-'))
})

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('backup archive infra', () => {
  it('archives a directory and restores identical content after source changes', async () => {
    const source = path.join(workDir, 'src-tree')
    writeTree(source)
    const archivePath = path.join(workDir, 'test-backup.tar.gz')

    await createDirectoryArchive(source, archivePath)
    assert.ok(fs.existsSync(archivePath))
    assert.ok(fs.statSync(archivePath).size > 0)

    // 源目录发生变化（模拟存档推进）
    fs.writeFileSync(path.join(source, 'DoNotStarveTogether', 'Cluster_1', 'Master', 'save', 'world.txt'), '世界存档内容-2')
    fs.mkdirSync(path.join(source, 'DoNotStarveTogether', 'Cluster_1', 'Caves', 'save'), { recursive: true })
    fs.writeFileSync(path.join(source, 'DoNotStarveTogether', 'Cluster_1', 'Caves', 'save', 'caves.txt'), '洞穴')

    const restoreDir = path.join(workDir, 'restore-target')
    await extractArchive(archivePath, restoreDir)

    const restoredWorld = path.join(restoreDir, path.basename(source), 'DoNotStarveTogether', 'Cluster_1', 'Master', 'save', 'world.txt')
    assert.equal(fs.readFileSync(restoredWorld, 'utf8'), '世界存档内容-1')
    assert.ok(!fs.existsSync(path.join(restoreDir, path.basename(source), 'DoNotStarveTogether', 'Cluster_1', 'Caves')))
  })

  it('rejects archiving a missing source directory', async () => {
    await assert.rejects(
      () => createDirectoryArchive(path.join(workDir, 'not-exists'), path.join(workDir, 'nope.tar.gz')),
      /待备份目录不存在/,
    )
  })

  it('replaces a directory atomically and cleans up the displaced one', () => {
    const live = path.join(workDir, 'live-dir')
    const prepared = path.join(workDir, 'prepared-dir')
    fs.mkdirSync(live, { recursive: true })
    fs.writeFileSync(path.join(live, 'old.txt'), 'old')
    fs.mkdirSync(prepared, { recursive: true })
    fs.writeFileSync(path.join(prepared, 'new.txt'), 'new')

    replaceDirectory(live, prepared)

    assert.ok(fs.existsSync(path.join(live, 'new.txt')))
    assert.ok(!fs.existsSync(path.join(live, 'old.txt')))
    const displaced = fs.readdirSync(workDir).filter(name => name.startsWith('.replaced-'))
    assert.equal(displaced.length, 0)
  })

  it('rolls back the live directory when the prepared directory is missing', () => {
    const live = path.join(workDir, 'live-dir-2')
    fs.mkdirSync(live, { recursive: true })
    fs.writeFileSync(path.join(live, 'keep.txt'), 'keep')

    assert.throws(
      () => replaceDirectory(live, path.join(workDir, `missing-${randomUUID()}`)),
    )
    assert.ok(fs.existsSync(path.join(live, 'keep.txt')))
  })


  // 回归：tar.gz 分支曾经完全绕过解压上限，认证用户上传高压缩比包即可写满宿主机磁盘
  it('rejects a tar.gz whose entry count exceeds the limit', async () => {
    const archivePath = path.join(workDir, 'many-entries.tar.gz')
    fs.writeFileSync(archivePath, buildTarGz([
      { name: 'a.txt', content: 'a' },
      { name: 'b.txt', content: 'b' },
      { name: 'c.txt', content: 'c' },
    ]))

    await assert.rejects(
      () => extractArchive(archivePath, path.join(workDir, 'entries-target'), { maxEntries: 2, maxTotalUncompressedBytes: 1024 * 1024 }),
      /条目数超过上限/,
    )
  })

  it('rejects a tar.gz that expands beyond the size limit without writing anything', async () => {
    const archivePath = path.join(workDir, 'oversized.tar.gz')
    fs.writeFileSync(archivePath, buildTarGz([{ name: 'big.txt', content: 'x'.repeat(8192) }]))
    const target = path.join(workDir, 'oversized-target')

    await assert.rejects(
      () => extractArchive(archivePath, target, { maxEntries: 100, maxTotalUncompressedBytes: 1024 }),
      /解压后总大小超过上限/,
    )
    // 大小校验在落盘之前完成，目标目录不应被创建
    assert.equal(fs.existsSync(target), false)
  })

  it('rejects a tar.gz containing a path escape entry', async () => {
    const archivePath = path.join(workDir, 'escape.tar.gz')
    fs.writeFileSync(archivePath, buildTarGz([{ name: '../escaped.txt', content: 'boom' }]))

    await assert.rejects(
      () => extractArchive(archivePath, path.join(workDir, 'escape-target'), DEFAULT_TAR_EXTRACT_LIMITS),
      /非法路径条目/,
    )
  })

  it('computes directory size in bytes', () => {
    const dir = path.join(workDir, 'size-dir')
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a'.repeat(1024))
    fs.writeFileSync(path.join(dir, 'nested', 'b.txt'), 'b'.repeat(2048))
    const size = getDirectorySizeBytes(dir)
    assert.equal(size, 1024 + 2048)
  })
})
