import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import tar from 'tar-stream'
import { ArchiveEntries, type ArchiveExtractLimits } from './archive-entries'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createGunzip } from 'node:zlib'

/**
 * 备份归档：系统 tar 打包，流式解析器安全解包 tar.gz。
 * - Linux（生产 Docker 镜像与 Native 宿主机）tar 为必备组件；
 * - Windows 10 1803+ 内置 bsdtar，覆盖开发与测试环境；
 * - 解包逐条校验普通文件和目录，不允许链接和特殊文件。
 */

function runTar(args: string[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: 'ignore', windowsHide: true })
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const cancel = () => {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    child.on('error', (error) => {
      reject(new Error(`tar 命令不可用: ${error.message}`))
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', cancel)
      if (killTimer) clearTimeout(killTimer)
      if (signal?.aborted) { reject(signal.reason); return }
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`tar 执行失败，退出码 ${code ?? 'unknown'}`))
    })
  })
}

/** 打包目录为 tar.gz，包内顶层目录名保持为源目录的 basename（恢复时可按顶层目录对齐） */
export async function createDirectoryArchive(sourceDir: string, targetPath: string, signal?: AbortSignal): Promise<void> {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`待备份目录不存在: ${sourceDir}`)
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  const parent = path.dirname(sourceDir)
  const base = path.basename(sourceDir)
  await runTar(['-czf', targetPath, '-C', parent, base], signal)
}

/** tar.gz 与 ZIP 共用路径、类型和资源限制。 */
export type TarExtractLimits = ArchiveExtractLimits
export const DEFAULT_TAR_EXTRACT_LIMITS: TarExtractLimits = {
  maxEntries: 100_000,
  maxTotalUncompressedBytes: 4 * 1024 * 1024 * 1024,
}

export async function createArchiveFromEntries(root: string, names: string[], targetPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  await runTar(['-czf', targetPath, '-C', root, '--', ...names])
}

/** 先流式体检，再逐条目落盘；不把不可信路径或类型交给系统 tar。 */
export async function extractArchive(archivePath: string, targetDir: string, limits: TarExtractLimits = DEFAULT_TAR_EXTRACT_LIMITS, validateOnly = false): Promise<void> {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`备份包不存在: ${archivePath}`)
  }
  const scan = async (write: boolean) => {
    const entries = new ArchiveEntries(targetDir, limits)
    const extract = tar.extract()
    let bytes = 0
    let entryCount = 0
    let rootSeen = false
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        // tar header/padding 也计入，避免无限 padding 或扩展头消耗资源。
        if (bytes > limits.maxTotalUncompressedBytes + limits.maxEntries * 1024 + 1024) {
          callback(new Error('解压后总大小超过上限'))
          return
        }
        callback(null, chunk)
      },
    })
    extract.on('entry', (header, stream, next) => {
      void (async () => {
        if (++entryCount > limits.maxEntries) throw new Error('压缩包条目数超过上限')
        if (header.type !== 'file' && header.type !== 'directory') {
          throw new Error('压缩包不允许链接或特殊文件')
        }
        if (header.type === 'directory' && (header.name === './' || header.name === '.')) {
          if (rootSeen || header.size) throw new Error('压缩包根目录条目重复或大小无效')
          rootSeen = true
          for await (const _chunk of stream) { /* drain before advancing */ }
          next()
          return
        }
        const directory = header.type === 'directory'
        const target = entries.accept(header.name, directory, header.size ?? 0)
        if (write && directory) {
          fs.mkdirSync(target, { recursive: true, mode: 0o755 })
        }
        if (write && !directory) {
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 })
          await pipeline(stream, fs.createWriteStream(target, { flags: 'wx', mode: 0o644 }))
        }
        else {
          for await (const _chunk of stream) { /* drain with backpressure */ }
        }
        next()
      })().catch(error => extract.destroy(error))
    })
    await pipeline(fs.createReadStream(archivePath), createGunzip(), counter, extract)
  }
  await scan(false)
  if (validateOnly) return
  fs.mkdirSync(targetDir, { recursive: true })
  await scan(true)
}

/**
 * 同卷原子替换目录（用于恢复时换入解包后的存档）：
 * 现目录先改名让位 → 新目录改名就位；就位失败回滚让位目录，成功后清理让位目录。
 * 调用方须保证 preparedDir 与 dirPath 在同一卷（同父目录下建 staging 可满足）。
 */
export function replaceDirectory(dirPath: string, preparedDir: string): void {
  const parent = path.dirname(dirPath)
  const displaced = path.join(parent, `.replaced-${path.basename(dirPath)}-${Date.now()}`)
  let displacedReady = false
  if (fs.existsSync(dirPath)) {
    fs.renameSync(dirPath, displaced)
    displacedReady = true
  }
  try {
    fs.renameSync(preparedDir, dirPath)
  }
  catch (error) {
    if (displacedReady) {
      fs.renameSync(displaced, dirPath)
    }
    throw error
  }
  if (displacedReady) {
    fs.rmSync(displaced, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
  }
}

/** 递归计算目录字节数（符号链接不跟随） */
export function getDirectorySizeBytes(dirPath: string): number {
  let total = 0
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      total += getDirectorySizeBytes(entryPath)
      continue
    }
    if (entry.isFile()) {
      total += fs.statSync(entryPath).size
    }
  }
  return total
}
