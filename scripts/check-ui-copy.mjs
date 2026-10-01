#!/usr/bin/env node
/**
 * 界面文案护栏：用户可见文案里不得出现部署/实现细节。
 *
 * 背景：面板使用者是游戏服主，不是运维。环境变量名、容器/镜像/compose、
 * systemd 这类词对他是噪音，也无法据此行动。
 * 维护规则：只加词，删词要谨慎；注释与测试里的技术词不受限制。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scanRoot = path.join(repoRoot, 'src')
const EXTENSIONS = new Set(['.vue', '.ts', '.js'])

/** 出现在任何位置都算缺陷 */
const FORBIDDEN = [
  'docker.sock',
  'linger',
  'user bus',
  'ghcr.io',
  'VACUUM INTO',
  'Compose',
  'cluster.ini',
  'modoverrides.lua',
  'klei-storage',
  'systemd',
]

/** 只有在字符串字面量里才算缺陷：这些前缀同时也是代码标识符命名习惯 */
const FORBIDDEN_IN_STRING = ['GSH_', 'PANEL_', 'ADMIN_PASSWORD', 'panel.env']

/**
 * 例外文件：这里的 `GSH_` 出现在**用户要照着敲的命令**里，不是解释性文案。
 *
 * `gsh setup-swap` 只认 `GSH_SWAP_SIZE` 环境变量（没有 `--size` 这类参数，见 scripts/gsh.sh 的
 * cmd_setup_swap），把「缓存区扩到 4 GiB」写成可照抄的命令就只有这一种写法。
 * 例外按文件给而不是删词：删掉 `GSH_` 会让整改方向变成「别提示用户扩容」。
 */
const FORBIDDEN_IN_STRING_EXEMPT = new Set(['src/utils/hostMemoryPressure.ts'])

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(full))
      continue
    }
    // 假数据文件模拟的是真实后端返回，不属于界面文案
    if (entry.name.includes('.test.') || entry.name.endsWith('.fake.ts')) {
      continue
    }
    if (EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full)
    }
  }
  return out
}

/** 去掉行内注释与 HTML 注释；引号内的 // 不算注释 */
function stripInlineComments(line) {
  let quote = null
  for (let i = 0; i < line.length - 1; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\') {
        i += 1
        continue
      }
      if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '/' && line[i + 1] === '/') {
      return line.slice(0, i)
    }
    if (ch === '<' && line.startsWith('<!--', i)) {
      return line.slice(0, i)
    }
  }
  return line
}

/** 收集一行里所有字符串字面量的内容 */
function collectStringContents(line) {
  const out = []
  let quote = null
  let current = ''
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === '\\') {
        current += line[i + 1] ?? ''
        i += 1
        continue
      }
      if (ch === quote) {
        out.push(current)
        current = ''
        quote = null
        continue
      }
      current += ch
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
    }
  }
  return out
}

const findings = []

for (const file of walk(scanRoot)) {
  const relativePath = path.relative(repoRoot, file).replaceAll('\\', '/')
  const stringExempt = FORBIDDEN_IN_STRING_EXEMPT.has(relativePath)
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  let inBlockComment = false
  lines.forEach((rawLine, index) => {
    let line = rawLine
    const trimmed = line.trim()
    if (inBlockComment) {
      if (trimmed.includes('*/')) {
        inBlockComment = false
        line = trimmed.slice(trimmed.indexOf('*/') + 2)
      }
      else {
        return
      }
    }
    if (line.trim().startsWith('/*')) {
      if (!line.includes('*/')) {
        inBlockComment = true
        return
      }
      line = line.slice(line.indexOf('*/') + 2)
    }
    line = stripInlineComments(line)
    if (!line.trim()) {
      return
    }
    const strings = collectStringContents(line).join('\n')
    const hits = [
      ...FORBIDDEN.filter(word => line.includes(word)),
      ...(stringExempt ? [] : FORBIDDEN_IN_STRING.filter(word => strings.includes(word))),
    ]
    for (const word of hits) {
      findings.push({
        file: relativePath,
        line: index + 1,
        word,
        text: rawLine.trim().slice(0, 100),
      })
    }
  })
}

if (findings.length > 0) {
  console.error('界面文案里出现了实现细节，请改成用户能看懂、能据此行动的说法：')
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  「${f.word}」  ${f.text}`)
  }
  console.error(`\n共 ${findings.length} 处。若确实需要保留（例如代码常量），请把它移出文案或调整本脚本的白名单。`)
  process.exit(1)
}

console.log('界面文案检查通过：未发现实现细节词汇。')
