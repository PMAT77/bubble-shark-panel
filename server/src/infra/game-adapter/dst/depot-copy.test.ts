import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { copyGameDepotFromDonor, copyGameDepotFromDonorAsync } from './depot-copy.ts'
import { resolveDstUgcModDir } from './ugc-mod-install'

describe('copyGameDepotFromDonor', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-depot-copy-'))
    tempDirs.push(dir)
    return dir
  }

  it('copies data directory and root files but not klei-storage', () => {
    const donor = makeTempDir()
    const recipient = makeTempDir()
    fs.mkdirSync(path.join(donor, 'data', 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(donor, 'data', 'scripts', 'main.lua'), '-- game')
    fs.writeFileSync(path.join(donor, 'steamclient.so'), 'so')
    fs.mkdirSync(path.join(donor, 'klei-storage'), { recursive: true })
    fs.writeFileSync(path.join(donor, 'klei-storage', 'save.txt'), 'save')

    const result = copyGameDepotFromDonor(donor, recipient)
    assert.equal(result.ok, true)
    assert.ok(fs.existsSync(path.join(recipient, 'data', 'scripts', 'main.lua')))
    assert.ok(fs.existsSync(path.join(recipient, 'steamclient.so')))
    assert.equal(fs.existsSync(path.join(recipient, 'klei-storage')), false)
  })

  it('copies bin64 and steamapps but not klei-storage', () => {
    const donor = makeTempDir()
    const recipient = makeTempDir()
    fs.mkdirSync(path.join(donor, 'bin64'), { recursive: true })
    fs.writeFileSync(path.join(donor, 'bin64', 'dontstarve_dedicated_server_x64'), 'bin')
    fs.mkdirSync(path.join(donor, 'steamapps'), { recursive: true })
    fs.writeFileSync(path.join(donor, 'steamapps', 'appmanifest_343050.acf'), '"buildid"\t\t"123"\n')
    fs.mkdirSync(path.join(donor, 'steamapps', 'downloading'), { recursive: true })
    fs.writeFileSync(path.join(donor, 'steamapps', 'downloading', 'partial'), 'x')
    fs.mkdirSync(path.join(donor, 'klei-storage'), { recursive: true })
    fs.writeFileSync(path.join(donor, 'klei-storage', 'save.txt'), 'save')

    const result = copyGameDepotFromDonor(donor, recipient)
    assert.equal(result.ok, true)
    assert.ok(fs.existsSync(path.join(recipient, 'bin64', 'dontstarve_dedicated_server_x64')))
    assert.ok(fs.existsSync(path.join(recipient, 'steamapps', 'appmanifest_343050.acf')))
    assert.equal(fs.existsSync(path.join(recipient, 'steamapps', 'downloading')), false)
    assert.equal(fs.existsSync(path.join(recipient, 'klei-storage')), false)
  })

  it('rejects same donor and recipient path', () => {
    const dir = makeTempDir()
    const result = copyGameDepotFromDonor(dir, dir)
    assert.equal(result.ok, false)
  })

  it('rebuilds managed Mod links inside the recipient without linking back to the donor', async () => {
    const donor = makeTempDir()
    const recipient = makeTempDir()
    fs.mkdirSync(path.join(donor, 'mods'))
    for (const [shard, id] of [['Master', '1185229307'], ['Caves', '222']] as const) {
      const content = resolveDstUgcModDir(donor, shard, id)
      fs.mkdirSync(content, { recursive: true })
      fs.writeFileSync(path.join(content, 'modinfo.lua'), `name = '${id}'`)
      fs.symlinkSync(content, path.join(donor, 'mods', `workshop-${id}`), process.platform === 'win32' ? 'junction' : 'dir')
    }
    const result = await copyGameDepotFromDonorAsync(donor, recipient)
    assert.deepEqual(result, { ok: true })
    for (const [shard, id] of [['Master', '1185229307'], ['Caves', '222']] as const) {
      const link = path.join(recipient, 'mods', `workshop-${id}`)
      const content = resolveDstUgcModDir(recipient, shard, id)
      assert.equal(fs.readFileSync(path.join(link, 'modinfo.lua'), 'utf8'), `name = '${id}'`)
      if (fs.lstatSync(link).isSymbolicLink()) assert.equal(fs.realpathSync(link), fs.realpathSync(content))
      fs.writeFileSync(path.join(link, 'modinfo.lua'), 'recipient only')
      assert.equal(fs.readFileSync(path.join(resolveDstUgcModDir(donor, shard, id), 'modinfo.lua'), 'utf8'), `name = '${id}'`)
    }
    assert.deepEqual(await copyGameDepotFromDonorAsync(donor, recipient), { ok: true }, '复制可重试，已生成的链接不会指回供体')
  })

  it('rejects external, save, mismatched Mod, cyclic and broken source links before copying files', async () => {
    const outside = makeTempDir()
    for (const kind of ['external', 'save', 'wrong-mod', 'cycle', 'broken', 'unmanaged'] as const) {
      const donor = makeTempDir()
      const recipient = makeTempDir()
      fs.mkdirSync(path.join(donor, 'mods'))
      fs.writeFileSync(path.join(donor, 'game'), 'game')
      let target: string
      if (kind === 'external') target = outside
      else if (kind === 'cycle') target = donor
      else if (kind === 'save') target = path.join(donor, 'klei-storage')
      else target = resolveDstUgcModDir(donor, 'Master', kind === 'wrong-mod' ? '222' : '1185229307')
      if (kind !== 'broken') fs.mkdirSync(target, { recursive: true })
      const link = path.join(donor, 'mods', kind === 'unmanaged' ? 'other-link' : 'workshop-1185229307')
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      const result = await copyGameDepotFromDonorAsync(donor, recipient)
      assert.equal(result.ok, false, kind)
      assert.equal(fs.existsSync(path.join(recipient, 'game')), false, kind)
    }
  })

  it('rejects links inside Mod content and recipient paths that escape the installation directory', async () => {
    const donor = makeTempDir()
    const recipient = makeTempDir()
    const outside = makeTempDir()
    const content = resolveDstUgcModDir(donor, 'Master', '1185229307')
    fs.mkdirSync(content, { recursive: true })
    fs.writeFileSync(path.join(content, 'modinfo.lua'), 'mod')
    fs.mkdirSync(path.join(donor, 'mods'))
    fs.symlinkSync(content, path.join(donor, 'mods', 'workshop-1185229307'), process.platform === 'win32' ? 'junction' : 'dir')
    const nested = path.join(content, 'nested')
    fs.symlinkSync(outside, nested, process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await copyGameDepotFromDonorAsync(donor, recipient)).ok, false)
    fs.unlinkSync(nested)
    fs.symlinkSync(outside, path.join(recipient, 'mods'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal((await copyGameDepotFromDonorAsync(donor, recipient)).ok, false)
    assert.deepEqual(fs.readdirSync(outside), [])
  })

  it('streams depot bytes, excludes saves and partial downloads, and cancels during a file', async () => {
    const donor = makeTempDir()
    const recipient = makeTempDir()
    fs.mkdirSync(path.join(donor, 'klei-storage'))
    fs.writeFileSync(path.join(donor, 'klei-storage', 'save'), 'keep private')
    fs.mkdirSync(path.join(donor, 'steamapps', 'downloading'), { recursive: true })
    fs.writeFileSync(path.join(donor, 'steamapps', 'downloading', 'partial'), 'skip')
    fs.writeFileSync(path.join(donor, 'game'), Buffer.alloc(512 * 1024))
    let bytes = 0
    assert.equal((await copyGameDepotFromDonorAsync(donor, recipient, { onProgress: copied => { bytes = copied } })).ok, true)
    assert.equal(bytes, 512 * 1024)
    assert.equal(fs.existsSync(path.join(recipient, 'klei-storage')), false)
    assert.equal(fs.existsSync(path.join(recipient, 'steamapps', 'downloading')), false)
    const controller = new AbortController()
    await assert.rejects(copyGameDepotFromDonorAsync(donor, recipient, {
      signal: controller.signal, onProgress: () => controller.abort(new Error('cancel copy')),
    }), /cancel copy/)
    assert.equal((await copyGameDepotFromDonorAsync(donor, path.join(donor, 'nested'))).ok, false)
    assert.equal(fs.existsSync(path.join(donor, 'nested')), false)
    const progressFailure = await copyGameDepotFromDonorAsync(donor, recipient, { onProgress: () => { throw new Error('EACCES: progress snapshot') } })
    assert.equal(progressFailure.ok, false)
    if (!progressFailure.ok) assert.match(progressFailure.error, /EACCES/)
  })
})
