import { readBrandEnv } from '../../../shared/brand-env'
import type { PluginAuditRecord } from '../../../shared/contracts/plugin'
import fs from 'node:fs'
import path from 'node:path'
import { loadServerConfig } from '../shared/config'
import { summarizeAuditParams } from '../shared/http/audit-params'

/**
 * 插件调用审计。
 *
 * 落盘格式用 NDJSON（每行一条 JSON）而不是数据库表，理由：
 * 1. **插件不该因为面板数据库坏了就没法追责**——审计必须比被审计的对象更耐久；
 * 2. 管理员可以直接 `tail` / `grep` 原始文件，不需要进数据库；
 * 3. 写入是纯追加，不需要事务，也不会和实例状态机的事务互相影响。
 *
 * 参数摘要的脱敏规则与用户操作审计共用一份实现（`shared/http/audit-params.ts`）：
 * 两处各写一份的话，漏掉一个敏感键名就等于泄一次凭据。
 */

const AUDIT_DIR_NAME = 'plugin-audit'
const MAX_RECORDS_PER_PLUGIN = 5_000

export { summarizeAuditParams }

export function resolvePluginAuditRoot(): string {
  const configured = readBrandEnv('BSP_PLUGIN_AUDIT_ROOT')?.trim()
  if (configured) {
    return path.resolve(configured)
  }
  return path.join(path.dirname(loadServerConfig().dbPath), AUDIT_DIR_NAME)
}

/** 插件 ID 用作文件名，必须限制字符集，避免 `../` 之类写出目录 */
function auditFilePath(pluginId: string): string {
  const safe = pluginId.replace(/[^a-z0-9-]/gi, '_').slice(0, 64) || 'unknown'
  return path.join(resolvePluginAuditRoot(), `${safe}.ndjson`)
}

/**
 * 记录序号：只在进程内递增，用于同一毫秒内多条记录的稳定排序。
 * 重启后从头开始没关系——审计是追加文件，`at` + `id` 足以表达先后。
 */
let sequence = 0

/** 追加一条审计记录；任何写盘异常都只告警不影响调用方 */
export function appendPluginAudit(input: {
  pluginId: string
  capability: string
  action: string
  params?: unknown
  outcome: PluginAuditRecord['outcome']
  message?: string | null
  durationMs: number
  onError?: (error: Error) => void
}): PluginAuditRecord {
  sequence += 1
  const record: PluginAuditRecord = {
    id: sequence,
    at: new Date().toISOString(),
    pluginId: input.pluginId,
    capability: input.capability,
    action: input.action,
    params: summarizeAuditParams(input.params),
    outcome: input.outcome,
    message: input.message ?? null,
    durationMs: Math.max(0, Math.round(input.durationMs)),
  }
  try {
    const filePath = auditFilePath(input.pluginId)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8')
    enforceRetention(filePath)
  }
  catch (error) {
    input.onError?.(error instanceof Error ? error : new Error(String(error)))
  }
  return record
}

/** 超过上限时保留最新的一半：审计是「最近发生了什么」，不是永久档案 */
function enforceRetention(filePath: string): void {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const lines = content.split('\n').filter(line => line.trim().length > 0)
    if (lines.length <= MAX_RECORDS_PER_PLUGIN) {
      return
    }
    const kept = lines.slice(Math.floor(lines.length / 2))
    fs.writeFileSync(filePath, `${kept.join('\n')}\n`, 'utf8')
  }
  catch {
    // 保留策略失败不影响审计写入本身
  }
}

/** 读取审计记录（最近的在前）；pluginId 缺省时读取全部插件 */
export function readPluginAudit(options: { pluginId?: string, limit?: number } = {}): PluginAuditRecord[] {
  const root = resolvePluginAuditRoot()
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
  const files = options.pluginId
    ? [auditFilePath(options.pluginId)]
    : listAuditFiles(root)

  const records: PluginAuditRecord[] = []
  for (const filePath of files) {
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(line => line.trim().length > 0)
      for (const line of lines) {
        try {
          records.push(JSON.parse(line) as PluginAuditRecord)
        }
        catch {
          // 单行损坏（例如进程被强杀时写了一半）跳过，不影响其余记录
        }
      }
    }
    catch {
      continue
    }
  }
  records.sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : right.id - left.id))
  return records.slice(0, limit)
}

function listAuditFiles(root: string): string[] {
  try {
    return fs.readdirSync(root)
      .filter(name => name.endsWith('.ndjson'))
      .map(name => path.join(root, name))
  }
  catch {
    return []
  }
}
