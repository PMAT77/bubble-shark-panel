import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { isEditableInstanceFilePath } from '../../../../../shared/contracts/instance-file'
import { backupFile, writeFileAtomic } from './atomic-write'
import { DST_CLUSTER_NAME, DST_CONF_DIR, DST_STORAGE_DIR } from './constants'

/** 文本文件读写上限：超过则拒绝读写，避免把面板内存当传输通道 */
export const INSTANCE_TEXT_FILE_MAX_BYTES = 1024 * 1024

/** 实例内文件上传上限：默认 256 MiB，可用 env 收紧（测试与小内存部署） */
export const INSTANCE_UPLOAD_DEFAULT_MAX_BYTES = 256 * 1024 * 1024

export function resolveInstanceUploadMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.BSP_INSTANCE_UPLOAD_MAX_BYTES)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : INSTANCE_UPLOAD_DEFAULT_MAX_BYTES
}

/**
 * 敏感文件：面板不通过文件接口提供内容，也不接受写入。
 * 集群令牌等于服务器控制权，房间页已经按「只回脱敏值」处理，这里保持一致。
 */
const PROTECTED_FILE_NAMES = new Set(['cluster_token.txt'])

export interface InstanceFileEntry {
  /** 相对实例目录的路径（API 与界面都用相对路径，不暴露宿主绝对路径） */
  path: string
  name: string
  type: 'file' | 'directory'
  sizeBytes: number
  /** 最后修改时间（ISO）；读不到为空串 */
  modifiedAt: string
  /** 敏感文件：可以列出，但不提供内容与写入 */
  protected: boolean
}

export type ResolveInstancePathResult =
  | { ok: true, absolutePath: string, relativePath: string }
  | { ok: false, message: string }

function toPosixRelative(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath)
  return relative.split(path.sep).join('/')
}

/**
 * 把界面传来的相对路径解析成实例目录内的绝对路径。
 *
 * 两道校验都不能省：字面路径要落在实例目录内（挡住 `..`），解析符号链接后的真实路径
 * 也要落在实例目录内（挡住实例目录里预先埋好的符号链接）。这与面板其它文件浏览入口同一策略。
 */
export function resolveInstancePath(
  instanceRoot: string,
  rawRelativePath: string,
  options?: { allowRoot?: boolean },
): ResolveInstancePathResult {
  const root = path.resolve(instanceRoot)
  const trimmed = (rawRelativePath ?? '').replace(/\\/g, '/').trim()
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) {
    return { ok: false, message: '只支持实例目录内的相对路径' }
  }
  const segments = trimmed.split('/').filter(segment => segment.length > 0)
  if (segments.some(segment => segment === '..')) {
    return { ok: false, message: '路径不能包含上级目录' }
  }
  if (segments.length === 0 && !options?.allowRoot) {
    return { ok: false, message: '请指定实例目录内的文件或目录' }
  }

  const absolutePath = segments.length === 0 ? root : path.resolve(root, ...segments)
  if (!isInside(absolutePath, root)) {
    return { ok: false, message: '路径超出实例目录范围' }
  }
  let realPath = absolutePath
  try {
    realPath = fs.realpathSync(absolutePath)
  }
  catch {
    // 目标还不存在（例如要新建文件）时退回字面路径
    realPath = absolutePath
  }
  let realRoot = root
  try {
    realRoot = fs.realpathSync(root)
  }
  catch {
    realRoot = root
  }
  if (!isInside(realPath, realRoot)) {
    return { ok: false, message: '路径超出实例目录范围' }
  }
  return { ok: true, absolutePath, relativePath: toPosixRelative(root, absolutePath) }
}

function isInside(targetPath: string, basePath: string): boolean {
  const relative = path.relative(basePath, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function isProtectedInstanceFile(relativePath: string): boolean {
  const base = path.posix.basename((relativePath ?? '').replace(/\\/g, '/')).toLowerCase()
  return PROTECTED_FILE_NAMES.has(base)
}

export function isEditableTextPath(relativePath: string): boolean {
  return isEditableInstanceFilePath(relativePath)
}

function readEntry(instanceRoot: string, absolutePath: string, name: string, isDirectory: boolean): InstanceFileEntry {
  let sizeBytes = 0
  let modifiedAt = ''
  try {
    const stat = fs.statSync(absolutePath)
    sizeBytes = isDirectory ? 0 : stat.size
    modifiedAt = stat.mtime.toISOString()
  }
  catch {
    sizeBytes = 0
    modifiedAt = ''
  }
  const relativePath = toPosixRelative(path.resolve(instanceRoot), absolutePath)
  return {
    path: relativePath,
    name,
    type: isDirectory ? 'directory' : 'file',
    sizeBytes,
    modifiedAt,
    protected: !isDirectory && isProtectedInstanceFile(relativePath),
  }
}

/**
 * 列出目录的直接子项。
 *
 * 跳过符号链接：面板以 root 运行，跟随链接可能把读写引到实例目录之外。
 * 链接本身也不能作为「文件」展示，否则点开就是一次越权尝试。
 */
export function listInstanceDirectory(instanceRoot: string, relativePath: string): InstanceFileEntry[] {
  const resolved = resolveInstancePath(instanceRoot, relativePath, { allowRoot: true })
  if (!resolved.ok) {
    throw new Error(resolved.message)
  }
  const entries = fs.readdirSync(resolved.absolutePath, { withFileTypes: true })
  return entries
    .filter(entry => !entry.isSymbolicLink())
    .map(entry => readEntry(
      instanceRoot,
      path.resolve(resolved.absolutePath, entry.name),
      entry.name,
      entry.isDirectory(),
    ))
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
}

export interface InstanceTextFile {
  content: string
  sizeBytes: number
  truncated: boolean
  modifiedAt: string
  editable: boolean
}

export function readInstanceTextFile(instanceRoot: string, relativePath: string): InstanceTextFile {
  const resolved = resolveInstancePath(instanceRoot, relativePath)
  if (!resolved.ok) {
    throw new Error(resolved.message)
  }
  if (isProtectedInstanceFile(resolved.relativePath)) {
    throw new Error('该文件包含敏感信息，面板不提供内容查看')
  }
  const stat = fs.statSync(resolved.absolutePath)
  if (!stat.isFile()) {
    throw new Error('只能查看文件内容')
  }
  const editable = isEditableTextPath(resolved.relativePath)
  if (!editable) {
    throw new Error('该文件类型不支持在面板中编辑')
  }
  const truncated = stat.size > INSTANCE_TEXT_FILE_MAX_BYTES
  const buffer = Buffer.alloc(Math.min(stat.size, INSTANCE_TEXT_FILE_MAX_BYTES))
  const fd = fs.openSync(resolved.absolutePath, 'r')
  try {
    fs.readSync(fd, buffer, 0, buffer.length, 0)
  }
  finally {
    fs.closeSync(fd)
  }
  return {
    content: buffer.toString('utf8'),
    sizeBytes: stat.size,
    truncated,
    modifiedAt: stat.mtime.toISOString(),
    editable,
  }
}

export function writeInstanceTextFile(instanceRoot: string, relativePath: string, content: string): { sizeBytes: number } {
  const resolved = resolveInstancePath(instanceRoot, relativePath)
  if (!resolved.ok) {
    throw new Error(resolved.message)
  }
  if (isProtectedInstanceFile(resolved.relativePath)) {
    throw new Error('该文件包含敏感信息，面板不提供写入')
  }
  if (!isEditableTextPath(resolved.relativePath)) {
    throw new Error('该文件类型不支持在面板中编辑')
  }
  const sizeBytes = Buffer.byteLength(content, 'utf8')
  if (sizeBytes > INSTANCE_TEXT_FILE_MAX_BYTES) {
    throw new Error(`文件内容超过 ${Math.floor(INSTANCE_TEXT_FILE_MAX_BYTES / 1024)} KiB 上限`)
  }
  if (fs.existsSync(resolved.absolutePath) && !fs.statSync(resolved.absolutePath).isFile()) {
    throw new Error('目标不是文件，无法写入')
  }
  backupFile(resolved.absolutePath)
  writeFileAtomic(resolved.absolutePath, content)
  return { sizeBytes }
}

export function deleteInstancePath(instanceRoot: string, relativePath: string): { removed: boolean } {
  const resolved = resolveInstancePath(instanceRoot, relativePath)
  if (!resolved.ok) {
    throw new Error(resolved.message)
  }
  if (isProtectedInstanceFile(resolved.relativePath)) {
    throw new Error('该文件包含敏感信息，面板不提供删除')
  }
  if (!fs.existsSync(resolved.absolutePath)) {
    return { removed: false }
  }
  fs.rmSync(resolved.absolutePath, { recursive: true, force: true })
  return { removed: true }
}

/** 重命名只改同目录内的名字，避免把文件搬到实例目录之外或跨目录覆盖 */
export function renameInstancePath(instanceRoot: string, relativePath: string, nextName: string): { path: string } {
  const resolved = resolveInstancePath(instanceRoot, relativePath)
  if (!resolved.ok) {
    throw new Error(resolved.message)
  }
  if (isProtectedInstanceFile(resolved.relativePath)) {
    throw new Error('该文件包含敏感信息，面板不提供重命名')
  }
  const name = (nextName ?? '').trim()
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('新名称不合法')
  }
  if (isProtectedInstanceFile(name)) {
    throw new Error('不能重命名为敏感文件名')
  }
  const parentRelative = path.posix.dirname(resolved.relativePath)
  const nextRelative = parentRelative === '.' ? name : `${parentRelative}/${name}`
  const target = resolveInstancePath(instanceRoot, nextRelative)
  if (!target.ok) {
    throw new Error(target.message)
  }
  if (fs.existsSync(target.absolutePath)) {
    throw new Error('同名文件已存在')
  }
  fs.renameSync(resolved.absolutePath, target.absolutePath)
  return { path: target.relativePath }
}

export interface InstanceKeyFile {
  label: string
  /** 相对实例目录的路径 */
  path: string
  /** 这一项里能改什么 */
  description: string
  /** 文件当前是否存在；不存在时界面不提供跳转 */
  exists: boolean
}

/**
 * 解析上传目标：目录相对路径 + 文件名 → 实例目录内的目标文件。
 *
 * 文件名单独校验而不是拼成路径再校验：`fileName` 里带 `/` 或 `..` 时，
 * 拼接后的路径仍然「在实例目录内」，但用户以为传到了子目录，语义上是错的。
 */
export function resolveInstanceUploadTarget(
  instanceRoot: string,
  dirRelativePath: string,
  fileName: string,
): ResolveInstancePathResult {
  const name = (fileName ?? '').trim()
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return { ok: false, message: '文件名不合法' }
  }
  if (isProtectedInstanceFile(name)) {
    return { ok: false, message: '该文件包含敏感信息，面板不提供上传覆盖' }
  }
  const dir = (dirRelativePath ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const target = dir ? `${dir}/${name}` : name
  return resolveInstancePath(instanceRoot, target)
}

/** 上传落盘：先写同目录临时文件再改名，避免中断留下半个同名文件 */
export function writeInstanceUploadFile(targetAbsolutePath: string, payload: NodeJS.ReadableStream): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const tempPath = `${targetAbsolutePath}.uploading-${process.pid}`
    const writeStream = fs.createWriteStream(tempPath)
    let received = 0
    let settled = false

    const fail = (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      writeStream.destroy()
      fs.rmSync(tempPath, { force: true })
      reject(error)
    }

    payload.on('error', fail)
    writeStream.on('error', fail)
    writeStream.on('finish', () => {
      if (settled) {
        return
      }
      settled = true
      try {
        fs.renameSync(tempPath, targetAbsolutePath)
        resolve(received)
      }
      catch (error) {
        fs.rmSync(tempPath, { force: true })
        reject(error instanceof Error ? error : new Error('写入失败'))
      }
    })
    payload.on('data', (chunk: Buffer) => {
      received += chunk.length
    })
    payload.pipe(writeStream)
  })
}

/** 覆盖前留一份原件，与文本编辑保持一致：上传错文件还能自己翻回去 */
export function backupExistingInstanceFile(targetAbsolutePath: string): { overwritten: boolean } {
  if (!fs.existsSync(targetAbsolutePath)) {
    return { overwritten: false }
  }
  backupFile(targetAbsolutePath)
  return { overwritten: true }
}

/** 下载前的检查：只允许实例目录内的普通文件，敏感文件一律拒绝 */
export function resolveInstanceDownloadPath(instanceRoot: string, relativePath: string): ResolveInstancePathResult {
  const resolved = resolveInstancePath(instanceRoot, relativePath)
  if (!resolved.ok) {
    return resolved
  }
  if (isProtectedInstanceFile(resolved.relativePath)) {
    return { ok: false, message: '该文件包含敏感信息，面板不提供下载' }
  }
  if (!fs.existsSync(resolved.absolutePath) || !fs.statSync(resolved.absolutePath).isFile()) {
    return { ok: false, message: '只能下载实例目录内的普通文件' }
  }
  return resolved
}

/**
 * DST 的关键配置文件清单。
 *
 * 房间页、世界页、Mod 页已经覆盖了常用项，这里只解决「知道要改哪个文件、但不想在
 * 目录树里翻」的问题：路径按 DST 目录约定拼出来，存在与否由磁盘决定。
 */
export function listInstanceKeyFiles(instanceRoot: string): InstanceKeyFile[] {
  const clusterBase = `${DST_STORAGE_DIR}/${DST_CONF_DIR}/${DST_CLUSTER_NAME}`
  const candidates: Omit<InstanceKeyFile, 'exists'>[] = [
    { label: '房间配置', path: `${clusterBase}/cluster.ini`, description: '房间名、密码、人数、联网方式、分片总开关' },
    { label: '地上世界', path: `${clusterBase}/Master/server.ini`, description: '地上分片的端口与分片角色' },
    { label: '地上世界生成', path: `${clusterBase}/Master/worldgenoverride.lua`, description: '地上地图预设与规则覆盖项' },
    { label: '地上 Mod 配置', path: `${clusterBase}/Master/modoverrides.lua`, description: '地上分片启用的 Mod 与参数' },
    { label: '洞穴配置', path: `${clusterBase}/Caves/server.ini`, description: '洞穴分片的端口与分片角色' },
    { label: '洞穴世界生成', path: `${clusterBase}/Caves/worldgenoverride.lua`, description: '洞穴地图预设与规则覆盖项' },
    { label: '洞穴 Mod 配置', path: `${clusterBase}/Caves/modoverrides.lua`, description: '洞穴分片启用的 Mod 与参数' },
  ]
  return candidates.map(item => ({
    ...item,
    exists: fs.existsSync(path.join(instanceRoot, item.path)),
  }))
}
