import assert from 'node:assert/strict'
import { it } from 'node:test'
import { sendNotification } from './channels'

const outgoing = { url: 'https://notify.invalid', headers: {}, body: '{}', contentType: 'application/json' as const }

it('sets a 15 second cancellation deadline for requests without response headers', async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 15000); return timeout(5) })
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
  }))
  // AbortSignal.timeout 不保活事件循环；这根短定时器只用于隔离测试。
  const keepAlive = setTimeout(() => {}, 1000)
  try { await assert.rejects(sendNotification(outgoing), /timeout/i) }
  finally { clearTimeout(keepAlive) }
})

for (const status of [200, 503]) {
  it(`cancels an endless response body with HTTP ${status}`, async (t) => {
    let canceled = false
    const body = new ReadableStream({ cancel() { canceled = true } })
    t.mock.method(globalThis, 'fetch', async () => new Response(body, { status }))
    if (status === 200) await sendNotification(outgoing)
    else await assert.rejects(sendNotification(outgoing), /HTTP 503/)
    assert.equal(canceled, true)
  })
}
