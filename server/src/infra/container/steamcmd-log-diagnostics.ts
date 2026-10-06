import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type Docker from 'dockerode'
import tar from 'tar-stream'

export const STEAMCMD_LOG_FILES = ['content_log.txt', 'stderr.txt'] as const
const MAX_TAIL_BYTES = 64 * 1024
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
const COLLECTION_TIMEOUT_MS = 5000

export function steamcmdLogDirectory(line: string): string | undefined {
  const value = /Logging directory:\s*['"]?(.+?)['"]?$/.exec(line)?.[1]
    ?? /Redirecting stderr to ['"](.+)\/stderr\.txt['"]/.exec(line)?.[1]
  return value && path.isAbsolute(value) ? value : undefined
}

function tailLines(bytes: Buffer): string[] {
  return bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).slice(-80)
}

function appendTail(previous: Buffer, chunk: Buffer): Buffer {
  return Buffer.from(Buffer.concat([previous, chunk]).subarray(-MAX_TAIL_BYTES))
}

/** 只向现有任务日志追加，诊断读取失败不改变任务的原始结果。 */
export async function collectDockerSteamcmdDiagnostics(
  container: Docker.Container,
  directory: string | undefined,
  emit: (line: string) => void,
): Promise<void> {
  if (!directory) {
    emit('[SteamCMD 诊断] 未识别到日志目录')
    return
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), COLLECTION_TIMEOUT_MS)
  let totalBytes = 0
  try {
    for (const name of STEAMCMD_LOG_FILES) {
      if (controller.signal.aborted) break
      let archive: NodeJS.ReadableStream | undefined
      const abort = () => (archive as { destroy?: () => void } | undefined)?.destroy?.()
      controller.signal.addEventListener('abort', abort, { once: true })
      try {
        // getArchive 本身也可能卡住；晚到的流仍须销毁。
        archive = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
          const onAbort = () => reject(new Error('诊断采集超时'))
          controller.signal.addEventListener('abort', onAbort, { once: true })
          void container.getArchive({ path: path.posix.join(directory, name) }).then(stream => {
            controller.signal.removeEventListener('abort', onAbort)
            if (controller.signal.aborted) {
              ;(stream as unknown as { destroy?: () => void }).destroy?.()
              reject(new Error('诊断采集超时'))
            }
            else resolve(stream)
          }, error => {
            controller.signal.removeEventListener('abort', onAbort)
            reject(error)
          })
        })
        const extract = tar.extract()
        let tail: Buffer = Buffer.alloc(0)
        let found = false
        extract.on('entry', (header, stream, next) => {
          void (async () => {
            // 不解包落盘，不跟随链接，不读取归档中的其他文件。
            const accepted = header.type === 'file' && header.name.replace(/^\.\//, '') === name
            if (accepted) found = true
            for await (const chunk of stream) {
              if (accepted) tail = appendTail(tail, Buffer.from(chunk))
            }
            next()
          })().catch(error => extract.destroy(error))
        })
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            totalBytes += chunk.length
            callback(totalBytes > MAX_ARCHIVE_BYTES ? new Error('诊断归档超过 8 MiB 上限') : null, chunk)
          },
        })
        await pipeline(archive as NodeJS.ReadableStream, counter, extract, { signal: controller.signal })
        if (!found) throw new Error('归档中没有指定的普通文件')
        emit(`[SteamCMD 诊断] ${name}（最多 64 KiB / 80 行）`)
        for (const line of tailLines(tail)) emit(line)
      }
      catch (error) {
        emit(`[SteamCMD 诊断] ${name} 未采集：${error instanceof Error ? error.message : String(error)}`)
      }
      finally {
        controller.signal.removeEventListener('abort', abort)
        ;(archive as { destroy?: () => void } | undefined)?.destroy?.()
      }
    }
    if (controller.signal.aborted) emit('[SteamCMD 诊断] 已达到 5 秒采集上限')
  }
  finally {
    clearTimeout(timer)
  }
}

interface LogPosition { size: number, ino: number, dev: number, head: Buffer }

/** Native 日志跨任务累积：保存启动前偏移，仅读取本次新增内容。 */
export class NativeSteamcmdLogDiagnostics {
  private positions = new Map<string, LogPosition | undefined>()
  private directory?: string
  private startedAt = Date.now()

  constructor(steamcmdPath: string) {
    const home = process.env.HOME || os.homedir()
    for (const directory of [
      path.join(home, 'Steam', 'logs'), path.join(home, '.steam', 'steam', 'logs'),
      path.join(home, '.local', 'share', 'Steam', 'logs'), path.join(path.dirname(steamcmdPath), 'logs'),
    ]) this.snapshot(directory)
  }

  private snapshot(directory: string): void {
    for (const name of STEAMCMD_LOG_FILES) {
      const file = path.join(directory, name)
      if (this.positions.has(file)) continue
      try {
        const stat = fs.lstatSync(file)
        if (!stat.isFile()) continue
        const head = Buffer.alloc(Math.min(stat.size, 64))
        const fd = fs.openSync(file, 'r')
        try { fs.readSync(fd, head, 0, head.length, 0) } finally { fs.closeSync(fd) }
        this.positions.set(file, { size: stat.size, ino: stat.ino, dev: stat.dev, head })
      }
      catch { this.positions.set(file, undefined) }
    }
  }

  observe(line: string): void {
    const directory = steamcmdLogDirectory(line)
    if (!directory) return
    this.directory = directory
    // 对非标准日志目录，声明时记录旧文件偏移；新文件属于本次任务。
    for (const name of STEAMCMD_LOG_FILES) {
      const file = path.join(directory, name)
      if (this.positions.has(file)) continue
      try {
        if (fs.lstatSync(file).birthtimeMs < this.startedAt) this.snapshot(directory)
        else this.positions.set(file, undefined)
      }
      catch { this.positions.set(file, undefined) }
    }
  }

  collect(emit: (line: string) => void): void {
    if (!this.directory) {
      emit('[SteamCMD 诊断] 未识别到日志目录')
      return
    }
    for (const name of STEAMCMD_LOG_FILES) {
      const file = path.join(this.directory, name)
      try {
        const stat = fs.lstatSync(file)
        if (!stat.isFile()) throw new Error('不是普通日志文件')
        const previous = this.positions.get(file)
        const fd = fs.openSync(file, 'r')
        let tail: Buffer
        try {
          const head = Buffer.alloc(previous?.head.length ?? 0)
          fs.readSync(fd, head, 0, head.length, 0)
          const appended = previous && previous.ino === stat.ino && previous.dev === stat.dev
            && previous.size <= stat.size && head.equals(previous.head)
          const offset = appended ? previous.size : 0
          const start = Math.max(offset, stat.size - MAX_TAIL_BYTES)
          tail = Buffer.alloc(stat.size - start)
          const bytes = fs.readSync(fd, tail, 0, tail.length, start)
          tail = tail.subarray(0, bytes)
        }
        finally { fs.closeSync(fd) }
        emit(`[SteamCMD 诊断] ${name}（本次任务，最多 64 KiB / 80 行）`)
        for (const line of tailLines(tail)) emit(line)
      }
      catch (error) {
        emit(`[SteamCMD 诊断] ${name} 未采集：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
