import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, it } from 'node:test'
import { runNativeSteamcmdJob } from './native-steamcmd-runner'
import { parsePublicBuildIdFromAppInfo } from '../../shared/steam-update/app-info'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-steamcmd-query-'))
const previousPath = process.env.BSP_NATIVE_STEAMCMD_PATH
process.env.BSP_NATIVE_STEAMCMD_PATH = process.execPath
after(() => {
  if (previousPath === undefined) {
    delete process.env.BSP_NATIVE_STEAMCMD_PATH
  }
  else {
    process.env.BSP_NATIVE_STEAMCMD_PATH = previousPath
  }
  fs.rmSync(root, { recursive: true, force: true })
})

async function run(source: string, timeoutMs = 5000) {
  const script = path.join(root, 'fake-steamcmd.cjs')
  fs.writeFileSync(script, source)
  return runNativeSteamcmdJob({ args: [script], kind: 'app-info', timeoutMs })
}

it('collects split stdout including more than 80 lines and an unterminated final line', async () => {
  const result = await run(`
    process.stdout.write('"343050" {\\n"depots" {\\n');
    for (let i = 0; i < 100; i++) console.log('"depot' + i + '" { "public" { "gid" "1" } }');
    process.stdout.write('"branches" { "pub');
    setTimeout(() => process.stdout.write('lic" { "buildid" "25643504" } "updatebeta" { "buildid" "25540104" } } } }'), 20);
  `)
  assert.equal(result.ok, true)
  assert.equal(parsePublicBuildIdFromAppInfo(result.output, '343050'), '25643504')
})

it('rejects excess output, nonzero exits and timeouts', async () => {
  const excess = await run(`process.stdout.write(' '.repeat(1024 * 1024 + 1))`)
  assert.equal(excess.ok, false)
  assert.match(excess.output, /超过 1 MiB/)
  const failed = await run(`console.log('"appid" "343050"'); process.exitCode = 1`)
  assert.equal(failed.ok, false)
  const timeout = await run('setInterval(() => {}, 1000)', 100)
  assert.equal(timeout.ok, false)
  assert.equal(timeout.timedOut, true)
})
