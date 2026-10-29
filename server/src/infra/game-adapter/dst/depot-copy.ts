import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ensureDstLegacyModLink, resolveDstUgcModDir } from './ugc-mod-install'

/** 实例存档与房间配置，seed 复制时必须隔离 */
const EXCLUDED_TOP_LEVEL = new Set(['klei-storage'])
const STEAMAPPS_EXCLUDED_TOP_LEVEL = new Set(['downloading', 'temp', 'sourcemods'])

export type CopyGameDepotResult = { ok: true } | { ok: false, error: string }

export function installPathsOverlap(first: string, second: string): boolean {
  const a = path.resolve(first)
  const b = path.resolve(second)
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)
}

/** 安装使用流式复制；取消后 pipeline 关闭两个流，不再写入目标目录。 */
export async function copyGameDepotFromDonorAsync(donorPath: string, recipientPath: string, options: {
  signal?: AbortSignal
  onProgress?: (copiedBytes: number, totalBytes: number) => void
} = {}): Promise<CopyGameDepotResult> {
  try {
    options.signal?.throwIfAborted()
    if (installPathsOverlap(donorPath, recipientPath)) throw new Error('复制源与目标安装目录不能相同或互相包含')
    const source = await fs.promises.realpath(donorPath)
    // 在创建目标目录前检查最近的既有父目录，避免链接或重叠路径修改复制源。
    let existing = path.resolve(recipientPath)
    const missing: string[] = []
    while (true) {
      try { existing = await fs.promises.realpath(existing); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        missing.unshift(path.basename(existing))
        existing = path.dirname(existing)
      }
    }
    if (installPathsOverlap(source, path.join(existing, ...missing))) throw new Error('复制源与目标安装目录不能相同或互相包含')
    await fs.promises.mkdir(recipientPath, { recursive: true })
    const target = await fs.promises.realpath(recipientPath)
    if (installPathsOverlap(source, target)) throw new Error('复制源与目标安装目录不能相同或互相包含')
    const files: Array<{ relative: string, size: number, mode: number }> = []
    const directories: string[] = []
    const modLinks: Array<{ workshopId: string, relativeTarget: string }> = []
    const walk = async (relative: string) => {
      options.signal?.throwIfAborted()
      for (const entry of await fs.promises.readdir(path.join(source, relative), { withFileTypes: true })) {
        if (!relative && EXCLUDED_TOP_LEVEL.has(entry.name)) continue
        if (relative === 'steamapps' && STEAMAPPS_EXCLUDED_TOP_LEVEL.has(entry.name)) continue
        const name = path.join(relative, entry.name)
        if (entry.isSymbolicLink()) {
          const workshopId = relative === 'mods' ? /^workshop-(\d+)$/.exec(entry.name)?.[1] : undefined
          if (!workshopId) throw new Error(`复制源包含符号链接: ${name}`)
          const linked = await fs.promises.realpath(path.join(source, name))
          // 只接受本实例同一 Mod 的标准 UGC 目录，不跟随链接扫描或读取存档。
          if (![resolveDstUgcModDir(source, 'Master', workshopId), resolveDstUgcModDir(source, 'Caves', workshopId)].includes(linked)
            || !(await fs.promises.stat(linked)).isDirectory()) {
            throw new Error(`复制源包含非托管或越界 Mod 链接: ${name}`)
          }
          modLinks.push({ workshopId, relativeTarget: path.relative(source, linked) })
          continue
        }
        if (entry.isDirectory()) {
          directories.push(name)
          await walk(name)
        }
        else if (entry.isFile()) {
          const stat = await fs.promises.stat(path.join(source, name))
          files.push({ relative: name, size: stat.size, mode: stat.mode })
        }
      }
    }
    await walk('')
    for (const directory of directories) {
      options.signal?.throwIfAborted()
      const destination = path.join(target, directory)
      await fs.promises.mkdir(destination, { recursive: true })
      const actual = await fs.promises.realpath(destination)
      if (actual !== target && !actual.startsWith(`${target}${path.sep}`)) throw new Error('目标目录包含越界符号链接')
    }
    const total = files.reduce((sum, file) => sum + file.size, 0)
    let copied = 0
    for (const file of files) {
      options.signal?.throwIfAborted()
      const destination = path.join(target, file.relative)
      await fs.promises.mkdir(path.dirname(destination), { recursive: true })
      // 目标不能通过已有链接指向用户存档或安装目录外部。
      const parent = await fs.promises.realpath(path.dirname(destination))
      if (parent !== target && !parent.startsWith(`${target}${path.sep}`)) throw new Error('目标目录包含越界符号链接')
      try {
        if ((await fs.promises.lstat(destination)).isSymbolicLink()) throw new Error('目标文件不能是符号链接')
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const input = fs.createReadStream(path.join(source, file.relative))
      input.on('data', chunk => {
        copied += chunk.length
        try { options.onProgress?.(copied, total) }
        catch (error) { input.destroy(error instanceof Error ? error : new Error(String(error))) }
      })
      await pipeline(input, fs.createWriteStream(destination, { mode: file.mode }), { signal: options.signal })
      await fs.promises.chmod(destination, file.mode)
    }
    for (const link of modLinks) {
      options.signal?.throwIfAborted()
      // 内容复制完成后，接入新实例自己的 UGC 目录，绝不能保留供体的绝对链接。
      ensureDstLegacyModLink(target, link.workshopId, path.join(target, link.relativeTarget))
    }
    options.onProgress?.(total, total)
    return { ok: true }
  }
  catch (error) {
    options.signal?.throwIfAborted()
    return { ok: false, error: `复制游戏文件失败: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function shouldCopySteamappsChild(sourcePath: string, steamappsRoot: string): boolean {
  const relative = path.relative(steamappsRoot, sourcePath)
  if (!relative || relative === '.') {
    return true
  }
  const topLevel = relative.split(path.sep)[0]
  return !STEAMAPPS_EXCLUDED_TOP_LEVEL.has(topLevel)
}

function copySteamappsDirectory(donorPath: string, recipientPath: string): void {
  const sourceRoot = path.join(donorPath, 'steamapps')
  const targetRoot = path.join(recipientPath, 'steamapps')
  if (!fs.existsSync(sourceRoot)) {
    return
  }
  fs.mkdirSync(targetRoot, { recursive: true })
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (STEAMAPPS_EXCLUDED_TOP_LEVEL.has(entry.name)) {
      continue
    }
    const sourceEntry = path.join(sourceRoot, entry.name)
    const targetEntry = path.join(targetRoot, entry.name)
    if (entry.isDirectory()) {
      fs.cpSync(sourceEntry, targetEntry, {
        recursive: true,
        force: true,
        filter: src => shouldCopySteamappsChild(src, sourceRoot),
      })
    }
    else {
      fs.copyFileSync(sourceEntry, targetEntry)
    }
  }
}

function copyTopLevelEntry(donorPath: string, recipientPath: string, entry: fs.Dirent): void {
  const sourceEntry = path.join(donorPath, entry.name)
  const targetEntry = path.join(recipientPath, entry.name)
  if (entry.name === 'steamapps') {
    copySteamappsDirectory(donorPath, recipientPath)
    return
  }
  if (entry.isDirectory()) {
    fs.cpSync(sourceEntry, targetEntry, { recursive: true, force: true })
    return
  }
  fs.copyFileSync(sourceEntry, targetEntry)
}

/**
 * 从 donor 复制游戏 depot 到 recipient（除 klei-storage 外完整 depot，不含存档）。
 */
export function copyGameDepotFromDonor(donorPath: string, recipientPath: string): CopyGameDepotResult {
  const normalizedDonor = path.resolve(donorPath.trim())
  const normalizedRecipient = path.resolve(recipientPath.trim())
  if (!normalizedDonor || !normalizedRecipient) {
    return { ok: false, error: '安装路径无效' }
  }
  if (normalizedDonor === normalizedRecipient) {
    return { ok: false, error: '供体与目标安装目录不能相同' }
  }
  if (!fs.existsSync(normalizedDonor)) {
    return { ok: false, error: '供体安装目录不存在' }
  }
  try {
    fs.mkdirSync(normalizedRecipient, { recursive: true })
    for (const entry of fs.readdirSync(normalizedDonor, { withFileTypes: true })) {
      if (EXCLUDED_TOP_LEVEL.has(entry.name)) {
        continue
      }
      copyTopLevelEntry(normalizedDonor, normalizedRecipient, entry)
    }
    return { ok: true }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `复制游戏文件失败: ${message}` }
  }
}
