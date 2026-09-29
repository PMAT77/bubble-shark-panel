import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createConsoleStreamTicketStore } from './stream-ticket'

describe('consoleStreamTicketStore', () => {
  it('issues an opaque ticket that can be consumed only once for its instance', () => {
    const store = createConsoleStreamTicketStore({ now: () => 1_000 })
    const issued = store.issue({ instanceId: 'instance-a', userId: 'user-a' })

    assert.equal(store.consume(issued.ticket, 'instance-b'), null)
    assert.deepEqual(store.consume(issued.ticket, 'instance-a'), {
      instanceId: 'instance-a',
      userId: 'user-a',
      expiresAt: 61_000,
    })
    assert.equal(store.consume(issued.ticket, 'instance-a'), null)
  })

  it('rejects expired tickets', () => {
    let currentTime = 1_000
    const store = createConsoleStreamTicketStore({ now: () => currentTime, ttlMs: 100 })
    const issued = store.issue({ instanceId: 'instance-a', userId: 'user-a' })

    currentTime = 1_100
    assert.equal(store.consume(issued.ticket, 'instance-a'), null)
  })

  /**
   * 同一账号的并发流上限。
   *
   * 票据是一次性的，但**账号可以反复签票**，所以票据制本身不构成任何并发上限：
   * 没有这道闸门时，一个已登录的游客就能挂着一串 SSE 长连接，每条都在服务端留一个
   * 订阅回调与一个 15 秒心跳定时器。这里钉住"上限生效"与"释放后能再开"两件事——
   * 后者同样重要：名额只增不减的话，那个账号会永久失去日志流。
   */
  it('限制同一账号的并发流数量，且释放后可以再开', () => {
    const store = createConsoleStreamTicketStore({ maxStreamsPerUser: 2 })

    assert.equal(store.openStream('user-a'), 'user-a')
    assert.equal(store.openStream('user-a'), 'user-a')
    assert.equal(store.openStream('user-a'), null, '超过上限必须被拒，而不是排队')
    assert.equal(store.activeStreamCount('user-a'), 2)
    // 别的账号不受影响：上限是按账号算的，不是全局的
    assert.equal(store.openStream('user-b'), 'user-b')

    store.closeStream('user-a')
    assert.equal(store.activeStreamCount('user-a'), 1)
    assert.equal(store.openStream('user-a'), 'user-a', '释放名额后必须能再开')
  })

  it('重复释放不会把名额减成负数', () => {
    const store = createConsoleStreamTicketStore({ maxStreamsPerUser: 1 })
    assert.equal(store.openStream('user-a'), 'user-a')
    store.closeStream('user-a')
    store.closeStream('user-a')
    assert.equal(store.activeStreamCount('user-a'), 0)
    assert.equal(store.openStream('user-a'), 'user-a', '多释放一次不该让这个账号再也开不了流')
  })
})
