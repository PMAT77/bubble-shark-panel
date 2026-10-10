import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { it } from 'node:test'
import { build } from 'esbuild'

it('bundles the reader and isolated worker for Docker and Native without runtime node_modules', async () => {
  const cache = path.resolve('node_modules/.tmp')
  fs.mkdirSync(cache, { recursive: true })
  const dir = fs.mkdtempSync(path.join(cache, 'bsp-modinfo-build-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}')
    const install = path.join(dir, 'install')
    const modDir = path.join(install, 'steamapps/workshop/content/322330/123')
    fs.mkdirSync(modDir, { recursive: true })
    fs.writeFileSync(path.join(modDir, 'modinfo.lua'), 'local choices={{description="Yes",data=true}}\nconfiguration_options={{name="flag",options=choices,default=true}}')
    for (const format of ['docker', 'native']) {
      const extension = format === 'docker' ? '.js' : '.mjs'
      const output = path.join(dir, format)
      fs.mkdirSync(output, { recursive: true })
      await build({
        entryPoints: {
          reader: path.resolve('server/src/infra/game-adapter/dst/modinfo-reader.ts'),
          'modinfo-reader-worker': path.resolve('server/src/infra/game-adapter/dst/modinfo-reader-worker.mjs'),
        },
        outdir: output, outExtension: { '.js': extension },
        bundle: true, splitting: format === 'docker', format: 'esm', platform: 'node', target: 'node22', packages: 'bundle',
        banner: { js: 'import {createRequire as __gshCreateRequire} from "node:module"; const require=__gshCreateRequire(import.meta.url);' },
        logLevel: 'silent',
      })
      const entry = pathToFileURL(path.join(output, `reader${extension}`)).href
      const source = `import {readModInfoConfigurations} from ${JSON.stringify(entry)}; console.log(JSON.stringify(await readModInfoConfigurations(${JSON.stringify(install)}, "123")))`
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', timeout: 10_000, env: {}, windowsHide: true })
      assert.equal(child.status, 0, child.stderr)
      const result = JSON.parse(child.stdout)
      assert.equal(result.definitionStatus, 'parsed', child.stdout)
      assert.equal(result.definitions[0].default, true)
    }
  }
  finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
