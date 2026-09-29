#!/usr/bin/env node
// 文档一致性校验：相对链接、锚点、版本 tag 与「公开仓库里是否真的存在」。
// 用法：node scripts/check-docs.mjs（也通过 pnpm run docs:check 调用）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const docsDir = path.join(repoRoot, 'docs')

const rootDocs = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md']
const docsFiles = fs.readdirSync(docsDir).filter(f => f.endsWith('.md')).map(f => `docs/${f}`)
const targets = [...rootDocs, ...docsFiles].filter(f => fs.existsSync(path.join(repoRoot, f)))

const failures = []

// GitHub 风格的标题锚点：小写、去掉标点、空格转连字符。
const slugify = heading => heading.trim().replace(/`/g, '').toLowerCase().replace(/[^\p{L}\p{N}\-_ ]/gu, '').replace(/ /g, '-')

/**
 * 版本控制中被跟踪的文件清单。
 *
 * 为什么需要它：文档校验读的是工作区文件，本地存在即通过。但 docs/ 下有一批文件被
 * .gitignore 排除（白名单外的路径都留在本地），公开仓库里根本没有，用户点进去全是 404，
 * 而本地怎么跑都发现不了。
 *
 * 判定口径是「能否进入公开仓库」，而不是「此刻是否已提交」：已跟踪 + 未跟踪但未被忽略
 * 都算可发布（后者是待提交的新文件），只有被 .gitignore 命中的才是必然的死链。
 * git 不可用时返回 null，跳过该项检查而不是误报。
 */
/** 执行一次 git 并把输出写入临时文件：不接 stdout 管道，与仓库其它脚本保持同一执行方式 */
function runGitToFile(args) {
  const listPath = path.join(os.tmpdir(), `gsh-docs-git-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const fd = fs.openSync(listPath, 'w')
  return new Promise((resolve) => {
    const cleanup = () => {
      try {
        fs.closeSync(fd)
      }
      catch {
        // 已关闭
      }
      fs.rmSync(listPath, { force: true })
    }
    const child = spawn('git', args, { cwd: repoRoot, stdio: ['ignore', fd, 'ignore'], windowsHide: true })
    child.on('error', () => {
      cleanup()
      resolve(null)
    })
    child.on('close', (code) => {
      try {
        if (code !== 0) {
          resolve(null)
          return
        }
        resolve(new Set(fs.readFileSync(listPath, 'utf8').split('\0').filter(Boolean)))
      }
      catch {
        resolve(null)
      }
      finally {
        cleanup()
      }
    })
  })
}

function isPublishableTarget(publishable, relativePath) {
  if (publishable.has(relativePath)) {
    return true
  }
  const prefix = relativePath.endsWith('/') ? relativePath : `${relativePath}/`
  for (const item of publishable) {
    if (item.startsWith(prefix)) {
      return true
    }
  }
  return false
}

async function listPublishableFiles() {
  const tracked = await runGitToFile(['ls-files', '-z'])
  const untracked = await runGitToFile(['ls-files', '-z', '--others', '--exclude-standard'])
  if (!tracked || !untracked) {
    return null
  }
  return new Set([...tracked, ...untracked])
}

const publishableFiles = await listPublishableFiles()
if (!publishableFiles) {
  // 静默跳过会让这类死链重新溜进公开仓库，必须让跳过本身可见
  console.warn('提示：无法读取 git 文件清单，已跳过「链接目标是否会随仓库发布」检查')
}

const anchorCache = new Map()
function anchorsFor(file) {
  if (!anchorCache.has(file)) {
    const set = new Set()
    for (const line of fs.readFileSync(path.join(repoRoot, file), 'utf8').split(/\r?\n/)) {
      const m = /^(#{1,6})\s+(.*)$/.exec(line)
      if (m) set.add(slugify(m[2]))
    }
    anchorCache.set(file, set)
  }
  return anchorCache.get(file)
}

// 1) 相对链接与锚点
const linkRe = /\]\(([^)\s]+)\)/g
const imgRe = /<img[^>]*src="([^"]+)"/g
for (const file of targets) {
  const lines = fs.readFileSync(path.join(repoRoot, file), 'utf8').split(/\r?\n/)
  const dir = path.posix.dirname(file)
  let inFence = false
  lines.forEach((rawLine, i) => {
    if (/^\s*```/.test(rawLine)) { inFence = !inFence; return }
    if (inFence) return
    // 行内代码中的链接不会被渲染，先剥离再校验
    const line = rawLine.replace(/`[^`]*`/g, '`code`')
    for (const m of [...line.matchAll(linkRe), ...line.matchAll(imgRe)]) {
      const raw = m[1]
      if (/^(https?:|mailto:|#)/.test(raw)) continue
      const [p, ...rest] = raw.split('#')
      const anchor = rest.join('#')
      const rel = p.startsWith('/') ? p.slice(1) : path.posix.normalize(path.posix.join(dir, p))
      if (!fs.existsSync(path.join(repoRoot, rel))) {
        failures.push(`${file}:${i + 1} 链接目标不存在：${raw}`)
        continue
      }
      if (publishableFiles && publishableFiles.has(file) && !isPublishableTarget(publishableFiles, rel)) {
        failures.push(`${file}:${i + 1} 链接目标被 .gitignore 排除（公开仓库中会是死链）：${raw}`)
      }
      if (anchor && rel.endsWith('.md') && !anchorsFor(rel).has(anchor)) {
        failures.push(`${file}:${i + 1} 锚点不存在：${raw}`)
      }
    }
  })
}

// 2) 版本 tag 与 package.json 一致（安装 URL、jsDelivr、Release 链接、git clone --branch）
const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version
const tag = `v${version}`
const tagRe = /(?:raw\.githubusercontent\.com\/[^\s"')]+\/|jsdelivr\.net\/gh\/[^@\s"')]+@|releases\/tag\/|--branch )(v\d+\.\d+\.\d+)/g
for (const file of targets) {
  for (const m of fs.readFileSync(path.join(repoRoot, file), 'utf8').matchAll(tagRe)) {
    if (m[1] !== tag) failures.push(`${file}: 版本 tag ${m[1]} 与 package.json 的 ${tag} 不一致`)
  }
}

if (failures.length > 0) {
  console.error('文档校验失败：')
  for (const f of failures) console.error(` - ${f}`)
  process.exit(1)
}
console.log(`文档校验通过：${targets.length} 篇文档，链接、锚点与版本 tag 均一致。`)
