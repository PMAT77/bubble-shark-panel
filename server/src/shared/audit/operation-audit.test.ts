import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import {
  appendOperationAudit,
  extractAuditPath,
  readOperationAudit,
  resolveOperationAuditRoot,
  resolveOperationOutcome,
  shouldAuditRequest,
} from './operation-audit'
import { summarizeAuditParams } from '../http/audit-params'

/**
 * 用户操作审计的测试。
 *
 * 这条能力此前只存在于应用日志里（README 长期写着「查不到谁在什么时候重启了世界」），
 * 所以用例重点盯三件事：
 *   1. **只记写操作**——读接口量很大，全记进去等于把审计淹没；
 *   2. **失败与被拒也要记**——「谁在没权限时尝试删除备份」比一次成功的备份更值得看；
 *   3. **参数必须脱敏**——审计文件会被打包反馈、贴进群里、交给客户或审计方。
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-operation-audit-'))
process.env.BSP_OPERATION_AUDIT_ROOT = workDir

function resetAuditFile(): void {
  fs.rmSync(path.join(workDir, 'operations.ndjson'), { force: true })
}

beforeEach(() => {
  resetAuditFile()
})

after(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('shouldAuditRequest', () => {
  it('只记写操作，读操作不记', () => {
    assert.equal(shouldAuditRequest('POST', '/app/instance/start'), true)
    assert.equal(shouldAuditRequest('DELETE', '/app/instance/files'), true)
    assert.equal(shouldAuditRequest('PUT', '/app/system/settings'), true)
    assert.equal(shouldAuditRequest('GET', '/app/instance/list'), false)
    assert.equal(shouldAuditRequest('HEAD', '/app/system/info'), false)
  })

  it('健康检查与流式接口即使方法是 POST 也不记', () => {
    assert.equal(shouldAuditRequest('POST', '/api/ping'), false)
    assert.equal(shouldAuditRequest('POST', '/health'), false)
    assert.equal(shouldAuditRequest('POST', '/api/meta/runtime'), false)
  })

  it('路径里的查询串不参与判定，也不写进记录', () => {
    assert.equal(shouldAuditRequest('POST', '/app/instance/map/refresh?force=1'), true)
    assert.equal(extractAuditPath('/app/instance/map/image?instanceId=x&token=secret'), '/app/instance/map/image')
  })
})

describe('resolveOperationOutcome', () => {
  it('2xx 成功、401/403 被拒、其余失败', () => {
    assert.equal(resolveOperationOutcome(200), 'ok')
    assert.equal(resolveOperationOutcome(204), 'ok')
    assert.equal(resolveOperationOutcome(401), 'denied')
    assert.equal(resolveOperationOutcome(403), 'denied')
    assert.equal(resolveOperationOutcome(400), 'error')
    assert.equal(resolveOperationOutcome(500), 'error')
  })
})

describe('appendOperationAudit / readOperationAudit', () => {
  it('写入后能读回，字段完整且最近的在前', () => {
    appendOperationAudit({
      account: 'superadmin',
      userId: 'user-1',
      method: 'post',
      path: '/app/instance/restart',
      body: { id: 'inst-1' },
      statusCode: 200,
      durationMs: 1234,
      requestId: 'req-1',
    })
    appendOperationAudit({
      account: 'superadmin',
      userId: 'user-1',
      method: 'POST',
      path: '/app/instance/stop',
      body: { id: 'inst-1' },
      statusCode: 200,
      durationMs: 50,
      requestId: 'req-2',
    })

    const records = readOperationAudit({ limit: 10 })
    assert.equal(records.length, 2)
    assert.equal(records[0]?.path, '/app/instance/stop', '最近的记录应当排在最前')
    assert.equal(records[0]?.method, 'POST', '方法统一大写')
    assert.equal(records[0]?.account, 'superadmin')
    assert.deepEqual(records[1]?.params, { id: 'inst-1' })
    assert.ok((records[0]?.id ?? 0) > 0)
  })

  it('未登录的写操作也记，账号为 null', () => {
    appendOperationAudit({
      account: null,
      userId: null,
      method: 'POST',
      path: '/app/instance/delete',
      body: { id: 'inst-1' },
      statusCode: 401,
      durationMs: 5,
      requestId: 'req-3',
    })
    const [record] = readOperationAudit({ limit: 5 })
    assert.equal(record?.account, null)
    assert.equal(record?.outcome, 'denied')
  })

  it('敏感参数被隐去，长值被截断', () => {
    appendOperationAudit({
      account: 'admin',
      userId: 'u',
      method: 'POST',
      path: '/app/account/password/edit',
      body: {
        oldPassword: 'plain-old',
        newPassword: 'plain-new',
        clusterToken: 'pds-token',
        note: 'x'.repeat(500),
      },
      statusCode: 200,
      durationMs: 10,
      requestId: 'req-4',
    })
    const [record] = readOperationAudit({ limit: 5 })
    assert.equal(record?.params.oldPassword, '[已隐去]')
    assert.equal(record?.params.newPassword, '[已隐去]')
    assert.equal(record?.params.clusterToken, '[已隐去]')
    assert.ok(String(record?.params.note).length <= 201)
    const raw = fs.readFileSync(path.join(workDir, 'operations.ndjson'), 'utf8')
    assert.doesNotMatch(raw, /plain-old|plain-new|pds-token/)
  })

  it('按账号过滤', () => {
    appendOperationAudit({ account: 'alice', userId: null, method: 'POST', path: '/app/a', body: {}, statusCode: 200, durationMs: 1, requestId: 'r1' })
    appendOperationAudit({ account: 'bob', userId: null, method: 'POST', path: '/app/b', body: {}, statusCode: 200, durationMs: 1, requestId: 'r2' })
    const onlyBob = readOperationAudit({ account: 'bob', limit: 10 })
    assert.equal(onlyBob.length, 1)
    assert.equal(onlyBob[0]?.path, '/app/b')
  })

  it('损坏的行被跳过，不影响其余记录', () => {
    appendOperationAudit({ account: 'admin', userId: null, method: 'POST', path: '/app/ok', body: {}, statusCode: 200, durationMs: 1, requestId: 'r1' })
    fs.appendFileSync(path.join(workDir, 'operations.ndjson'), '{ 这不是 JSON\n', 'utf8')
    const records = readOperationAudit({ limit: 10 })
    assert.equal(records.length, 1)
    assert.equal(records[0]?.path, '/app/ok')
  })

  it('审计目录不存在时读回空数组而不是报错', () => {
    resetAuditFile()
    assert.deepEqual(readOperationAudit({ limit: 10 }), [])
    assert.equal(resolveOperationAuditRoot(), workDir)
  })
})

describe('summarizeAuditParams', () => {
  it('与插件审计共用同一套脱敏规则', () => {
    const summary = summarizeAuditParams({
      token: 'a',
      apiKey: 'b',
      credentialId: 'c',
      cookieHeader: 'd',
      instanceId: 'inst-1',
      nested: { a: 1 },
      list: [1, 2],
    })
    assert.equal(summary.token, '[已隐去]')
    assert.equal(summary.apiKey, '[已隐去]')
    assert.equal(summary.credentialId, '[已隐去]')
    assert.equal(summary.cookieHeader, '[已隐去]')
    assert.equal(summary.instanceId, 'inst-1')
    assert.equal(summary.nested, '{1 个字段}')
    assert.equal(summary.list, '[2 项]')
  })

  it('非对象输入返回空摘要', () => {
    assert.deepEqual(summarizeAuditParams(null), {})
    assert.deepEqual(summarizeAuditParams('text'), {})
    assert.deepEqual(summarizeAuditParams([1, 2]), {})
  })
})
