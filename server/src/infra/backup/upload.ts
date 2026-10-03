import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { extractArchive } from './archive'
import { DEFAULT_ZIP_EXTRACT_LIMITS, extractZipArchive } from './zip-extract'
import type { ZipExtractLimits } from './zip-extract'

/** 上传存档包默认大小上限：2GB（DST 集群档 zip 通常几十~几百 MB） */
const DEFAULT_UPLOAD_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
/** 上传记录过期时间：超时未完成导入的临时目录被顺手清理 */
const UPLOAD_STALE_MS = 24 * 60 * 60 * 1000
/** uploadId 为服务端 randomUUID，固定格式防路径穿越 */
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 上传存档包临时根目录：默认系统临时目录，测试与特殊部署可用 env 覆盖 */
export function resolveSaveImportUploadRoot(): string {
  const base = process.env.GSH_SAVE_IMPORT_ROOT?.trim()
  return path.resolve(base || path.join(os.tmpdir(), 'gsh-save-import'))
}

/** 上传大小上限（env 可覆盖，便于测试与小内存部署收紧） */
export function resolveMaxUploadBytes(): number {
  const parsed = Number(process.env.GSH_SAVE_IMPORT_MAX_UPLOAD_BYTES)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_UPLOAD_LIMIT_BYTES
}

export function resolveUploadDirectory(uploadId: string): string {
  return path.join(resolveSaveImportUploadRoot(), uploadId)
}

export function resolveUploadExtractRoot(uploadId: string): string {
  return path.join(resolveUploadDirectory(uploadId), 'extract')
}

export function createUploadDirectory(root = resolveSaveImportUploadRoot()): { uploadId: string, uploadDir: string } {
  const uploadId = randomUUID()
  const uploadDir = path.join(root, uploadId)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  fs.mkdirSync(uploadDir, { mode: 0o700 })
  return { uploadId, uploadDir }
}

/** 成功导入后清理上传记录；失败/过期场景由 TTL 清理兜底 */
export function removeUploadDirectory(uploadId: string): void {
  try {
    fs.rmSync(resolveUploadDirectory(uploadId), { recursive: true, force: true, maxRetries: 1 })
  }
  catch {
    // best-effort
  }
}

/** 清扫过期上传记录（进程长期运行、用户上传后放弃导入时兜底），风格同 staging 残留清扫 */
export function cleanStaleSaveImportUploads(maxAgeMs: number = UPLOAD_STALE_MS, root: string = resolveSaveImportUploadRoot(), retained: ReadonlySet<string> = new Set()): void {
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || retained.has(entry.name)) {
        continue
      }
      const dir = path.join(root, entry.name)
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > maxAgeMs) {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 1 })
        }
      }
      catch {
        // best-effort
      }
    }
  }
  catch {
    // best-effort
  }
}

export interface ReceiveUploadResult {
  ok: boolean
  uploadId?: string
  filePath?: string
  bytes?: number
  error?: string
  tooLarge?: boolean
}

/**
 * 将上传的原始请求体流式落盘到新建上传目录的 upload.bin。
 * 逐块计数，超过 maxBytes 立即中止并清理；任何失败都返回结果对象而非抛错，
 * 便于路由层统一控制 HTTP 状态码（content-type parser 抛错会被 Fastify 吞成通用错误）。
 */
export async function receiveUploadToTempFile(payload: Readable, maxBytes: number, root?: string): Promise<ReceiveUploadResult> {
  const { uploadId, uploadDir } = createUploadDirectory(root)
  const filePath = path.join(uploadDir, 'upload.bin')
  let received = 0
  let tooLarge = false
  try {
    await pipeline(payload, new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        if (received > maxBytes) {
          tooLarge = true
          callback(new Error(`上传包超过大小上限（${Math.floor(maxBytes / 1024 / 1024)} MB）`))
          return
        }
        callback(null, chunk)
      },
    }), fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 }))
    return { ok: true, uploadId, filePath, bytes: received }
  }
  catch (error) {
    fs.rmSync(uploadDir, { recursive: true, force: true, maxRetries: 1 })
    return { ok: false, tooLarge, error: error instanceof Error ? error.message : '上传失败' }
  }
}

export type UploadArchiveFormat = 'zip' | 'targz'

/** 按文件头魔数识别压缩包格式，不信任 Content-Type */
export function detectArchiveFormat(filePath: string): UploadArchiveFormat | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r')
    const header = Buffer.alloc(4)
    const read = fs.readSync(fd, header, 0, 4, 0)
    if (read >= 4 && header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04) {
      return 'zip'
    }
    if (read >= 2 && header[0] === 0x1f && header[1] === 0x8b) {
      return 'targz'
    }
    return null
  }
  catch {
    return null
  }
  finally {
    if (fd !== undefined) {
      fs.closeSync(fd)
    }
  }
}

/** 识别格式并解压到 extractDir：zip 走流式解压，tar.gz 复用备份恢复的 tar 解包（支持面板备份包直接再导入） */
export async function unpackSaveImportArchive(archivePath: string, extractDir: string, limits: ZipExtractLimits = DEFAULT_ZIP_EXTRACT_LIMITS): Promise<UploadArchiveFormat> {
  const format = detectArchiveFormat(archivePath)
  if (format === 'zip') {
    await extractZipArchive(archivePath, extractDir, limits)
    return format
  }
  if (format === 'targz') {
    // 与 zip 分支共用同一套上限：此前 tar.gz 分支丢弃 limits，解压炸弹可写满宿主机磁盘
    await extractArchive(archivePath, extractDir, {
      maxEntries: limits.maxEntries,
      maxTotalUncompressedBytes: limits.maxTotalUncompressedBytes,
      maxDepth: limits.maxDepth,
    })
    return format
  }
  throw new Error('存档包格式无法识别，仅支持 zip 压缩包或面板备份包')
}

/** 上传时记录原始文件名（仅用于展示与安全备份备注，不参与磁盘命名） */
export function writeUploadMeta(uploadDir: string, sourceName: string): void {
  try {
    fs.writeFileSync(path.join(uploadDir, 'meta.json'), JSON.stringify({ sourceName }), 'utf8')
  }
  catch {
    // best-effort：缺失时导入备注回退为集群目录名
  }
}

export function readUploadSourceName(uploadDir: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(uploadDir, 'meta.json'), 'utf8')) as { sourceName?: unknown }
    return typeof parsed.sourceName === 'string' && parsed.sourceName.trim() ? parsed.sourceName : undefined
  }
  catch {
    return undefined
  }
}

/**
 * 校验导入请求的 uploadId 与源集群路径：
 * uploadId 必须为服务端签发的 UUID，路径必须落在对应解压根内且含 cluster.ini（防路径穿越）。
 */
export function validateUploadClusterPath(uploadId: string, rawClusterPath: string): { ok: true, clusterPath: string } | { ok: false, message: string } {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    return { ok: false, message: '上传记录无效，请重新上传存档包' }
  }
  const extractRoot = resolveUploadExtractRoot(uploadId)
  const clusterPath = path.resolve(rawClusterPath)
  if (clusterPath !== extractRoot && !clusterPath.startsWith(extractRoot + path.sep)) {
    return { ok: false, message: '源存档路径与上传记录不匹配，请重新上传存档包' }
  }
  if (!fs.existsSync(clusterPath) || !fs.statSync(clusterPath).isDirectory()) {
    return { ok: false, message: '上传记录不存在或已清理，请重新上传存档包' }
  }
  if (!fs.existsSync(path.join(clusterPath, 'cluster.ini'))) {
    return { ok: false, message: '这不是有效的存档目录（缺少房间配置文件）' }
  }
  return { ok: true, clusterPath }
}

/** 上传文件名仅用于展示与安全备份备注：basename 化、剥离危险字符并限长 */
export function sanitizeUploadFileName(raw: string | undefined): string {
  const base = path.basename((raw ?? '').trim()).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').slice(0, 200).trim()
  return base || '存档包'
}
