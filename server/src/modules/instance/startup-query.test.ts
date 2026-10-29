import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { it, type TestContext } from 'node:test'
import { getContainerRuntime, type ContainerRef } from '../../infra/container'
import { instanceConsoleLogStore as logs } from '../../shared/instance-runtime/console-log-store'
import { queryStartupShard } from './container-lifecycle'

const ref: ContainerRef = { id: 'query-fixture', name: 'query-fixture' }

function fixture(t: TestContext) {
  const id = randomUUID()
  const controller = new AbortController()
  let subscriptions = 0
  const subscribe = logs.subscribe.bind(logs)
  t.mock.method(logs, 'subscribe', (...[instanceId, listener]: Parameters<typeof subscribe>) => {
    subscriptions++
    const unsubscribe = subscribe(instanceId, listener)
    return () => { subscriptions--; unsubscribe() }
  })
  t.after(() => {
    controller.abort()
    logs.removeInstance(id)
    assert.equal(subscriptions, 0, '查询结束必须释放日志订阅')
  })
  return { id, controller, runtime: getContainerRuntime() }
}

it('先订阅再发查询，同步响应不会被后续大量日志挤掉', async (t) => {
  const f = fixture(t)
  t.mock.method(f.runtime, 'execStdin', async (_ref: ContainerRef, command: string) => {
    const token = /BSPSTART:([a-f0-9-]{36})\|/.exec(command)![1]
    logs.appendDockerLine(f.id, `BSPSTART:${token}|1|1|x`, 'master')
    for (let i = 0; i < 2100; i++) logs.appendDockerLine(f.id, `Loading ${i}`, 'master')
    return { exitCode: 0, output: '' }
  })
  assert.equal((await queryStartupShard(ref, f.id, 'master', f.controller.signal))?.worldReady, true)
})

it('取消后的迟到响应和错误分片不能满足新查询', async (t) => {
  const f = fixture(t)
  const commands: string[] = []
  t.mock.method(f.runtime, 'execStdin', async (_ref: ContainerRef, command: string) => {
    commands.push(/BSPSTART:([a-f0-9-]{36})\|/.exec(command)![1]!)
    return { exitCode: 0, output: '' }
  })
  const oldQuery = queryStartupShard(ref, f.id, 'master', f.controller.signal)
  f.controller.abort()
  assert.equal(await oldQuery, null)
  const next = new AbortController()
  t.after(() => next.abort())
  const query = queryStartupShard(ref, f.id, 'master', next.signal)
  logs.appendDockerLine(f.id, `BSPSTART:${commands[0]}|1|old|x`, 'master')
  logs.appendDockerLine(f.id, `BSPSTART:${commands[1]}|1|wrong-shard|x`, 'caves')
  logs.appendDockerLine(f.id, `RemoteCommandInput: BSPSTART:${commands[1]}|1|echo|x`, 'master')
  logs.appendDockerLine(f.id, `BSPSTART:${commands[1]}|1|current|x`, 'master')
  assert.equal((await query)?.shardId, 'current')
})

it('写入控制台挂起时仍遵守期限并释放订阅', async (t) => {
  const f = fixture(t)
  t.mock.method(f.runtime, 'execStdin', () => new Promise(() => {}))
  assert.equal(await queryStartupShard(ref, f.id, 'master', f.controller.signal, undefined, Date.now() + 50), null)
})

it('已过期查询不发送命令，写入失败后也释放订阅', async (t) => {
  const f = fixture(t)
  const exec = t.mock.method(f.runtime, 'execStdin', async () => ({ exitCode: 1, output: 'unavailable' }))
  assert.equal(await queryStartupShard(ref, f.id, 'master', f.controller.signal, undefined, Date.now() - 1), null)
  assert.equal(exec.mock.callCount(), 0)
  assert.equal(await queryStartupShard(ref, f.id, 'master', f.controller.signal), null)
})

it('未收到响应时沿用查询编号重试，仍接受首次命令的迟到响应', async (t) => {
  const f = fixture(t)
  const tokens: string[] = []
  t.mock.method(f.runtime, 'execStdin', async (_ref: ContainerRef, command: string) => {
    tokens.push(/BSPSTART:([a-f0-9-]{36})\|/.exec(command)![1]!)
    if (tokens.length === 2) logs.appendDockerLine(f.id, `BSPSTART:${tokens[0]}|1|1|x`, 'master')
    return { exitCode: 0, output: '' }
  })
  const probe = await queryStartupShard(ref, f.id, 'master', f.controller.signal, undefined, Date.now() + 8000)
  assert.equal(probe?.worldReady, true)
  assert.equal(tokens.length, 2)
  assert.equal(tokens[0], tokens[1])
})
