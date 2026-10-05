import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { closeDatabase, createGameInstance, initDatabase } from './index'
import { updateGameInstanceRuntime } from './instance-repository'

const dbFilePath = path.join(os.tmpdir(), `bsp-where-status-test-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

before(async () => {
  await initDatabase(dbFilePath, migrationsFolder)
})

after(() => {
  closeDatabase()
})

describe('updateGameInstanceRuntime whereStatus guard', () => {
  it('skips the write when the current status does not match (状态机竞态保护)', async () => {
    const instance = await createGameInstance({
      nodeId: 'local-node',
      name: 'guard-test',
      gameCode: 'dst',
      status: 'stopped',
      installPath: path.join(os.tmpdir(), 'bsp-guard-test'),
    })

    const unchanged = await updateGameInstanceRuntime(instance.id, {
      status: 'error',
      lastError: '不应该被写入',
      whereStatus: 'installing',
    })
    assert.equal(unchanged?.status, 'stopped')
    assert.equal(unchanged?.lastError, null)
  })

  it('applies the write when the current status matches (单值与数组形式)', async () => {
    const instance = await createGameInstance({
      nodeId: 'local-node',
      name: 'guard-test-hit',
      gameCode: 'dst',
      status: 'installing',
      installPath: path.join(os.tmpdir(), 'bsp-guard-test-hit'),
    })

    const single = await updateGameInstanceRuntime(instance.id, {
      status: 'error',
      lastError: '安装失败',
      whereStatus: 'installing',
    })
    assert.equal(single?.status, 'error')
    assert.equal(single?.lastError, '安装失败')

    const multi = await updateGameInstanceRuntime(instance.id, {
      status: 'stopped',
      lastCommand: '安装已完成',
      whereStatus: ['error', 'pending_install'],
    })
    assert.equal(multi?.status, 'stopped')
    assert.equal(multi?.lastCommand, '安装已完成')
  })
})

describe('updateGameInstanceRuntime lastErrorPhase', () => {
  it('记录失败环节，并在错误被清空时一并清空', async () => {
    const instance = await createGameInstance({
      nodeId: 'local-node',
      name: 'phase-test',
      gameCode: 'dst',
      status: 'stopped',
    })

    const failed = await updateGameInstanceRuntime(instance.id, {
      status: 'error',
      lastError: '宿主机可用内存不足',
      lastErrorPhase: 'runtime',
    })
    assert.equal(failed?.lastErrorPhase, 'runtime')

    // 启动成功会清空 lastError：环节不能残留，否则下一次失败没带环节时会被算到上一次头上
    const recovered = await updateGameInstanceRuntime(instance.id, { status: 'running', lastError: null })
    assert.equal(recovered?.lastError, null)
    assert.equal(recovered?.lastErrorPhase, null)
  })

  it('只接受 install / runtime，其余值按未知落 null', async () => {
    const instance = await createGameInstance({
      nodeId: 'local-node',
      name: 'phase-invalid-test',
      gameCode: 'dst',
      status: 'stopped',
    })

    const install = await updateGameInstanceRuntime(instance.id, {
      status: 'error',
      lastError: '安装失败',
      lastErrorPhase: 'install',
    })
    assert.equal(install?.lastErrorPhase, 'install')

    const bogus = await updateGameInstanceRuntime(instance.id, {
      lastError: '手改库写进来的值',
      lastErrorPhase: 'nonsense' as never,
    })
    assert.equal(bogus?.lastErrorPhase, null)
  })

  it('创建时缺省为空，展示层据此按运行异常兜底', async () => {
    const instance = await createGameInstance({
      nodeId: 'local-node',
      name: 'phase-default-test',
      gameCode: 'dst',
      status: 'stopped',
    })
    assert.equal(instance.lastErrorPhase, null)
  })
})
