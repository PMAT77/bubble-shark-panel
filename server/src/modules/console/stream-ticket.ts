import { randomBytes } from 'node:crypto'

const DEFAULT_TTL_MS = 60_000
const MAX_ACTIVE_TICKETS = 1_000

/**
 * 同一个账号允许同时挂着的实时日志流数量。
 *
 * 票据是一次性的，但**同一个账号可以反复签票**，所以"票据制"本身不构成任何并发上限：
 * 一个已登录的匿名游客就能把浏览器标签页开成一条条 SSE 长连接，每条都在服务端保留
 * 一个订阅回调 + 一个 15 秒心跳定时器，直到对端断开。
 *
 * 面板本身只有几个页面在用这条流（控制台页），4 条足够覆盖"多开两个标签页对照日志"，
 * 再多的都是异常。超限时直接拒绝（回 429），不排队——排队会让服务端替攻击者攒住连接。
 */
const DEFAULT_MAX_STREAMS_PER_USER = 4

export interface ConsoleStreamTicketRecord {
  instanceId: string
  userId: string
  expiresAt: number
}

export interface CreateConsoleStreamTicketStoreOptions {
  now?: () => number
  ttlMs?: number
  maxStreamsPerUser?: number
}

export interface IssueConsoleStreamTicketInput {
  instanceId: string
  userId: string
}

export function createConsoleStreamTicketStore(options: CreateConsoleStreamTicketStoreOptions = {}) {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const maxStreamsPerUser = options.maxStreamsPerUser ?? DEFAULT_MAX_STREAMS_PER_USER
  const tickets = new Map<string, ConsoleStreamTicketRecord>()
  /** userId → 当前挂着的流数量。只增不减会让拒绝永远生效，所以 close 必须成对调用 */
  const activeStreams = new Map<string, number>()

  function removeExpiredTickets(currentTime = now()) {
    for (const [ticket, record] of tickets) {
      if (record.expiresAt <= currentTime) {
        tickets.delete(ticket)
      }
    }
  }

  function issue(input: IssueConsoleStreamTicketInput) {
    removeExpiredTickets()
    if (tickets.size >= MAX_ACTIVE_TICKETS) {
      const oldestTicket = tickets.keys().next().value
      if (oldestTicket) {
        tickets.delete(oldestTicket)
      }
    }

    const ticket = randomBytes(32).toString('base64url')
    const expiresAt = now() + ttlMs
    tickets.set(ticket, {
      instanceId: input.instanceId,
      userId: input.userId,
      expiresAt,
    })
    return { ticket, expiresAt }
  }

  function consume(ticket: string, instanceId: string): ConsoleStreamTicketRecord | null {
    removeExpiredTickets()
    const record = tickets.get(ticket)
    if (!record || record.instanceId !== instanceId) {
      return null
    }
    tickets.delete(ticket)
    return record
  }

  /**
   * 尝试为某个账号占据一个流名额。
   *
   * 返回 token 表示成功（`closeStream` 时必须原样传回），null 表示该账号已达上限。
   */
  function openStream(userId: string): string | null {
    const current = activeStreams.get(userId) ?? 0
    if (current >= maxStreamsPerUser) {
      return null
    }
    activeStreams.set(userId, current + 1)
    return userId
  }

  /** 释放一个流名额。重复调用是安全的（计数不会被减到负数） */
  function closeStream(userId: string): void {
    const current = activeStreams.get(userId) ?? 0
    if (current <= 1) {
      activeStreams.delete(userId)
      return
    }
    activeStreams.set(userId, current - 1)
  }

  function activeStreamCount(userId: string): number {
    return activeStreams.get(userId) ?? 0
  }

  return {
    issue,
    consume,
    openStream,
    closeStream,
    activeStreamCount,
    maxStreamsPerUser,
  }
}

export const consoleStreamTicketStore = createConsoleStreamTicketStore()
