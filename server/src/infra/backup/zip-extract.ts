import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { ArchiveEntries, type ArchiveExtractLimits } from './archive-entries'

export type ZipExtractLimits = ArchiveExtractLimits
export const DEFAULT_ZIP_EXTRACT_LIMITS: ZipExtractLimits = {
  maxEntries: 100_000,
  maxTotalUncompressedBytes: 4 * 1024 * 1024 * 1024,
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

/** 流式逐条目解压；失败时先关闭所有流，调用方再清理 staging。 */
export async function extractZipArchive(zipPath: string, targetDir: string, limits: ZipExtractLimits = DEFAULT_ZIP_EXTRACT_LIMITS): Promise<void> {
  fs.mkdirSync(targetDir, { recursive: true })
  const entries = new ArchiveEntries(targetDir, limits)
  // 兼容旧 Mod 包的反斜杠分隔符；yauzl 先转为 /，再由自身与 ArchiveEntries 校验路径。
  const zip = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false, strictFileNames: false })
  let streamedBytes = 0
  try {
    while (true) {
      const entry = await new Promise<yauzl.Entry | null>((resolve, reject) => {
        const cleanup = () => { zip.off('entry', onEntry); zip.off('end', onEnd); zip.off('error', onError) }
        const onEntry = (value: yauzl.Entry) => { cleanup(); resolve(value) }
        const onEnd = () => { cleanup(); resolve(null) }
        const onError = (error: Error) => { cleanup(); reject(error) }
        zip.once('entry', onEntry).once('end', onEnd).once('error', onError)
        zip.readEntry()
      })
      if (!entry) {
        break
      }
      const directory = entry.fileName.endsWith('/')
      const type = (entry.externalFileAttributes >>> 16) & 0xf000
      if (type && type !== (directory ? 0x4000 : 0x8000)) {
        throw new Error('压缩包不允许符号链接或特殊文件')
      }
      if (entry.generalPurposeBitFlag & 1) {
        throw new Error('不支持加密 ZIP')
      }
      const target = entries.accept(entry.fileName, directory, entry.uncompressedSize)
      if (directory) {
        fs.mkdirSync(target, { recursive: true, mode: 0o755 })
        continue
      }
      let crc = 0xffffffff
      let bytes = 0
      const check = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          streamedBytes += chunk.length
          bytes += chunk.length
          if (streamedBytes > limits.maxTotalUncompressedBytes || bytes > entry.uncompressedSize) {
            callback(new Error('解压后总大小超过上限'))
            return
          }
          for (const byte of chunk) {
            crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!
          }
          callback(null, chunk)
        },
      })
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 })
      await pipeline(await zip.openReadStreamPromise(entry), check, fs.createWriteStream(target, { flags: 'wx', mode: 0o644 }))
      if (bytes !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) {
        throw new Error(`ZIP 文件校验失败: ${entry.fileName}`)
      }
    }
  }
  finally {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { zip.off('close', onClose); zip.off('error', onError) }
      const onClose = () => { cleanup(); resolve() }
      const onError = (error: Error) => { cleanup(); reject(error) }
      zip.once('close', onClose).once('error', onError)
      zip.close()
    })
  }
}
