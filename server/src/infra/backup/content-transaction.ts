import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../game-adapter/dst/atomic-write'

interface Replacement { target: string, prepared: string | null, backup: string, existed: boolean }
interface Journal<T> { version: 1, state: 'pending' | 'committed', snapshot: T, replacements: Replacement[] }
export const CONTENT_TRANSACTION_DIRECTORY = '.gsh-content-transaction'

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const fd = fs.openSync(directory, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

/** 所有路径留在安装目录内；旧内容保留到 DB 和配置成功提交。 */
export class ContentTransaction<T> {
  readonly root: string
  private journal: Journal<T>
  private installPath: string
  constructor(installPath: string, snapshot: T) {
    this.installPath = installPath
    this.root = path.join(installPath, CONTENT_TRANSACTION_DIRECTORY)
    if (exists(this.root)) throw new Error('实例存在未恢复的内容事务，请先重启面板恢复')
    fs.mkdirSync(this.root, { mode: 0o700 })
    this.journal = { version: 1, state: 'pending', snapshot, replacements: [] }
    this.save()
  }
  private save() {
    const file = path.join(this.root, 'journal.json')
    writeFileAtomic(file, JSON.stringify(this.journal))
    const fd = fs.openSync(file, 'r+')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    syncDirectory(this.root)
    syncDirectory(this.installPath)
  }
  private relative(target: string): string {
    const rel = path.relative(this.installPath, target)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('内容事务路径越界')
    let parent = path.dirname(target)
    while (parent !== this.installPath) {
      if (exists(parent) && fs.lstatSync(parent).isSymbolicLink()) throw new Error('内容事务目标父目录含链接')
      parent = path.dirname(parent)
    }
    return rel
  }
  async prepareDirectory(source: string, target: string): Promise<string> {
    const prepared = path.join(this.root, `prepared-${randomUUID()}`)
    await fs.promises.cp(source, prepared, { recursive: true, dereference: false, preserveTimestamps: true })
    this.add(target, prepared)
    return prepared
  }
  prepareLink(source: string, target: string): void {
    const prepared = path.join(this.root, `prepared-${randomUUID()}`)
    fs.symlinkSync(path.relative(path.dirname(target), source), prepared, 'dir')
    this.add(target, prepared)
  }
  remove(target: string): void { this.add(target, null) }
  private add(target: string, prepared: string | null) {
    this.journal.replacements.push({ target: this.relative(target), prepared: prepared ? this.relative(prepared) : null, backup: this.relative(path.join(this.root, `old-${this.journal.replacements.length}`)), existed: exists(target) })
    this.save()
  }
  /** 为接下来由现有 writer 修改的单个配置文件保留快照。 */
  protect(target: string): void {
    if (this.journal.replacements.some(item => item.target === this.relative(target))) return
    const backup = path.join(this.root, `old-${this.journal.replacements.length}`)
    const existed = exists(target)
    if (existed) fs.cpSync(target, backup, { recursive: true, dereference: false })
    this.journal.replacements.push({ target: this.relative(target), prepared: null, backup: this.relative(backup), existed })
    this.save()
  }
  apply(): void {
    for (const item of this.journal.replacements) {
      const target = path.join(this.installPath, item.target)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      if (exists(target)) fs.renameSync(target, path.join(this.installPath, item.backup))
      if (item.prepared) fs.renameSync(path.join(this.installPath, item.prepared), target)
      syncDirectory(path.dirname(target))
      syncDirectory(this.root)
    }
  }
  commit(): void {
    this.journal.state = 'committed'
    this.save()
    // 提交标记持久化后清理失败不再触发回滚，重启时继续清理。
    try { fs.rmSync(this.root, { recursive: true, force: true }) } catch { /* committed journal retained */ }
  }
  rollback(restore: (snapshot: T) => void): void { recoverContentTransaction(this.installPath, restore) }
}

export function recoverContentTransaction<T>(installPath: string, restore: (snapshot: T) => void): boolean {
  const root = path.join(installPath, CONTENT_TRANSACTION_DIRECTORY)
  if (!exists(root)) return false
  const journal = JSON.parse(fs.readFileSync(path.join(root, 'journal.json'), 'utf8')) as Journal<T>
  if (journal.version !== 1 || !Array.isArray(journal.replacements) || !['pending', 'committed'].includes(journal.state)) throw new Error('内容事务日志损坏')
  const resolve = (rel: string) => {
    const result = path.resolve(installPath, rel)
    if (!result.startsWith(path.resolve(installPath) + path.sep)) throw new Error('事务恢复路径越界')
    return result
  }
  if (journal.state === 'pending') {
    for (const item of [...journal.replacements].reverse()) {
      const target = resolve(item.target)
      const backup = resolve(item.backup)
      if (exists(backup)) {
        fs.rmSync(target, { recursive: true, force: true })
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.renameSync(backup, target)
      }
      else if (!item.existed && (!item.prepared || !exists(resolve(item.prepared)))) {
        fs.rmSync(target, { recursive: true, force: true })
      }
    }
    restore(journal.snapshot)
  }
  fs.rmSync(root, { recursive: true, force: true })
  return true
}
