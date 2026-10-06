import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createConsoleLogBuffer } from './consoleLogBuffer'

it('bounds 100000 incoming lines before publishing and batches updates into one frame', () => {
  let frame: FrameRequestCallback | undefined
  let scheduled = 0
  let published: { id: number }[] = []
  const buffer = createConsoleLogBuffer<{ id: number }>(lines => { published = lines }, callback => {
    frame = callback
    return ++scheduled
  }, () => { frame = undefined })
  for (let id = 1; id <= 100000; id++) buffer.append([{ id }])
  assert.equal(scheduled, 1)
  assert.equal(published.length, 0)
  frame!(0)
  assert.equal(published.length, 2000)
  assert.equal(published[0].id, 98001)
  assert.equal(published.at(-1)!.id, 100000)
  buffer.append([{ id: 100000 }])
  buffer.flush()
  assert.equal(published.length, 2000)
  buffer.clear()
  buffer.append([{ id: 100000 }])
  buffer.flush()
  assert.deepEqual(published, [{ id: 100000 }])
  buffer.append([{ id: 100001 }])
  buffer.clear()
  assert.equal(frame, undefined)
  assert.deepEqual(published, [])
})
