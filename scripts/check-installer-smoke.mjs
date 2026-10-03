#!/usr/bin/env node
// 安装器脚本的本地语法检查 + 冒烟测试。
//
// 背景：v0.5.0 发布时 CI 在「Installer syntax and smoke test」一步中断——冒烟用例里
// 「可升级目标版本」与已安装版本耦合，版本号 bump 后它变成了降级请求，被更新执行器
// 正确拒绝，断言随之失败。类型检查、单测、release:verify 都看不见这类问题，只有真跑
// 一遍才会暴露，所以把它并入本地发布门禁（release:check）。
//
// 用法：node scripts/check-installer-smoke.mjs（也通过 pnpm run check:installer 调用）
// bash 来源：Linux/macOS 取 PATH 里的 bash；Windows 自动探测 Git for Windows 自带的 bash，
//           也可用 GSH_BASH=<bash 路径> 指定。确实找不到 bash 时打印跳过提示并成功退出
//           （本地跳过不等于通过，CI 禁止跳过）。
// 逃生阀：GSH_SKIP_INSTALLER_SMOKE=1 仅在本地跳过。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')

// 与 CI 的「Installer syntax and smoke test」保持一致：先逐个语法检查，再跑冒烟
const SYNTAX_TARGETS = [
  'scripts/install.linux.sh',
  'scripts/install-linux-smoke.sh',
  'scripts/gsh.sh',
  'scripts/gsh-native-update.sh',
]
const SMOKE_TARGET = 'scripts/install-linux-smoke.sh'

function findBash() {
  const candidates = []
  if (process.env.GSH_BASH) {
    candidates.push(process.env.GSH_BASH)
  }
  if (process.platform === 'win32') {
    // Git for Windows 的常见安装位置
    for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
      const base = process.env[key]
      if (!base) continue
      candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'))
      candidates.push(path.join(base, 'Programs', 'Git', 'bin', 'bash.exe'))
    }
    // PATH 里若有 git.exe，按其安装根目录反推 bash（<root>\cmd\git.exe 或 <root>\bin\git.exe）
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue
      const gitExe = path.join(dir, 'git.exe')
      if (!fs.existsSync(gitExe)) continue
      candidates.push(path.join(path.dirname(path.dirname(gitExe)), 'bin', 'bash.exe'))
    }
  }
  candidates.push('bash')

  for (const candidate of candidates) {
    if (candidate !== 'bash' && !fs.existsSync(candidate)) continue
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

function skip(reason) {
  if (process.env.CI) {
    console.error(`[installer-smoke] CI 禁止跳过：${reason}`)
    process.exit(1)
  }
  console.log(`[installer-smoke] SKIP: ${reason}`)
  process.exit(0)
}

if (process.env.GSH_SKIP_INSTALLER_SMOKE === '1') {
  skip('GSH_SKIP_INSTALLER_SMOKE=1，已跳过安装器语法与冒烟测试')
}

const bash = findBash()
if (!bash) {
  skip('未找到 bash；可用 GSH_BASH=<bash 路径> 指定解释器')
}

console.log(`[installer-smoke] 使用 ${bash}`)

function runBash(args, label) {
  const result = spawnSync(bash, args, { cwd: repoRoot, stdio: 'inherit' })
  if (result.error) {
    console.error(`[installer-smoke] ${label} 无法执行：${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`[installer-smoke] ${label} 失败（退出码 ${result.status}）`)
    process.exit(1)
  }
}

for (const target of SYNTAX_TARGETS) {
  runBash(['-n', target], `语法检查 ${target}`)
}
runBash([SMOKE_TARGET], `冒烟测试 ${SMOKE_TARGET}`)

console.log('[installer-smoke] 安装器脚本语法与冒烟测试通过')
