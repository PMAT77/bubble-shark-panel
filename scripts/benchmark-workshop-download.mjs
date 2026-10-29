// Downloads only into an owned temporary directory; never installs into an instance.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { steamCdnBundlePlugin } from './steam-cdn-bundle.mjs'

const args = process.argv.slice(2)
if (!args.length || args.includes('--help')) {
  console.info('用法：node scripts/benchmark-workshop-download.mjs --ids <ID,ID> [--runs 3] [--baseline <commit SHA>] [--warm] [--existing-root <只读的 Workshop content/322330 目录>]')
  process.exit(0)
}
const value = key => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1] }
const ids = [...new Set((value('--ids') || '').split(',').filter(Boolean))]
const runs = Number(value('--runs') || 3)
const baseline = value('--baseline')
if (!ids.length || ids.length > 10 || ids.some(id => !/^[1-9]\d{0,19}$/.test(id)) || !Number.isInteger(runs) || runs < 1 || runs > 10 || (baseline && !/^[a-f0-9]{7,40}$/i.test(baseline))) {
  console.error('ID、执行次数或基线 commit SHA 无效。')
  process.exit(1)
}
const repository = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-workshop-benchmark-'))
const source = 'server/src/infra/game-adapter/dst/workshop-cdn.mjs'
const engines = []
const results = []
let failures = 0
const banner = 'import {createRequire} from "node:module"; import {fileURLToPath} from "node:url"; import {dirname} from "node:path"; const require=createRequire(import.meta.url); const __filename=fileURLToPath(import.meta.url); const __dirname=dirname(__filename);'
try {
  for (const name of baseline ? ['baseline', 'optimized'] : ['optimized']) {
    const output = path.join(temporary, `${name}.mjs`)
    const compiled = await build({ ...(name === 'baseline'
      ? { stdin: { contents: execFileSync('git', ['show', `${baseline}:${source}`], { cwd: repository, encoding: 'utf8' }), resolveDir: path.dirname(path.join(repository, source)), loader: 'js' } }
      : { entryPoints: [path.join(repository, source)] }),
    outfile: output, write: false, bundle: true, platform: 'node', target: 'node22', format: 'esm',
    plugins: [steamCdnBundlePlugin()], banner: { js: banner } })
    fs.writeFileSync(output, compiled.outputFiles[0].contents)
    engines.push({ name, download: (await import(pathToFileURL(output).href)).downloadWorkshopContent })
  }
  for (let run = 0; run < runs; run++) {
    for (const id of ids) for (const engine of run % 2 ? [...engines].reverse() : engines) {
      const cacheRoot = path.join(temporary, engine.name, args.includes('--warm') ? 'warm' : String(run), id)
      fs.mkdirSync(cacheRoot, { recursive: true })
      const started = performance.now()
      try {
        const [item] = await engine.download({ ids: [id], cacheRoot, existingRoot: value('--existing-root'), signal: AbortSignal.timeout(15 * 60_000) })
        const record = { engine: engine.name, run: run + 1, workshopId: id, ok: item.ok, manifestId: item.manifestId,
          elapsedMs: Math.round(performance.now() - started), totalBytes: item.totalBytes, reusedBytes: item.reusedBytes,
          error: item.error, diagnostics: item.diagnostics }
        results.push(record)
        if (!item.ok) failures++
        console.info(JSON.stringify(record))
      }
      catch (error) { failures++; console.info(JSON.stringify({ engine: engine.name, run: run + 1, workshopId: id, ok: false,
        failureStage: error.failureStage, elapsedMs: Math.round(performance.now() - started), error: String(error.message).replace(/https?:\/\/\S+/g, '[URL]') })) }
    }
  }
  for (const id of ids) {
    const versions = new Set(results.filter(item => item.workshopId === id && item.ok).map(item => item.manifestId))
    for (const engine of engines) {
      const samples = results.filter(item => item.workshopId === id && item.engine === engine.name && item.ok).map(item => item.elapsedMs).sort((a, b) => a - b)
      console.info(JSON.stringify({ summary: true, workshopId: id, engine: engine.name, successfulRuns: samples.length,
        comparableManifest: versions.size === 1, medianMs: samples.length ? samples[Math.floor(samples.length / 2)] : null,
        minMs: samples[0] ?? null, maxMs: samples.at(-1) ?? null }))
    }
  }
  process.exitCode = failures ? 1 : 0
}
finally {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(temporary))
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(temporary, { recursive: true, force: true })
}
