import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const sha1 = data => createHash('sha1').update(data).digest('hex')

export function atomicCacheWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.partial`
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, file)
  }
  finally { fs.rmSync(temporary, { force: true }) }
}

export async function fileMatches(file, size, hash, signal) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size !== size) return false
    const digest = createHash('sha1')
    for await (const data of fs.createReadStream(file, { signal })) digest.update(data)
    return size === 0 || digest.digest('hex') === hash
  }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

export class WorkshopChunkCache {
  constructor(root) { this.root = root }
  filename(chunk) {
    if (!/^[a-f0-9]{40}$/.test(chunk.sha) || !Number.isSafeInteger(chunk.size) || chunk.size < 1) throw new Error('Invalid Steam chunk identity')
    return path.join(this.root, 'chunks', '322330', chunk.sha.slice(0, 2), `${chunk.sha}-${chunk.size}`)
  }
  async has(chunk, signal) {
    const file = this.filename(chunk)
    if (!await fileMatches(file, chunk.size, chunk.sha, signal)) return false
    const now = new Date()
    fs.utimesSync(file, now, now)
    return true
  }
  put(chunk, bytes) {
    if (bytes.length !== chunk.size || sha1(bytes) !== chunk.sha) throw new Error('Downloaded chunk checksum mismatch')
    atomicCacheWrite(this.filename(chunk), bytes)
  }
  async seed(chunk, file, offset, signal) {
    signal.throwIfAborted()
    let handle
    try {
      if (!fs.lstatSync(file).isFile()) return false
      handle = await fs.promises.open(file, 'r')
      const bytes = Buffer.alloc(chunk.size)
      let read = 0
      while (read < bytes.length) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(bytes, read, bytes.length - read, offset + read)
        if (!bytesRead) return false
        read += bytesRead
      }
      if (sha1(bytes) !== chunk.sha) return false
      this.put(chunk, bytes)
      return true
    }
    catch (error) { if (['ENOENT', 'EISDIR'].includes(error.code)) return false; throw error }
    finally { await handle?.close() }
  }
}

/** Called only while the shared worker has no download or installation leases. */
export function pruneWorkshopCache(root, maxBytes = 5 * 1024 ** 3, now = Date.now()) {
  const files = []
  let total = 0
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(file)
        if (!fs.readdirSync(file).length) fs.rmdirSync(file)
      }
      else if (entry.isFile()) {
        const stat = fs.statSync(file)
        const partial = file.endsWith('.partial') || path.relative(root, file).split(path.sep).includes('partial')
        if (partial && now - stat.mtimeMs > 86400_000) fs.unlinkSync(file)
        else { total += stat.size; files.push({ file, size: stat.size, used: stat.mtimeMs }) }
      }
    }
  }
  try {
    walk(root)
    const stat = fs.statfsSync(root)
    let free = stat.bavail * stat.bsize
    for (const item of files.sort((a, b) => a.used - b.used)) {
      if (total <= maxBytes && free >= 1024 ** 3) break
      fs.unlinkSync(item.file)
      total -= item.size
      free += item.size
    }
  }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  return total
}

/** A single budget is shared by all files and mods, including retries. */
export class DownloadSlots {
  constructor(limit = 8) { this.limit = limit; this.active = 0; this.waiters = [] }
  async run(signal, action) {
    signal.throwIfAborted()
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, aborted: null }
      waiter.aborted = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(signal.reason)
      }
      signal.addEventListener('abort', waiter.aborted, { once: true })
      this.waiters.push(waiter)
      this.drain()
    })
    try { signal.throwIfAborted(); return await action() }
    finally { this.active--; this.drain() }
  }
  drain() {
    while (this.active < this.limit && this.waiters.length) {
      const waiter = this.waiters.shift()
      waiter.signal.removeEventListener('abort', waiter.aborted)
      if (waiter.signal.aborted) { waiter.reject(waiter.signal.reason); continue }
      this.active++
      waiter.resolve()
    }
  }
}
