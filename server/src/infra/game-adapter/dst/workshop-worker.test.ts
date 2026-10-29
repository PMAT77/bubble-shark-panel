import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { WorkshopWorker } from './workshop-worker'

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-shared-workshop-'))
  const cacheRoot = path.join(root, 'cache')
  const output = path.join(root, 'worker.mjs')
  const bundled = await build({ entryPoints: ['server/src/infra/game-adapter/dst/mod-download-worker.mjs'], outfile: output, write: false,
    bundle: true, platform: 'node', format: 'esm', plugins: [{ name: 'steam-fixture', setup(builder) {
      builder.onResolve({ filter: /workshop-cdn\.mjs$/ }, () => ({ path: 'sdk', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        import fs from 'node:fs'; import path from 'node:path'; import {setTimeout as delay} from 'node:timers/promises';
        export function createWorkshopSession() { return {signal: new AbortController().signal, transport:{save(){}}, close(){}} }
        export async function downloadWorkshopContent({ids,cacheRoot,signal,onEvent}) {
          const id=ids[0]; fs.mkdirSync(cacheRoot,{recursive:true}); fs.appendFileSync(path.join(cacheRoot,'calls'),id+'\\n');
          onEvent({workshopId:id,phase:'downloading',progress:{downloadedBytes:0,totalBytes:4,percent:0}});
          await delay(80,undefined,{signal});
          const sourceDir=path.join(cacheRoot,id,'100','content'); fs.mkdirSync(sourceDir,{recursive:true});
          fs.writeFileSync(path.join(sourceDir,'modinfo.lua'),'test');
          return [{workshopId:id,ok:true,sourceDir,manifestId:'100',updatedAt:'2026-01-01T00:00:00.000Z'}];
        }
      ` }))
    } }] })
  fs.writeFileSync(output, bundled.outputFiles[0]!.contents)
  const worker = new WorkshopWorker({ cacheRoot, maxCacheBytes: 0 }, () => {}, output)
  t.after(async () => { await worker.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const acquire = (workshopId: string, signal = new AbortController().signal) => worker.acquire({ workshopId, signal,
    existingRoot: root, legacyCacheRoot: root, timeoutMs: 5000, onProgress() {} })
  return { root, cacheRoot, worker, acquire }
}

it('shares in-flight content, isolates subscriber cancellation and retains a source until installation releases it', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  const first = f.acquire('1', controller.signal)
  const second = f.acquire('1')
  const cancelled = assert.rejects(first.result, /下载已取消/)
  controller.abort()
  await cancelled
  const result = await second.result
  assert.equal(result.ok, true)
  assert.equal(fs.readFileSync(path.join(f.cacheRoot, 'calls'), 'utf8'), '1\n')
  f.worker.prune()
  await delay(40)
  assert.equal(fs.existsSync(result.sourceDir!), true)
  second.release()
  f.worker.prune()
  await delay(40)
  assert.equal(fs.existsSync(path.join(result.sourceDir!, 'modinfo.lua')), false)
})

it('acknowledges cancellation of the last subscriber before allowing a fresh attempt for that item', async t => {
  const f = await fixture(t)
  const controller = new AbortController()
  const first = f.acquire('2', controller.signal)
  const cancelled = assert.rejects(first.result, /下载已取消/)
  controller.abort()
  await cancelled
  const retry = f.acquire('2')
  assert.equal((await retry.result).ok, true)
  retry.release()
})
