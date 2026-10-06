import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { after, before, it } from 'node:test'
import Fastify from 'fastify'
import { getContainerRuntime } from '../../infra/container'
import { closeDatabase, createGameInstance, initDatabase } from '../../shared/db'
import { instanceConsoleLogStore } from '../../shared/instance-runtime/console-log-store'
import { registerConsoleModule } from './index'
import { consoleStreamTicketStore } from './stream-ticket'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-stream-routes-'))
let instanceId: string
before(async () => {
  await initDatabase(path.join(dir, 'test.sqlite'), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle'), {
    adminUsername: 'admin', adminPassword: '123456', seedDevelopmentUsers: false,
  })
  instanceId = (await createGameInstance({ nodeId: 'local-node', name: 'stream', gameCode: '343050' })).id
})
after(() => { closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }) })
function streamUrl(userId: string) {
  const { ticket } = consoleStreamTicketStore.issue({ instanceId, userId })
  return `/app/instance/console/stream?instanceId=${instanceId}&streamTicket=${ticket}`
}

it('releases the connection slot when runtime initialization throws', async (t) => {
  const app = Fastify()
  registerConsoleModule(app)
  t.after(() => app.close())
  t.mock.method(getContainerRuntime(), 'findByName', async () => { throw new Error('unreachable') })
  const subscribe = t.mock.method(instanceConsoleLogStore, 'subscribe')
  const response = await app.inject({ url: streamUrl('failed-init') })
  assert.equal(response.statusCode, 500)
  assert.equal(consoleStreamTicketStore.activeStreamCount('failed-init'), 0)
  assert.equal(subscribe.mock.callCount(), 0)
})

it('does not create a subscription after a client disconnects during runtime probing', async (t) => {
  const app = Fastify()
  registerConsoleModule(app)
  let release!: () => void
  let entered!: () => void
  const probing = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(getContainerRuntime(), 'findByName', async () => { entered(); await gate; return undefined })
  const subscribe = t.mock.method(instanceConsoleLogStore, 'subscribe')
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  t.after(async () => { release(); await app.close() })
  const request = http.get(address + streamUrl('early-close'))
  request.on('error', () => {})
  await probing
  assert.equal(consoleStreamTicketStore.activeStreamCount('early-close'), 1)
  const closed = new Promise<void>(resolve => request.once('close', resolve))
  request.destroy()
  await closed
  // 等待真实 socket 的 close 传到服务端。
  for (let attempt = 0; attempt < 50 && consoleStreamTicketStore.activeStreamCount('early-close'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(consoleStreamTicketStore.activeStreamCount('early-close'), 0)
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(subscribe.mock.callCount(), 0)
})
