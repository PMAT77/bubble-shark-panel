import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, it } from 'node:test'
import { gzipSync } from 'node:zlib'
import { Readable } from 'node:stream'
import tar from 'tar-stream'
import { strToU8, zipSync } from 'fflate'
import { extractArchive } from './archive'
import { extractZipArchive } from './zip-extract'
import { receiveUploadToTempFile } from './upload'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-archive-security-'))
let seq = 0
after(() => fs.rmSync(root, { recursive: true, force: true }))
async function makeTar(entries: Array<{ name: string, type?: 'file' | 'directory' | 'symlink' | 'link' | 'fifo', text?: string }>) {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const collect = (async () => { for await (const chunk of pack) chunks.push(chunk as Buffer) })()
  for (const entry of entries) {
    const data = entry.type && entry.type !== 'file' ? undefined : Buffer.from(entry.text ?? 'data')
    pack.entry({ name: entry.name, type: entry.type ?? 'file', linkname: 'outside', size: data?.length ?? 0 }, data)
  }
  pack.finalize()
  await collect
  const archive = path.join(root, `tar-${seq++}.tar.gz`)
  fs.writeFileSync(archive, gzipSync(Buffer.concat(chunks)))
  return archive
}

it('tar rejects links/special types, duplicate paths and file-directory collisions before writing', async () => {
  for (const entries of [
    [{ name: 'safe' }, { name: 'escape', type: 'symlink' as const }],
    [{ name: 'escape', type: 'link' as const }],
    [{ name: 'escape', type: 'fifo' as const }],
    [{ name: 'a' }, { name: 'a' }],
    [{ name: 'a' }, { name: 'a/child' }],
    [{ name: 'a/child' }, { name: 'a' }],
    [{ name: '.', type: 'directory' as const }, { name: './', type: 'directory' as const }],
  ]) {
    const archive = await makeTar(entries)
    const extract = path.join(root, `extract-${seq++}`)
    await assert.rejects(extractArchive(archive, extract))
    assert.equal(fs.existsSync(extract), false)
  }
})
it('tar counts its root directory toward the entry limit', async () => {
  const archive = await makeTar([{ name: '.', type: 'directory' }, { name: 'file' }])
  await assert.rejects(extractArchive(archive, path.join(root, `extract-${seq++}`), { maxEntries: 1, maxTotalUncompressedBytes: 1024 }), /条目数/)
})
it('tar rejects host-independent absolute/drive/backslash/traversal paths and deep directories', async () => {
  for (const name of ['../escape', '/escape', 'C:/escape', 'a\\escape', `${'a/'.repeat(32)}file`]) {
    const archive = await makeTar([{ name }])
    await assert.rejects(extractArchive(archive, path.join(root, `extract-${seq++}`)))
  }
})
it('ZIP verifies CRC and rejects Unix symlink attributes', async () => {
  const original = Buffer.from(zipSync({ 'modinfo.lua': strToU8('name="CRC"') }, { level: 0 }))
  const central = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  const corrupt = Buffer.from(original)
  corrupt.writeUInt32LE((corrupt.readUInt32LE(central + 16) ^ 1) >>> 0, central + 16)
  const link = Buffer.from(original)
  link.writeUInt32LE(0xa000 * 65536, central + 38)
  for (const [data, pattern] of [[corrupt, /校验/], [link, /链接|特殊/]] as const) {
    const file = path.join(root, `zip-${seq++}.zip`)
    fs.writeFileSync(file, data)
    await assert.rejects(extractZipArchive(file, path.join(root, `extract-${seq++}`)), pattern)
    fs.unlinkSync(file)
    assert.equal(fs.existsSync(file), false, '损坏 ZIP 拒绝后应已关闭归档文件')
  }
})
it('interrupted upload closes its stream and removes the temporary record', async () => {
  const uploads = path.join(root, 'uploads')
  let sent = false
  const input = new Readable({ read() { if (!sent) { sent = true; this.push(Buffer.alloc(1024)); queueMicrotask(() => this.destroy(new Error('upload interrupted'))) } } })
  const result = await receiveUploadToTempFile(input, 1024 ** 2, uploads)
  assert.equal(result.ok, false)
  assert.equal(input.destroyed, true)
  assert.deepEqual(fs.readdirSync(uploads), [])
})
