import assert from 'node:assert/strict'
import { it } from 'node:test'
import Fastify from 'fastify'
import { registerInstanceContentRouteGuards } from './routes'
import { withInstanceContentActivity, withInstanceContentOperation, beginInstanceContentActivity } from './operation'

it('allows an internal activity to take a backup lock but rejects a competing request', async () => {
  const app = Fastify()
  registerInstanceContentRouteGuards(app)
  app.post('/app/instance/update', async request => withInstanceContentOperation((request.body as { id: string }).id, async () => ({ updated: true })))
  const response = await app.inject({ method: 'POST', url: '/app/instance/update', payload: { id: 'coordinator' } })
  assert.deepEqual(JSON.parse(response.body), { updated: true })
  let release!: () => void
  const operation = withInstanceContentOperation('coordinator', () => new Promise<void>(resolve => release = resolve))
  try {
    const blocked = await app.inject({ method: 'POST', url: '/app/instance/update', payload: { id: 'coordinator' } })
    assert.match(JSON.parse(blocked.body).error, /正在执行/)
  }
  finally { release(); await operation; await app.close() }
})

it('keeps activity locks until asynchronous work completes and rejects nested content transactions', async () => {
  let release!: () => void
  const activity = withInstanceContentActivity('coordinator-async', () => new Promise<void>(resolve => release = resolve))
  try { await assert.rejects(withInstanceContentOperation('coordinator-async', async () => {}), /正在执行/) }
  finally { release(); await activity }
  await withInstanceContentOperation('coordinator-async', async () => {
    const end = beginInstanceContentActivity('coordinator-async')
    end()
    await assert.rejects(withInstanceContentOperation('coordinator-async', async () => {}), /正在执行/)
  })
})
