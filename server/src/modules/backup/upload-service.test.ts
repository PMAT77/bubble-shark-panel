import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { after, before, describe, it } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { createDirectoryArchive } from '../../infra/backup/archive'
import { probeSaveImportSource, validateSourceTargetDisjoint } from './import-service'
import {
  cleanStaleSaveImportUploads,
  createUploadDirectory,
  detectArchiveFormat,
  receiveUploadToTempFile,
  resolveUploadDirectory,
  resolveUploadExtractRoot,
  unpackSaveImportArchive,
  validateUploadClusterPath,
} from './upload-service'

let workDir: string

/** 构造一份集群存档文件树（zipSync 嵌套对象 → 目录条目） */
function buildClusterFiles(clusterName: string): Record<string, Uint8Array> {
  return {
    'cluster.ini': strToU8([
      '[GAMEPLAY]',
      'game_mode = survival',
      '',
      '[NETWORK]',
      'cluster_name = ' + clusterName,
      '',
      '[SHARD]',
      'shard_enabled = true',
      '',
    ].join('\n')),
    'Master/server.ini': strToU8('[SHARD]\nis_master = true\n\n[NETWORK]\nserver_port = 27015\n'),
    'Master/save/session/s1/world.txt': strToU8('world'),
    'Caves/server.ini': strToU8('[SHARD]\nis_master = false\n\n[NETWORK]\nserver_port = 27016\n'),
  }
}

function writeZipFile(zip: Uint8Array, name: string): string {
  const zipPath = path.join(workDir, name)
  fs.writeFileSync(zipPath, Buffer.from(zip))
  return zipPath
}

/** 完整走一遍：创建上传目录 → 落盘压缩包 → 解压 */
async function unpackAndProbe(zipPath: string): Promise<{ uploadId: string, extractDir: string, format: string }> {
  const { uploadId, uploadDir } = createUploadDirectory()
  fs.writeFileSync(path.join(uploadDir, 'upload.bin'), fs.readFileSync(zipPath))
  const extractDir = path.join(uploadDir, 'extract')
  const format = await unpackSaveImportArchive(zipPath, extractDir)
  return { uploadId, extractDir, format }
}

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-save-import-test-'))
  process.env.BSP_SAVE_IMPORT_ROOT = path.join(workDir, 'uploads')
})

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 1 })
})

describe('save import upload-service', () => {
  it('detects archive format by magic bytes', async () => {
    const zipPath = writeZipFile(zipSync({ 'a.txt': strToU8('x') }), 'fmt.zip')
    assert.equal(detectArchiveFormat(zipPath), 'zip')
    const storageRoot = path.join(workDir, 'fmt-src')
    fs.mkdirSync(storageRoot, { recursive: true })
    fs.writeFileSync(path.join(storageRoot, 'f.txt'), 'data')
    const targzPath = path.join(workDir, 'fmt.tar.gz')
    await createDirectoryArchive(storageRoot, targzPath)
    assert.equal(detectArchiveFormat(targzPath), 'targz')
    const plainPath = path.join(workDir, 'plain.txt')
    fs.writeFileSync(plainPath, 'plain text, not an archive')
    assert.equal(detectArchiveFormat(plainPath), null)
  })

  it('unpacks a zip whose root is the cluster directory itself', async () => {
    const zipPath = writeZipFile(zipSync(buildClusterFiles('直传房')), 'direct.zip')
    const { extractDir, format } = await unpackAndProbe(zipPath)
    assert.equal(format, 'zip')
    const probed = probeSaveImportSource(extractDir)
    assert.equal(probed.ok, true)
    assert.equal(probed.result?.candidates.length, 1)
    assert.equal(probed.result?.candidates[0]?.clusterName, '直传房')
    assert.equal(probed.result?.candidates[0]?.shards.includes('caves'), true)
  })

  it('unpacks a zip wrapping Cluster_1 at one level', async () => {
    const zipPath = writeZipFile(zipSync({ Cluster_1: buildClusterFiles('包装房') }), 'wrapped.zip')
    const { extractDir } = await unpackAndProbe(zipPath)
    const probed = probeSaveImportSource(extractDir)
    assert.equal(probed.ok, true)
    assert.equal(probed.result?.candidates[0]?.dirName, 'Cluster_1')
    assert.equal(probed.result?.candidates[0]?.clusterName, '包装房')
    assert.equal(probed.result?.candidates[0]?.worldGenerated, true)
  })

  it('unpacks a zip in official DoNotStarveTogether/Cluster_2 layout', async () => {
    const zipPath = writeZipFile(zipSync({ DoNotStarveTogether: { Cluster_2: buildClusterFiles('官方布局') } }), 'official.zip')
    const { extractDir } = await unpackAndProbe(zipPath)
    const probed = probeSaveImportSource(extractDir)
    assert.equal(probed.ok, true)
    assert.equal(probed.result?.candidates[0]?.dirName, 'Cluster_2')
  })

  it('unpacks a panel backup tar.gz (klei-storage layout) and finds the cluster', async () => {
    const storageRoot = path.join(workDir, 'klei-storage')
    const clusterDir = path.join(storageRoot, 'DoNotStarveTogether', 'Cluster_3')
    fs.mkdirSync(path.join(clusterDir, 'Master', 'save'), { recursive: true })
    fs.writeFileSync(path.join(clusterDir, 'cluster.ini'), '[NETWORK]\ncluster_name = 备份房\n')
    fs.writeFileSync(path.join(clusterDir, 'Master', 'save', 'world.txt'), 'x')
    const targzPath = path.join(workDir, 'backup.tar.gz')
    await createDirectoryArchive(storageRoot, targzPath)
    const { extractDir, format } = await unpackAndProbe(targzPath)
    assert.equal(format, 'targz')
    const probed = probeSaveImportSource(extractDir)
    assert.equal(probed.ok, true)
    assert.equal(probed.result?.candidates[0]?.dirName, 'Cluster_3')
    assert.equal(probed.result?.candidates[0]?.clusterName, '备份房')
  })

  it('rejects zip-slip entries and writes nothing outside the extract root', async () => {
    const evilPath = writeZipFile(zipSync({ '../evil.txt': strToU8('bad') }), 'evil.zip')
    const { uploadDir, extractDir } = await (async () => {
      const created = createUploadDirectory()
      return { uploadDir: created.uploadDir, extractDir: path.join(created.uploadDir, 'extract') }
    })()
    await assert.rejects(
      () => unpackSaveImportArchive(evilPath, extractDir),
      /invalid relative|非法路径/,
    )
    assert.equal(fs.existsSync(path.join(uploadDir, 'evil.txt')), false)
    assert.equal(fs.existsSync(path.join(workDir, 'evil.txt')), false)
  })

  it('rejects a zip whose decompressed size exceeds the limit', async () => {
    const bigPath = writeZipFile(zipSync({ 'zeros.bin': new Uint8Array(2 * 1024 * 1024) }), 'big.zip')
    const extractDir = path.join(createUploadDirectory().uploadDir, 'extract')
    await assert.rejects(
      () => unpackSaveImportArchive(bigPath, extractDir, { maxEntries: 1000, maxTotalUncompressedBytes: 1024 * 1024 }),
      /超过上限/,
    )
  })

  it('validates upload cluster path against the upload extract root', () => {
    assert.equal(validateUploadClusterPath('not-a-uuid', path.join(workDir, 'x')).ok, false)
    const { uploadId } = createUploadDirectory()
    assert.equal(validateUploadClusterPath(uploadId, path.join(workDir, 'outside')).ok, false)
    const clusterDir = path.join(resolveUploadExtractRoot(uploadId), 'Cluster_1')
    fs.mkdirSync(clusterDir, { recursive: true })
    assert.equal(validateUploadClusterPath(uploadId, clusterDir).ok, false)
    fs.writeFileSync(path.join(clusterDir, 'cluster.ini'), '[GAMEPLAY]\n')
    const validated = validateUploadClusterPath(uploadId, clusterDir)
    assert.equal(validated.ok, true)
  })

  it('receives upload stream to temp file and enforces the size cap', async () => {
    const okResult = await receiveUploadToTempFile(Readable.from([Buffer.from('hello'), Buffer.from(' world')]), 1024)
    assert.equal(okResult.ok, true)
    assert.equal(okResult.bytes, 11)
    assert.ok(okResult.filePath && fs.existsSync(okResult.filePath))
    const overResult = await receiveUploadToTempFile(Readable.from([Buffer.alloc(100), Buffer.alloc(100)]), 150)
    assert.equal(overResult.ok, false)
    assert.equal(overResult.tooLarge, true)
    assert.match(overResult.error ?? '', /超过大小上限/)
    if (overResult.uploadId) {
      assert.equal(fs.existsSync(resolveUploadDirectory(overResult.uploadId)), false)
    }
  })

  it('allows an uploaded source on a different root from the install path', () => {
    // Windows 跨盘符场景：上传源在 C: 临时目录、实例在 D:；不同根时不得误判为互相包含
    const installPath = path.join(workDir, 'instances', 'cross-root')
    const clusterRoot = path.join(installPath, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1')
    const source = path.join(path.parse(workDir).root === 'C:\\' ? 'D:' + path.sep : path.dirname(workDir), 'elsewhere', 'Cluster_1')
    assert.equal(validateSourceTargetDisjoint(source, installPath, clusterRoot), undefined)
    // 源位于实例存档内部仍被拒
    const inside = path.join(clusterRoot, 'Cluster_9')
    assert.match(validateSourceTargetDisjoint(inside, installPath, clusterRoot) ?? '', /实例存档目录内部/)
    // 源包含实例安装目录仍被拒
    assert.match(validateSourceTargetDisjoint(workDir, installPath, clusterRoot) ?? '', /包含实例安装目录/)
  })

  it('cleans stale upload directories and keeps fresh ones', () => {
    const stale = createUploadDirectory()
    const fresh = createUploadDirectory()
    fs.writeFileSync(path.join(stale.uploadDir, 'upload.bin'), 'x')
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    fs.utimesSync(stale.uploadDir, old, old)
    cleanStaleSaveImportUploads()
    assert.equal(fs.existsSync(stale.uploadDir), false)
    assert.equal(fs.existsSync(fresh.uploadDir), true)
  })
})