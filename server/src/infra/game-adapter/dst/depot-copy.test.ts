import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { copyGameDepotFromDonor, copyGameDepotFromDonorAsync } from './depot-copy.ts'

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
