import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('共用门禁只执行一次全量测试，保留按需步骤及失败、跳过状态', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsh-checks-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.copyFileSync(new URL('./run-local-checks.mjs', import.meta.url), path.join(root, 'scripts/run-local-checks.mjs'))
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}')
  const trace = path.join(root, 'trace.jsonl')
  const summary = path.join(root, 'summary.md')
  const entries = [
    'node_modules/vue-tsc/bin/vue-tsc.js', 'node_modules/oxlint/bin/oxlint',
    'node_modules/vite/bin/vite.js', 'scripts/build-server.mjs',
    'scripts/run-unit-tests.mjs', 'scripts/run-server-tests.mjs',
    ...['ui-copy', 'page-transition', 'route-permissions', 'write-entry-permissions',
      'menu-page-permissions', 'docs', 'gsh-cli', 'panel-env-presets',
      'release-consistency', 'installer-smoke'].map(name => `scripts/check-${name}.mjs`),
  ]
  for (const entry of entries) {
    const target = path.join(root, entry)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify([${JSON.stringify(entry)}, ...process.argv.slice(2)]) + '\\n');
if (process.env.GSH_CHECK_FIXTURE_FAIL === ${JSON.stringify(entry)}) { console.error('fixture failure'); process.exit(3) }
if (process.env.GSH_CHECK_FIXTURE_SKIP === ${JSON.stringify(entry)}) console.log('[installer-smoke] SKIP: fixture');`)
  }
  const run = (args: string[] = [], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
    [path.join(root, 'scripts/run-local-checks.mjs'), ...args], {
      encoding: 'utf8', env: { ...process.env, CI: '', GITHUB_STEP_SUMMARY: summary, ...env },
    })
  const calls = () => fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
  const full = run()
  assert.equal(full.status, 0, full.stderr)
  assert.equal(calls().length, 15)
  assert.equal(calls().filter(call => call[0] === 'scripts/run-unit-tests.mjs').length, 1)
  assert.equal(calls().some(call => call[0] === 'scripts/run-server-tests.mjs'), false)
  assert.deepEqual(calls().find(call => call[0]?.includes('vue-tsc')), [entries[0], '-b', '--force'])
  assert.deepEqual(calls().find(call => call[0]?.includes('vite.js')), ['node_modules/vite/bin/vite.js', 'build'])
  assert.match(fs.readFileSync(summary, 'utf8'), /\| tests \| PASS \|/)

  fs.writeFileSync(trace, '')
  assert.equal(run(['server-tests', 'server-tests']).status, 0)
  assert.deepEqual(calls(), [['scripts/run-server-tests.mjs']])
  const failed = run(['gsh'], { GSH_CHECK_FIXTURE_FAIL: 'scripts/check-gsh-cli.mjs' })
  assert.equal(failed.status, 1)
  assert.match(failed.stdout, /gsh → FAIL/)
  assert.match(failed.stderr, /fixture failure/)
  assert.match(fs.readFileSync(path.join(root, 'logs/verify/gsh.log'), 'utf8'), /fixture failure/)
  const skipEnv = { GSH_CHECK_FIXTURE_SKIP: 'scripts/check-installer-smoke.mjs' }
  assert.match(run(['installer'], skipEnv).stdout, /installer → SKIP/)
  assert.equal(run(['installer'], { ...skipEnv, CI: 'true' }).status, 1)
  fs.writeFileSync(trace, '')
  assert.equal(run(['gsh', 'unknown']).status, 2)
  assert.equal(fs.readFileSync(trace, 'utf8'), '')

  const installer = path.join(root, 'scripts/check-installer-smoke.mjs')
  fs.copyFileSync(new URL('./check-installer-smoke.mjs', import.meta.url), installer)
  const skipped = run(['installer'], { GSH_SKIP_INSTALLER_SMOKE: '1' })
  assert.equal(skipped.status, 0, skipped.stderr)
  assert.match(skipped.stdout, /installer → SKIP/)
  assert.equal(run(['installer'], { GSH_SKIP_INSTALLER_SMOKE: '1', CI: 'true' }).status, 1)
})
