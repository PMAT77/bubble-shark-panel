import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { it } from 'node:test'
import { createConsoleStreamSession } from './stream-session'

function response() {
  const events = new EventEmitter()
  return Object.assign(events, {
    destroyed: false, writableEnded: false, writableLength: 0,
    destroy() { this.destroyed = true; events.emit('close') },
    write(text: string) { this.writableLength += Buffer.byteLength(text); return false },
  })
}

it('releases early disconnects, initialization failures and late subscriptions exactly once', () => {
  for (const event of ['close', 'error', 'initialization']) {
    const raw = response()
    let slots = 1
    let subscriptions = 1
    const session = createConsoleStreamSession(raw as unknown as ServerResponse, () => slots--)
    if (event === 'initialization') session.dispose()
    else raw.emit(event)
    session.onCleanup(() => subscriptions--)
    session.dispose()
    assert.equal(session.closed, true)
    assert.equal(slots, 0)
    assert.equal(subscriptions, 0)
    assert.equal(session.write('late'), false)
    assert.equal(raw.listenerCount('close'), 0)
    assert.equal(raw.listenerCount('error'), 0)
  }
})

it('closes only the client whose pending buffer exceeds 1 MiB', () => {
  const slow = response()
  const fast = response()
  let released = 0
  const a = createConsoleStreamSession(slow as unknown as ServerResponse, () => released++)
  const b = createConsoleStreamSession(fast as unknown as ServerResponse, () => released++)
  assert.equal(a.write('a'.repeat(1024 * 1024)), true)
  assert.equal(a.write('x'), false)
  assert.equal(slow.destroyed, true)
  assert.equal(b.write('still alive'), true)
  assert.equal(released, 1)
  b.dispose()
})
