import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import {
  backupExistingInstanceFile,
  deleteInstancePath,
  INSTANCE_TEXT_FILE_MAX_BYTES,
  INSTANCE_UPLOAD_DEFAULT_MAX_BYTES,
  isEditableTextPath,
  isProtectedInstanceFile,
  listInstanceDirectory,
  listInstanceKeyFiles,
  readInstanceTextFile,
  renameInstancePath,
  resolveInstanceDownloadPath,
  resolveInstancePath,
  resolveInstanceUploadMaxBytes,
  resolveInstanceUploadTarget,
  writeInstanceTextFile,
  writeInstanceUploadFile,
} from './instance-files'

const tempDirs: string[] = []

function createTempInstanceRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-instance-files-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('instance-files sandbox', () => {
  it('accepts relative paths inside the instance directory', () => {
    const root = createTempInstanceRoot()
    const resolved = resolveInstancePath(root, 'klei-storage/DoNotStarveTogether/Cluster_1/cluster.ini')
    assert.equal(resolved.ok, true)
    assert.equal(
      resolved.ok && resolved.relativePath,
      'klei-storage/DoNotStarveTogether/Cluster_1/cluster.ini',
    )
  })

  it('rejects absolute paths, parent traversal and escaping paths', () => {
    const root = createTempInstanceRoot()
    assert.equal(resolveInstancePath(root, '/etc/passwd').ok, false)
    assert.equal(resolveInstancePath(root, 'C:/Windows/system32').ok, false)
    assert.equal(resolveInstancePath(root, '../outside.txt').ok, false)
    assert.equal(resolveInstancePath(root, 'a/../../outside.txt').ok, false)
    // 空路径只在允许根目录时通过（列目录），读写时要报错
    assert.equal(resolveInstancePath(root, '').ok, false)
    assert.equal(resolveInstancePath(root, '', { allowRoot: true }).ok, true)
  })

  it('rejects a symlink that points outside the instance directory', () => {
    const root = createTempInstanceRoot()
    const outsideDir = createTempInstanceRoot()
    fs.writeFileSync(path.join(outsideDir, 'secret.ini'), 'x', 'utf8')
    // junction 在 Windows 上无需管理员权限，在 Linux 上按普通目录符号链接创建
    fs.symlinkSync(outsideDir, path.join(root, 'escape'), 'junction')

    const resolved = resolveInstancePath(root, 'escape/secret.ini')
    assert.equal(resolved.ok, false)
    assert.match(resolved.ok ? '' : resolved.message, /超出实例目录范围/)
  })

  it('hides symlinked entries from directory listings', () => {
    const root = createTempInstanceRoot()
    const outsideDir = createTempInstanceRoot()
    fs.symlinkSync(outsideDir, path.join(root, 'escape'), 'junction')
    fs.mkdirSync(path.join(root, 'instances'))
    fs.writeFileSync(path.join(root, 'cluster.ini'), '[NETWORK]', 'utf8')

    const entries = listInstanceDirectory(root, '')
    assert.deepEqual(entries.map(item => item.name), ['instances', 'cluster.ini'])
    assert.equal(entries[0]!.type, 'directory')
    assert.equal(entries[1]!.type, 'file')
    assert.equal(entries[1]!.sizeBytes, 9)
    assert.ok(entries[1]!.modifiedAt.length > 0)
  })

  it('marks the cluster token as protected but still lists it', () => {
    const root = createTempInstanceRoot()
    fs.mkdirSync(path.join(root, 'DoNotStarveTogether', 'Cluster_1'), { recursive: true })
    fs.writeFileSync(path.join(root, 'DoNotStarveTogether', 'Cluster_1', 'cluster_token.txt'), 'pds-secret', 'utf8')

    const entries = listInstanceDirectory(root, 'DoNotStarveTogether/Cluster_1')
    const token = entries.find(item => item.name === 'cluster_token.txt')
    assert.ok(token)
    assert.equal(token.protected, true)
    assert.equal(isProtectedInstanceFile('DoNotStarveTogether/Cluster_1/cluster_token.txt'), true)
    assert.equal(isProtectedInstanceFile('Cluster_1/cluster.ini'), false)
  })

  it('reads text files and refuses protected or non-text files', () => {
    const root = createTempInstanceRoot()
    fs.writeFileSync(path.join(root, 'cluster.ini'), '[NETWORK]\ncluster_name = Test\n', 'utf8')
    fs.writeFileSync(path.join(root, 'cluster_token.txt'), 'pds-secret', 'utf8')
    fs.writeFileSync(path.join(root, 'server'), Buffer.from([0x7F, 0x45, 0x4C, 0x46]))

    const file = readInstanceTextFile(root, 'cluster.ini')
    assert.match(file.content, /cluster_name = Test/)
    assert.equal(file.truncated, false)
    assert.equal(file.editable, true)

    assert.throws(() => readInstanceTextFile(root, 'cluster_token.txt'), /敏感信息/)
    assert.throws(() => readInstanceTextFile(root, 'server'), /不支持在面板中编辑/)
  })

  it('flags oversized text files as truncated instead of loading everything', () => {
    const root = createTempInstanceRoot()
    const bigPath = path.join(root, 'chat.log')
    fs.writeFileSync(bigPath, 'a'.repeat(INSTANCE_TEXT_FILE_MAX_BYTES + 16), 'utf8')

    const file = readInstanceTextFile(root, 'chat.log')
    assert.equal(file.truncated, true)
    assert.equal(file.sizeBytes, INSTANCE_TEXT_FILE_MAX_BYTES + 16)
    assert.equal(Buffer.byteLength(file.content, 'utf8'), INSTANCE_TEXT_FILE_MAX_BYTES)
  })

  it('writes text files with a backup of the previous content', () => {
    const root = createTempInstanceRoot()
    fs.writeFileSync(path.join(root, 'cluster.ini'), 'old', 'utf8')

    const result = writeInstanceTextFile(root, 'cluster.ini', 'new content')
    assert.equal(result.sizeBytes, Buffer.byteLength('new content', 'utf8'))
    assert.equal(fs.readFileSync(path.join(root, 'cluster.ini'), 'utf8'), 'new content')
    const backups = fs.readdirSync(root).filter(name => name.startsWith('cluster.ini.bak.'))
    assert.equal(backups.length, 1)

    // 允许新建文本文件（例如缺失的配置文件），但不允许新建二进制类型
    assert.equal(writeInstanceTextFile(root, 'nest/new.ini', '[MISC]').sizeBytes, 6)
    assert.throws(() => writeInstanceTextFile(root, 'binary.bin', 'x'), /不支持在面板中编辑/)
  })

  it('refuses to write protected files or oversized content', () => {
    const root = createTempInstanceRoot()
    fs.writeFileSync(path.join(root, 'cluster_token.txt'), 'pds-secret', 'utf8')
    assert.throws(() => writeInstanceTextFile(root, 'cluster_token.txt', 'hacked'), /敏感信息/)
    assert.throws(
      () => writeInstanceTextFile(root, 'cluster.ini', 'a'.repeat(INSTANCE_TEXT_FILE_MAX_BYTES + 1)),
      /上限/,
    )
    assert.equal(fs.readFileSync(path.join(root, 'cluster_token.txt'), 'utf8'), 'pds-secret')
  })

  it('deletes files and directories but never protected files', () => {
    const root = createTempInstanceRoot()
    fs.mkdirSync(path.join(root, 'logs', 'nested'), { recursive: true })
    fs.writeFileSync(path.join(root, 'logs', 'nested', 'a.txt'), 'x', 'utf8')
    fs.writeFileSync(path.join(root, 'cluster_token.txt'), 'pds-secret', 'utf8')

    assert.equal(deleteInstancePath(root, 'logs').removed, true)
    assert.equal(fs.existsSync(path.join(root, 'logs')), false)
    assert.equal(deleteInstancePath(root, 'missing.txt').removed, false)
    assert.throws(() => deleteInstancePath(root, 'cluster_token.txt'), /敏感信息/)
    assert.throws(() => deleteInstancePath(root, ''), /请指定实例目录内的文件或目录/)
  })

  it('renames inside the same directory and refuses unsafe targets', () => {
    const root = createTempInstanceRoot()
    fs.writeFileSync(path.join(root, 'cluster.ini'), 'x', 'utf8')
    fs.writeFileSync(path.join(root, 'other.ini'), 'y', 'utf8')

    const renamed = renameInstancePath(root, 'cluster.ini', 'cluster.ini.bak')
    assert.equal(renamed.path, 'cluster.ini.bak')
    assert.equal(fs.existsSync(path.join(root, 'cluster.ini.bak')), true)

    assert.throws(() => renameInstancePath(root, 'other.ini', 'sub/other.ini'), /新名称不合法/)
    assert.throws(() => renameInstancePath(root, 'other.ini', 'cluster.ini.bak'), /同名文件已存在/)
    assert.throws(() => renameInstancePath(root, 'other.ini', 'cluster_token.txt'), /敏感文件名/)
  })

  it('only allows known text extensions to be edited', () => {
    assert.equal(isEditableTextPath('cluster.ini'), true)
    assert.equal(isEditableTextPath('worldgenoverride.lua'), true)
    assert.equal(isEditableTextPath('server'), false)
    assert.equal(isEditableTextPath('modinfo.chs'), false)
  })

  it('lists key config files with existence flags', () => {
    const root = createTempInstanceRoot()
    const clusterDir = path.join(root, 'klei-storage', 'DoNotStarveTogether', 'Cluster_1')
    fs.mkdirSync(path.join(clusterDir, 'Master'), { recursive: true })
    fs.writeFileSync(path.join(clusterDir, 'cluster.ini'), '[NETWORK]', 'utf8')
    fs.writeFileSync(path.join(clusterDir, 'Master', 'server.ini'), '[SHARD]', 'utf8')

    const files = listInstanceKeyFiles(root)
    assert.equal(files.length, 7)
    const byLabel = new Map(files.map(item => [item.label, item]))
    assert.equal(byLabel.get('房间配置')?.path, 'klei-storage/DoNotStarveTogether/Cluster_1/cluster.ini')
    assert.equal(byLabel.get('房间配置')?.exists, true)
    assert.equal(byLabel.get('地上世界')?.exists, true)
    assert.equal(byLabel.get('洞穴配置')?.exists, false)
    // 所有条目都必须是可编辑文本类型，否则跳转过去也打不开
    for (const item of files) {
      assert.equal(isEditableTextPath(item.path), true, item.path)
    }
  })
})

describe('instance file upload and download', () => {
  it('resolves upload targets inside the instance directory', () => {
    const root = createTempInstanceRoot()
    const atRoot = resolveInstanceUploadTarget(root, '', 'cluster.ini')
    assert.equal(atRoot.ok, true)
    assert.equal(atRoot.ok && atRoot.relativePath, 'cluster.ini')

    const nested = resolveInstanceUploadTarget(root, 'klei-storage/DoNotStarveTogether/Cluster_1/', 'modoverrides.lua')
    assert.equal(nested.ok, true)
    assert.equal(nested.ok && nested.relativePath, 'klei-storage/DoNotStarveTogether/Cluster_1/modoverrides.lua')
  })

  it('rejects unsafe upload file names and protected targets', () => {
    const root = createTempInstanceRoot()
    for (const name of ['', '   ', '.', '..', 'a/b.ini', 'a\\b.ini']) {
      const result = resolveInstanceUploadTarget(root, '', name)
      assert.equal(result.ok, false, `应拒绝文件名 ${JSON.stringify(name)}`)
    }
    const protectedTarget = resolveInstanceUploadTarget(root, 'DoNotStarveTogether/Cluster_1', 'cluster_token.txt')
    assert.equal(protectedTarget.ok, false)
    assert.match(protectedTarget.ok ? '' : protectedTarget.message, /敏感/)
  })

  it('rejects upload directories that escape the instance directory', () => {
    const root = createTempInstanceRoot()
    const escaped = resolveInstanceUploadTarget(root, '../../etc', 'passwd')
    assert.equal(escaped.ok, false)
    assert.match(escaped.ok ? '' : escaped.message, /超出实例目录范围|上级目录/)
  })

  it('reads the upload size limit from the environment', () => {
    assert.equal(resolveInstanceUploadMaxBytes({}), INSTANCE_UPLOAD_DEFAULT_MAX_BYTES)
    assert.equal(resolveInstanceUploadMaxBytes({ BSP_INSTANCE_UPLOAD_MAX_BYTES: '1024' }), 1024)
    assert.equal(resolveInstanceUploadMaxBytes({ BSP_INSTANCE_UPLOAD_MAX_BYTES: '0' }), INSTANCE_UPLOAD_DEFAULT_MAX_BYTES)
    assert.equal(resolveInstanceUploadMaxBytes({ BSP_INSTANCE_UPLOAD_MAX_BYTES: 'abc' }), INSTANCE_UPLOAD_DEFAULT_MAX_BYTES)
  })

  it('backs up the existing file before an overwriting upload', () => {
    const root = createTempInstanceRoot()
    fs.writeFileSync(path.join(root, 'cluster.ini'), 'old', 'utf8')
    assert.deepEqual(backupExistingInstanceFile(path.join(root, 'cluster.ini')), { overwritten: true })
    assert.equal(fs.readdirSync(root).filter(name => name.startsWith('cluster.ini.bak.')).length, 1)
    assert.deepEqual(backupExistingInstanceFile(path.join(root, 'missing.ini')), { overwritten: false })
  })

  it('streams an upload to the target through a temp file', async () => {
    const root = createTempInstanceRoot()
    const target = path.join(root, 'uploaded.txt')
    const sizeBytes = await writeInstanceUploadFile(target, Readable.from([Buffer.from('hello '), Buffer.from('world')]))
    assert.equal(sizeBytes, 11)
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello world')
    // 临时文件不应残留
    assert.equal(fs.readdirSync(root).some(name => name.includes('.uploading-')), false)
  })

  it('only allows regular files inside the instance directory to be downloaded', () => {
    const root = createTempInstanceRoot()
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(root, 'sub', 'data.txt'), 'x', 'utf8')
    fs.writeFileSync(path.join(root, 'cluster_token.txt'), 'pds-secret', 'utf8')

    assert.equal(resolveInstanceDownloadPath(root, 'sub/data.txt').ok, true)
    assert.match(resolveInstanceDownloadPath(root, 'cluster_token.txt').ok ? '' : (resolveInstanceDownloadPath(root, 'cluster_token.txt') as { message: string }).message, /敏感/)
    assert.equal(resolveInstanceDownloadPath(root, 'sub').ok, false)
    assert.equal(resolveInstanceDownloadPath(root, 'missing.txt').ok, false)
    assert.equal(resolveInstanceDownloadPath(root, '../outside.txt').ok, false)
  })
})
