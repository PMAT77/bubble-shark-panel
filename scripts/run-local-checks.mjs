#!/usr/bin/env node
// 本地与 CI 共用的质量门禁；可指定步骤，完整日志写入 logs/verify/。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const outDir = path.join(repoRoot, 'logs', 'verify')
const STEPS = {
  // 提交前强制检查，避免增量缓存放过类型边界变更。
  types: { label: '类型检查', args: ['node_modules/vue-tsc/bin/vue-tsc.js', '-b', '--force'] },
  lint: { label: 'oxlint', args: ['node_modules/oxlint/bin/oxlint', '--deny-warnings', '.'] },
  copy: { label: '界面文案护栏', args: ['scripts/check-ui-copy.mjs'] },
  transition: { label: '页面转场护栏', args: ['scripts/check-page-transition.mjs'] },
  routes: { label: '路由鉴权', args: ['scripts/check-route-permissions.mjs'] },
  'write-entries': { label: '写入口权限', args: ['scripts/check-write-entry-permissions.mjs'] },
  'menu-pages': { label: '菜单页读权限', args: ['scripts/check-menu-page-permissions.mjs'] },
  docs: { label: '文档一致性', args: ['scripts/check-docs.mjs'] },
  gsh: { label: 'gsh CLI 检查', args: ['scripts/check-gsh-cli.mjs'] },
  presets: { label: 'panel.env 预设一致性', args: ['scripts/check-panel-env-presets.mjs'] },
  release: { label: '发布引用一致性', args: ['scripts/check-release-consistency.mjs'] },
  tests: { label: '全量单元测试', args: ['scripts/run-unit-tests.mjs'] },
  installer: { label: '安装器语法与冒烟', args: ['scripts/check-installer-smoke.mjs'] },
  build: { label: '前端生产构建', args: ['node_modules/vite/bin/vite.js', 'build'] },
  'build-server': { label: '后端构建', args: ['scripts/build-server.mjs'] },
  'server-tests': { label: '后端单元测试', args: ['scripts/run-server-tests.mjs'] },
}

const requested = process.argv.slice(2)
const names = [...new Set(requested.length > 0 ? requested : Object.keys(STEPS).filter(name => name !== 'server-tests'))]
for (const name of names) {
  if (!Object.hasOwn(STEPS, name)) {
    console.error(`[local-checks] 未知步骤：${name}，可选：${Object.keys(STEPS).join(', ')}`)
    process.exit(2)
  }
}

fs.mkdirSync(outDir, { recursive: true })
const results = []
for (const name of names) {
  const step = STEPS[name]
  console.log(`\n[local-checks] ${name} —— ${step.label}`)
  const logPath = path.join(outDir, `${name}.log`)
  const fd = fs.openSync(logPath, 'w')
  const started = Date.now()
  const result = spawnSync(process.execPath, [path.join(repoRoot, step.args[0]), ...step.args.slice(1)], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  })
  fs.closeSync(fd)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const log = fs.readFileSync(logPath, 'utf8')
  const skipped = name === 'installer' && /^\[installer-smoke\] SKIP:/m.test(log)
  const code = result.status ?? 1
  const status = code !== 0 || (process.env.CI && skipped) ? 'FAIL' : skipped ? 'SKIP' : 'PASS'
  results.push({ name, label: step.label, status, seconds })
  console.log(`[local-checks] ${name} → ${status}（${seconds}s，日志：logs/verify/${name}.log）`)
  if (status !== 'PASS') {
    const lines = log.split(/\r?\n/)
    const failures = lines.flatMap((line, index) => /^\s*(?:not ok\b|✖)/.test(line)
      ? lines.slice(Math.max(0, index - 1), index + 40)
      : [])
    console.error(result.error?.message ?? [...failures, ...lines.slice(-100)].join('\n'))
    if (process.env.GITHUB_ACTIONS === 'true' && status === 'FAIL') {
      const details = result.error?.message ?? (failures.length > 0 ? failures : lines.slice(-100)).join('\n')
      const annotation = details.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
      console.error(`::error title=${step.label}::${annotation}`)
    }
  }
}

console.log('\n[local-checks] 汇总')
for (const item of results) {
  console.log(`  ${item.status}  ${item.name.padEnd(14)} ${item.label}（${item.seconds}s）`)
}
const passed = results.filter(item => item.status === 'PASS').length
const skipped = results.filter(item => item.status === 'SKIP').length
console.log(`[local-checks] ${passed}/${results.length} 通过，${skipped} 项跳过`)
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Quality checks\n\n| Step | Result | Seconds |\n| --- | --- | --- |\n${results.map(item => `| ${item.name} | ${item.status} | ${item.seconds} |`).join('\n')}\n`)
}
process.exit(results.some(item => item.status === 'FAIL') ? 1 : 0)
