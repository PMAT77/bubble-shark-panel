import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { after, it } from 'node:test'
import type Docker from 'dockerode'
import tar from 'tar-stream'
import { collectDockerSteamcmdDiagnostics, NativeSteamcmdLogDiagnostics, steamcmdLogDirectory } from './steamcmd-log-diagnostics'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-steamcmd-diagnostics-'))
after(() => fs.rmSync(root, { recursive: true, force: true }))

it('identifies SteamCMD log locations and reads only native appended content', () => {
  const directory = path.join(root, 'logs')
  fs.mkdirSync(directory)
  const file = path.join(directory, 'content_log.txt')
  fs.writeFileSync(file, 'OLD ERROR: Not enough disk space\n')
  const diagnostics = new NativeSteamcmdLogDiagnostics(path.join(root, 'steamcmd.sh'))
  assert.equal(steamcmdLogDirectory(`Logging directory: '${directory}'`), directory)
  diagnostics.observe(`Logging directory: '${directory}'`)
  fs.appendFileSync(file, 'CURRENT: HTTP error 503\n')
  const lines: string[] = []
  diagnostics.collect(line => lines.push(line))
  assert.match(lines.join('\n'), /CURRENT/)
  assert.doesNotMatch(lines.join('\n'), /OLD ERROR/)
  assert.match(lines.join('\n'), /stderr.txt 未采集/)
  fs.writeFileSync(file, 'TRUNCATED\n')
  lines.length = 0
  diagnostics.collect(line => lines.push(line))
  assert.match(lines.join('\n'), /TRUNCATED/)
  fs.renameSync(file, `${file}.old`)
  fs.writeFileSync(file, 'ROTATED\n')
  lines.length = 0
  diagnostics.collect(line => lines.push(line))
  assert.match(lines.join('\n'), /ROTATED/)
})

it('streams only allowed Docker files, bounds their tails, and tolerates missing files', async () => {
  const lines: string[] = []
  const container = {
    async getArchive(options: { path: string }) {
      if (options.path.endsWith('stderr.txt')) throw new Error('file not found')
      const pack = tar.pack()
      pack.entry({ name: 'unexpected-secret.txt' }, 'DO NOT READ')
      pack.entry({ name: 'content_log.txt' }, `${'x'.repeat(70 * 1024)}\n${Array.from({ length: 100 }, (_, i) => `current ${i}`).join('\n')}`)
      pack.finalize()
      return pack
    },
  } as unknown as Docker.Container
  await collectDockerSteamcmdDiagnostics(container, '/home/node/Steam/logs', line => lines.push(line))
  assert.doesNotMatch(lines.join('\n'), /DO NOT READ|current 0\n/)
  assert.match(lines.join('\n'), /current 99/)
  assert.equal(lines.filter(line => line.startsWith('current ')).length, 80)
  assert.match(lines.join('\n'), /stderr.txt 未采集/)
})

it('enforces the total archive cap and does not extract links', async () => {
  const lines: string[] = []
  const container = {
    async getArchive(options: { path: string }) {
      if (options.path.endsWith('stderr.txt')) return Readable.from([Buffer.alloc(8 * 1024 * 1024 + 1)])
      const pack = tar.pack()
      pack.entry({ name: 'content_log.txt', type: 'symlink', linkname: '/etc/shadow' })
      pack.finalize()
      return pack
    },
  } as unknown as Docker.Container
  await collectDockerSteamcmdDiagnostics(container, '/logs', line => lines.push(line))
  assert.match(lines.join('\n'), /普通文件/)
  assert.match(lines.join('\n'), /8 MiB/)
})

it('bounds a stalled Docker archive request and destroys a late response', async () => {
  let finish!: (stream: Readable) => void
  const late = new Readable({ read() {} })
  const lines: string[] = []
  const container = { getArchive: () => new Promise<Readable>(resolve => { finish = resolve }) } as unknown as Docker.Container
  const start = Date.now()
  await collectDockerSteamcmdDiagnostics(container, '/logs', line => lines.push(line))
  assert.ok(Date.now() - start < 6500)
  assert.match(lines.join('\n'), /5 秒采集上限/)
  finish(late)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(late.destroyed, true)
})
