import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface ContentTree { files: string[], sizeBytes: number, fileCount: number, sha256: string }

/** 每个 modinfo.lua 的父目录是一项内容；嵌套根会重复包含文件，不能猜测归属。 */
export function findModDirectories(files: string[]): string[] {
  const directories = files.filter(file => path.posix.basename(file) === 'modinfo.lua').map(file => path.posix.dirname(file))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  if (!directories.length) throw new Error('ZIP 中未找到 Mod，请确认各 Mod 目录中包含 modinfo.lua')
  const roots = new Set(directories)
  for (const child of directories) {
    let parent = child
    while (parent !== '.') {
      parent = path.posix.dirname(parent)
      if (roots.has(parent)) throw new Error(`Mod 目录存在嵌套冲突：${parent} 与 ${child}，请分别打包各 Mod 目录`)
    }
  }
  return directories
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** 只允许真实目录和普通文件；文件字节流式读取，排序仅占条目数级内存。 */
export async function inspectContentTree(root: string, options: { requireModInfo?: boolean, maxBytes?: number, maxEntries?: number, maxDepth?: number, ignoreSteamArchives?: boolean } = {}): Promise<ContentTree> {
  if (!fs.lstatSync(root).isDirectory()) throw new Error('内容来源必须为真实目录')
  const files: string[] = []
  let sizeBytes = 0
  let entries = 0
  const walk = (dir: string, depth: number) => {
    if (depth > (options.maxDepth ?? 32)) throw new Error('内容目录深度超过上限')
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.gsh-legacy-copy.json') continue
      if (options.ignoreSteamArchives && depth === 0 && /^\d+_legacy\.bin$/.test(entry.name)) continue
      if (entry.name.includes('\\') || /^[A-Za-z]:/.test(entry.name)) throw new Error('内容含非法文件名')
      if (++entries > (options.maxEntries ?? 100_000)) throw new Error('内容条目数超过上限')
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile()) {
        sizeBytes += fs.statSync(full).size
        if (sizeBytes > (options.maxBytes ?? 4 * 1024 ** 3)) throw new Error('内容大小超过上限')
        files.push(path.relative(root, full).split(path.sep).join('/'))
      }
      else throw new Error(`内容不允许链接或特殊文件: ${entry.name}`)
    }
  }
  walk(root, 0)
  if (options.requireModInfo && (!files.includes('modinfo.lua') || fs.statSync(path.join(root, 'modinfo.lua')).size === 0)) {
    throw new Error('Mod 内容缺少有效的 modinfo.lua')
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  const hashes: Array<[string, number, string]> = []
  for (const file of files) {
    const full = path.join(root, file)
    hashes.push([file, fs.statSync(full).size, await sha256File(full)])
  }
  return { files, sizeBytes, fileCount: files.length, sha256: createHash('sha256').update(JSON.stringify(hashes)).digest('hex') }
}

export function assertFreeSpace(directory: string, requiredBytes: number): void {
  const stat = fs.statfsSync(directory)
  if (stat.bavail * stat.bsize < requiredBytes + 64 * 1024 ** 2) throw new Error('磁盘剩余空间不足，请清理后重试')
}

export function assertWorkshopId(id: string): void {
  if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error('Workshop ID 必须为正整数字符串')
}
