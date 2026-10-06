import assert from 'node:assert/strict'
import { it } from 'node:test'
import { createInstanceActionScope, updateModSubscription } from './modSubscriptionActions'

it('does not commit A responses to B or a new visit to A', async () => {
  let selected = 'A'
  const scope = createInstanceActionScope(() => selected)
  let release!: (value: string) => void
  const pending = updateModSubscription(scope.capture(), { workshopId: '123', enabled: false }, async (id, workshop, data) => {
    assert.deepEqual([id, workshop, data], ['A', '123', { enabled: true }])
    return new Promise<string>(resolve => { release = resolve })
  })
  selected = 'B'
  scope.invalidate()
  selected = 'A'
  scope.invalidate()
  release('done')
  assert.equal(await pending, null)
})

it('commits the captured target instead of toggling a changed row', async () => {
  const scope = createInstanceActionScope(() => 'A')
  const item = { workshopId: '123', enabled: false }
  const result = await updateModSubscription(scope.capture(), item, async () => {
    item.enabled = true
    return 'done'
  })
  assert.deepEqual(result, { response: 'done', enabled: true })
})
