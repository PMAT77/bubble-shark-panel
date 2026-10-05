import { readBrandEnv } from '../../../../shared/brand-env'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import fs from 'node:fs'
import path from 'node:path'
import { findUserByToken } from '../db/index'
import { loadServerConfig } from '../config'
import { summarizeAuditParams } from '../http/audit-params'
import type { AuditParamSummary } from '../http/audit-params'

/**
 * 用户操作审计：谁在什么时候对面板做了什么。
 *
 * 这是本项目公开劣势清单里长期挂着的一条（README 至今写着「查不到谁在什么时候重启了世界」），
 * 也是 B 端采购的合规硬门槛。落盘用 NDJSON 而不是数据库表，与插件调用审计同一理由：
 * **审计要比被审计的对象更耐久**——面板数据库损坏或回滚时，审计文件仍在，且管理员能直接看。
 *
 * 记什么：
 * - 只记**写操作**（POST / PUT / PATCH / DELETE）：读操作量大且没有追责价值；
 * - 成功的写操作与**被拒的写操作**都记：后者是安全事件，比成功操作更值得看；
 * - 排除登录相关接口的请求体（密码在摘要阶段已被脱敏，但登录本身另有 auth_sessions 记录）。
 *
 * 不记什么：静态资源、健康检查、SSE 流式接口（它们不改变状态）。
 */

const AUDIT_DIR_NAME = 'audit'
const AUDIT_FILE_NAME = 'operations.ndjson'
/** 单文件上限：超过就丢掉最旧的一半，避免长期运行写满磁盘 */
const MAX_RECORDS = 20_000
/** 写操作的方法白名单 */
const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
/** 不记审计的路径前缀（健康检查、流式接口、纯查询类） */
const IGNORED_PATH_PREFIXES = ['/health', '/api/ping', '/api/meta']

export interface OperationAuditRecord {
  id: number
  at: string
  /** 操作账号；未认证时为 null */
  account: string | null
  userId: string | null
  method: string
  /** 路由路径（不含查询串，避免把令牌之类拼进 URL 的参数写进审计） */
  path: string
  params: AuditParamSummary
  statusCode: number
  outcome: 'ok' | 'denied' | 'error'
  durationMs: number
  requestId: string
}

export function resolveOperationAuditRoot(): string {
  const configured = readBrandEnv('BSP_OPERATION_AUDIT_ROOT')?.trim()
  if (configured) {
    return path.resolve(configured)
  }
  return path.join(path.dirname(loadServerConfig().dbPath), AUDIT_DIR_NAME)
}

function auditFilePath(): string {
  return path.join(resolveOperationAuditRoot(), AUDIT_FILE_NAME)
}

let sequence = 0

/** 判定一次写入的结果：2xx 成功、401/403 被拒、其余为失败 */
export function resolveOperationOutcome(statusCode: number): OperationAuditRecord['outcome'] {
  if (statusCode === 401 || statusCode === 403) {
    return 'denied'
  }
  return statusCode >= 200 && statusCode < 300 ? 'ok' : 'error'
}

/** 是否值得记一条审计 */
export function shouldAuditRequest(method: string, url: string): boolean {
  if (!AUDITED_METHODS.has(method.toUpperCase())) {
    return false
  }
  const routePath = url.split('?')[0] ?? ''
  return !IGNORED_PATH_PREFIXES.some(prefix => routePath.startsWith(prefix))
}

/** 去掉查询串：审计记路径，不记可能含敏感参数的查询 */
export function extractAuditPath(url: string): string {
  return url.split('?')[0] ?? ''
}

export interface AppendOperationAuditInput {
  account: string | null
  userId: string | null
  method: string
  path: string
  body: unknown
  statusCode: number
  durationMs: number
  requestId: string
}

export function appendOperationAudit(input: AppendOperationAuditInput): OperationAuditRecord {
  sequence += 1
  const record: OperationAuditRecord = {
    id: sequence,
    at: new Date().toISOString(),
    account: input.account,
    userId: input.userId,
    method: input.method.toUpperCase(),
    path: input.path,
    params: summarizeAuditParams(input.body),
    statusCode: input.statusCode,
    outcome: resolveOperationOutcome(input.statusCode),
    durationMs: Math.max(0, Math.round(input.durationMs)),
    requestId: input.requestId,
  }
  try {
    const filePath = auditFilePath()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8')
    enforceRetention(filePath)
  }
  catch {
    // 审计写入失败不能影响业务请求本身；调用方会把它记进面板日志
  }
  return record
}

function enforceRetention(filePath: string): void {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(line => line.trim().length > 0)
    if (lines.length <= MAX_RECORDS) {
      return
    }
    fs.writeFileSync(filePath, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`, 'utf8')
  }
  catch {
    // 保留策略失败不影响审计写入
  }
}

export function readOperationAudit(options: { account?: string, limit?: number } = {}): OperationAuditRecord[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
  let lines: string[]
  try {
    lines = fs.readFileSync(auditFilePath(), 'utf8').split('\n').filter(line => line.trim().length > 0)
  }
  catch {
    return []
  }
  const records: OperationAuditRecord[] = []
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as OperationAuditRecord
      if (options.account && record.account !== options.account) {
        continue
      }
      records.push(record)
    }
    catch {
      // 单行损坏（进程被强杀时可能写了一半）跳过，不影响其余记录
    }
  }
  records.reverse()
  return records.slice(0, limit)
}

/** 从请求解析操作者：审计的价值在于「谁做的」，拿不到账号就如实记 null */
async function resolveOperator(request: FastifyRequest): Promise<{ account: string | null, userId: string | null }> {
  const header = request.headers.token
  const token = Array.isArray(header) ? header[0] : header
  if (!token) {
    return { account: null, userId: null }
  }
  try {
    const user = await findUserByToken(String(token))
    return user ? { account: user.account, userId: user.id } : { account: null, userId: null }
  }
  catch {
    return { account: null, userId: null }
  }
}

/**
 * 注册操作审计钩子。
 *
 * 用 `onResponse`：此时状态码与耗时都已确定，且不阻塞请求返回。
 * 解析操作者是异步的（要查库），因此这里不 await——审计写盘晚几十毫秒无所谓，
 * 让业务请求等它才是有问题的。
 */
export function registerOperationAudit(app: FastifyInstance): void {
  app.addHook('onResponse', (request, reply, done) => {
    if (!shouldAuditRequest(request.method, request.url)) {
      done()
      return
    }
    const path = extractAuditPath(request.url)
    const statusCode = reply.statusCode
    const durationMs = reply.elapsedTime
    const requestId = String(request.id)
    const body = request.body

    resolveOperator(request)
      .then((operator) => {
        const record = appendOperationAudit({
          account: operator.account,
          userId: operator.userId,
          method: request.method,
          path,
          body,
          statusCode,
          durationMs,
          requestId,
        })
        if (record.outcome === 'denied') {
          request.log.warn({
            account: operator.account,
            method: record.method,
            path: record.path,
            statusCode,
          }, '写操作被拒绝，已记入操作审计')
        }
      })
      .catch((error) => {
        request.log.warn({ error }, '操作审计写入失败')
      })
      .finally(() => {
        done()
      })
  })
}
