import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { it } from 'node:test'
import { build } from 'esbuild'

it('starts the self-contained worker outside the source tree without node_modules', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-cdn-release-'))
  try {
    const { steamCdnBundlePlugin } = await import('../../../../../scripts/steam-cdn-bundle.mjs')
    const output = path.join(directory, 'worker.mjs')
    const bundle = await build({ entryPoints: [path.resolve('server/src/infra/game-adapter/dst/mod-download-worker.mjs')], outfile: output, write: false,
      bundle: true, platform: 'node', target: 'node22', format: 'esm',
      plugins: [steamCdnBundlePlugin()],
      banner: { js: 'import {createRequire} from "node:module"; import {fileURLToPath} from "node:url"; import {dirname} from "node:path"; const require=createRequire(import.meta.url); const __filename=fileURLToPath(import.meta.url); const __dirname=dirname(__filename);' } })
    fs.writeFileSync(output, bundle.outputFiles[0]!.contents)
    assert.doesNotThrow(() => execFileSync(process.execPath, [output, '--check-runtime'], { cwd: directory, timeout: 10_000, env: {}, windowsHide: true, stdio: 'pipe' }))
  }
  finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
