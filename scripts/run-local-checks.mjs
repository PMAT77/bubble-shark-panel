#!/usr/bin/env node
/**
 * 本地质量门禁的执行入口（替代 `pnpm run release:check` 的沙箱可用版本）。
 *
 * 为什么需要它：pnpm 的可执行文件与全局 store 在仓库外，本机沙箱在 workspace-write
 * 模式下拒绝直接执行 pnpm / node；而仓库内的 node（.ci-node22）与已安装的依赖可以
 * 直接运行。于是这里用工作区内的 node 逐个跑同一套门禁，输出落盘到 logs/verify/，
 * 终端只打印每步的结果。
 *
 * 用法：node scripts/run-local-checks.mjs [步骤名...]
 *   不带参数时跑全部；步骤名见 STEPS 的 key。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const outDir = path.join(repoRoot, 'logs', 'verify')
fs.mkdirSync(outDir, { recursive: true })

const node = process.execPath

/** Windows 下装 Git for Windows 时 bash 的常见位置（check-installer-smoke.mjs 也需要） */
function findBash() {
  if (process.env.GSH_BASH && fs.existsSync(process.env.GSH_BASH)) {
    return process.env.GSH_BASH
  }
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]
  return candidates.find(candidate => fs.existsSync(candidate))
}

function entry(relative) {
  const full = path.join(repoRoot, relative)
  if (!fs.existsSync(full)) {
    throw new Error(`缺少入口文件：${relative}`)
  }
  return full
}

const STEPS = {
  // `--force`：这个入口跑的是"提交前的门禁"，不能吃增量构建缓存——v0.8.2 第一次推送
  // 就是本地增量检查放行、CI 全量检查报 TS2345 而变红的（见 docs_local/DEVELOPMENT.md 的测试与代码检查）。
  types: { label: '类型检查（vue-tsc -b --force）', command: node, args: [entry('node_modules/vue-tsc/bin/vue-tsc.js'), '-b', '--force'] },
  build: { label: '前端生产构建（vite build）', command: node, args: [entry('node_modules/vite/bin/vite.js'), 'build'] },
  'build-server': { label: '后端构建', command: node, args: [entry('scripts/build-server.mjs')] },
  tests: { label: '单元测试', command: node, args: [entry('scripts/run-unit-tests.mjs')] },
  'server-tests': { label: '后端契约测试', command: node, args: [entry('scripts/run-server-tests.mjs')] },
  docs: { label: '文档一致性', command: node, args: [entry('scripts/check-docs.mjs')] },
  copy: { label: '界面文案护栏', command: node, args: [entry('scripts/check-ui-copy.mjs')] },
  gsh: { label: 'gsh CLI 检查', command: node, args: [entry('scripts/check-gsh-cli.mjs')] },
  presets: { label: 'panel.env 预设一致性', command: node, args: [entry('scripts/check-panel-env-presets.mjs')] },
  release: { label: '发布引用一致性', command: node, args: [entry('scripts/check-release-consistency.mjs')] },
}

const bash = findBash()
if (bash) {
  STEPS.lint = {
    label: 'oxlint',
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${path.join(repoRoot, 'node_modules', '.bin', 'oxlint.CMD')}" --deny-warnings .`],
  }
  STEPS.installer = {
    label: '安装器语法与冒烟测试',
    command: node,
    args: [entry('scripts/check-installer-smoke.mjs')],
    env: { ...process.env, GSH_BASH: bash },
  }
}
else {
  console.log('[local-checks] 未找到 bash，跳过 oxlint 与安装器检查')
}

const requested = process.argv.slice(2)
const names = requested.length > 0 ? requested : Object.keys(STEPS)
const results = []

for (const name of names) {
  const step = STEPS[name]
  if (!step) {
    console.error(`[local-checks] 未知步骤：${name}，可选：${Object.keys(STEPS).join(', ')}`)
    process.exit(2)
  }
  console.log(`\n[local-checks] ${name} —— ${step.label}`)
  const logPath = path.join(outDir, `${name}.log`)
  const fd = fs.openSync(logPath, 'w')
  const started = Date.now()
  const result = spawnSync(step.command, step.args, {
    cwd: repoRoot,
    env: step.env ?? process.env,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  })
  fs.closeSync(fd)
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const code = result.status ?? (result.error ? 1 : 0)
  results.push({ name, label: step.label, code, seconds, logPath, error: result.error?.message })
  console.log(`[local-checks] ${name} → ${code === 0 ? 'PASS' : 'FAIL'}（${seconds}s，日志：logs/verify/${name}.log）`)
  if (result.error) {
    console.error(`[local-checks] ${name} 启动失败：${result.error.message}`)
  }
}

const failed = results.filter(item => item.code !== 0)
console.log('\n[local-checks] 汇总')
for (const item of results) {
  console.log(`  ${item.code === 0 ? 'PASS' : 'FAIL'}  ${item.name.padEnd(14)} ${item.label}（${item.seconds}s）`)
}
console.log(`[local-checks] ${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length > 0 ? 1 : 0)
