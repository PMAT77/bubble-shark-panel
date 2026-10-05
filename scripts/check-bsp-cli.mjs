#!/usr/bin/env node
// bsp CLI 静态检查。
//
// 背景：scripts/bsp.sh 曾把转义序列 \n / \t / \b 写成 $n / $t / $b。这类笔误不会让
// 脚本报错，只会在运行时表现为「输出挤成一行」或「/etc/fstab 写入非法行」，因此用静态
// 检查挡住，并同时锁住几处与安装器约定相关的关键行为。
//
// 用法：node scripts/check-bsp-cli.mjs（也通过 pnpm run check:bsp 调用）
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const gshPath = path.join(repoRoot, 'scripts', 'bsp.sh')
const source = fs.readFileSync(gshPath, 'utf8')
const lines = source.split(/\r?\n/)

const failures = []

// 1) 转义笔误：本脚本没有名为 n / t / b 的变量，出现即为写错的转义序列
const typoRe = /\$[ntb](?![A-Za-z0-9_])/g
lines.forEach((line, index) => {
  for (const match of line.matchAll(typoRe)) {
    failures.push(`scripts/bsp.sh:${index + 1} 疑似把转义序列写成了 ${match[0]}：${line.trim()}`)
  }
})

// 2) 输出函数必须真正换行，否则所有日志挤成一行
for (const fn of ['log_info', 'log_warn', 'log_error']) {
  const line = lines.find(item => item.startsWith(`${fn}() {`))
  if (!line) {
    failures.push(`scripts/bsp.sh 缺少 ${fn} 定义`)
    continue
  }
  if (!line.includes('\\n')) {
    failures.push(`${fn} 的 printf 格式串缺少换行符：${line.trim()}`)
  }
}

// 3) Native 安装器写入的端口键是 SERVER_PORT，Docker 分支才是 PANEL_PORT
if (!/SERVER_PORT/.test(source)) {
  failures.push('scripts/bsp.sh 未读取 Native 的 SERVER_PORT 端口键，Native 下探活会落到默认端口')
}
if (!/PANEL_PORT="\$\{PANEL_PORT:-9527\}"/.test(source)) {
  failures.push('scripts/bsp.sh 的面板端口默认值与安装器的 9527 不一致')
}

// fstab 的分行与末尾换行由安装冒烟验证；此处只检查默认路径。
if (!source.includes('/etc/fstab')) {
  failures.push('scripts/bsp.sh 的 fstab 默认路径不再是 /etc/fstab')
}

// 5) 诊断日志路径必须来自 panel.env，不能硬编码安装目录
if (/DIAGNOSTICS_LOG="\/opt\//.test(source)) {
  failures.push('scripts/bsp.sh 的 DIAGNOSTICS_LOG 仍硬编码为安装目录路径')
}

// 库模式与 swap 创建由安装冒烟执行；这里只保留安装调用顺序与用户开关检查。
const installerPath = path.join(repoRoot, 'scripts', 'install.linux.sh')
if (!fs.existsSync(installerPath)) {
  failures.push('scripts/install.linux.sh 不存在，无法校验库模式契约')
}
else {
  const installer = fs.readFileSync(installerPath, 'utf8')

  if (!/--no-swap/.test(installer)) {
    failures.push('scripts/install.linux.sh 缺少 --no-swap 开关')
  }
  // bsp CLI 必须先于自动 swap 就位：安装器复用本地 bsp.sh，但 curl | bash 路线只能靠已部署的 bsp。
  const cliLine = installer.split(/\r?\n/).findIndex(line => line.includes('install_gsh_cli'))
  const swapCallLine = installer.split(/\r?\n/).findIndex(line => line.trim() === 'ensure_small_host_swap')
  if (cliLine < 0 || swapCallLine < 0) {
    failures.push('scripts/install.linux.sh 未找到 install_gsh_cli 或 ensure_small_host_swap 调用点')
  }
  else if (cliLine > swapCallLine) {
    failures.push('scripts/install.linux.sh 的 install_gsh_cli 必须排在 ensure_small_host_swap 之前')
  }
}

if (failures.length > 0) {
  console.error('[bsp-cli] 检查失败：')
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log('[bsp-cli] bsp CLI 检查通过')
