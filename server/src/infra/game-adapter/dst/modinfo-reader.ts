import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { ModConfigDefinitionResult, ModConfigDefinitionStatus } from '../../../../../shared/contracts/mod'
import { resolveDstModInfoPath } from './mod-config'

const MAX_BYTES = 1024 * 1024
const READ_TIMEOUT_MS = 2000

const READ_MESSAGES: Record<ModConfigDefinitionStatus, string | null> = {
  parsed: null,
  empty: '这个 Mod 没有声明配置选项。',
  missing_file: '未找到这个 Mod 的配置定义，请确认 Mod 已下载完成。',
  parse_failed: '暂时无法读取这个 Mod 的配置选项，可能使用了面板暂不支持的配置写法。',
  timeout: '读取这个 Mod 的配置选项超时，可手动编辑已有配置。',
  limit_exceeded: '这个 Mod 的配置定义超出读取限制，可手动编辑已有配置。',
}

function result(status: ModConfigDefinitionStatus, definitions: ModConfigDefinitionResult['definitions'] = []): ModConfigDefinitionResult {
  return { definitions, definitionStatus: status, definitionMessage: READ_MESSAGES[status] }
}

/** Pure Lua runs outside the server process, with bounded input/output and no host capabilities. */
export async function readModInfoConfigurations(installPath: string, workshopId: string): Promise<ModConfigDefinitionResult> {
  let source: Buffer
  try {
    const filePath = resolveDstModInfoPath(installPath, workshopId)
    if (!filePath) return result('missing_file')
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) return result('parse_failed')
    if (stat.size > MAX_BYTES) return result('limit_exceeded')
    // Read at most the limit plus one byte, even if the file grows after opening.
    const file = await fs.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(MAX_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > MAX_BYTES) return result('limit_exceeded')
      source = buffer.subarray(0, length)
    }
    finally { await file.close() }
  }
  catch { return result('parse_failed') }

  return new Promise((resolve) => {
    // Docker emits .js entries; Native emits .mjs entries. Source worker is also .mjs.
    const worker = new URL(import.meta.url.endsWith('.js') ? './modinfo-reader-worker.js' : './modinfo-reader-worker.mjs', import.meta.url)
    const child = spawn(process.execPath, ['--max-old-space-size=64', fileURLToPath(worker), workshopId], {
      env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    const chunks: Buffer[] = []
    let bytes = 0
    let stopped: ModConfigDefinitionStatus | null = null
    let memoryFailure = false
    const stop = (status: ModConfigDefinitionStatus) => {
      stopped ??= status
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => stop('timeout'), READ_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_BYTES) stop('limit_exceeded')
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (/heap out of memory|Allocation failed|Array buffer allocation failed/i.test(chunk.toString())) memoryFailure = true
    })
    child.on('error', () => { stopped ??= 'parse_failed' })
    child.stdin.on('error', () => { /* A terminated worker can close stdin before source is flushed. */ })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (stopped) return resolve(result(stopped))
      if (code !== 0) return resolve(result(memoryFailure ? 'limit_exceeded' : 'parse_failed'))
      try {
        const output = JSON.parse(Buffer.concat(chunks).toString()) as { status: ModConfigDefinitionStatus, definitions: ModConfigDefinitionResult['definitions'] }
        if (!['parsed', 'empty', 'parse_failed', 'limit_exceeded'].includes(output.status) || !Array.isArray(output.definitions)) throw new Error('invalid worker result')
        resolve(result(output.status, output.definitions))
      }
      catch { resolve(result('parse_failed')) }
    })
    child.stdin.end(source)
  })
}
