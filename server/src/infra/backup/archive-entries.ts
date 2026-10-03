import fs from 'node:fs'
import path from 'node:path'

export interface ArchiveExtractLimits {
  maxEntries: number
  maxTotalUncompressedBytes: number
  maxDepth?: number
}

/** 宿主机无关的路径规则；隐式父目录也参与文件/目录冲突检查。 */
export class ArchiveEntries {
  private entries = new Set<string>()
  private kinds = new Map<string, boolean>()
  private bytes = 0
  private root: string
  private limits: ArchiveExtractLimits
  constructor(root: string, limits: ArchiveExtractLimits) { this.root = root; this.limits = limits }

  accept(raw: string, directory: boolean, size: number): string {
    if (raw.includes('\\') || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
      throw new Error(`压缩包内出现非法路径条目: ${raw}`)
    }
    const name = raw.replace(/^\.\//, '').replace(/\/$/, '')
    const parts = name.split('/')
    if (!name || parts.some(part => !part || part === '.' || part === '..')) {
      throw new Error(`压缩包内出现非法路径条目: ${raw}`)
    }
    if (parts.length > (this.limits.maxDepth ?? 32)) {
      throw new Error('压缩包目录深度超过上限')
    }
    if (this.entries.has(name)) {
      throw new Error(`压缩包条目重复: ${name}`)
    }
    if (this.entries.size >= this.limits.maxEntries) {
      throw new Error(`压缩包条目数超过上限（${this.limits.maxEntries}）`)
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error('压缩包文件大小无效')
    }
    this.bytes += size
    if (this.bytes > this.limits.maxTotalUncompressedBytes) {
      throw new Error('解压后总大小超过上限')
    }
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join('/')
      if (this.kinds.get(parent) === false) {
        throw new Error(`压缩包文件与目录冲突: ${parent}`)
      }
      this.kinds.set(parent, true)
    }
    if (this.kinds.has(name) && this.kinds.get(name) !== directory) {
      throw new Error(`压缩包文件与目录冲突: ${name}`)
    }
    this.entries.add(name)
    this.kinds.set(name, directory)
    const target = path.resolve(this.root, ...parts)
    if (!target.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error(`压缩包内出现非法路径条目: ${raw}`)
    }
    let current = path.resolve(this.root)
    for (const part of ['', ...parts]) {
      current = path.join(current, part)
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new Error('解压目录含符号链接')
        }
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
    return target
  }
}
