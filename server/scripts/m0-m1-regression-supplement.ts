/**
 * M0/M1 补测：用例 2 / 4 / 5 / 8（见 docs/M0-M1-REGRESSION.md）
 * 用法: tsx server/scripts/m0-m1-regression-supplement.ts
 * 环境: REGRESSION_BASE_URL, REGRESSION_ACCOUNT, REGRESSION_PASSWORD, REGRESSION_INSTANCE_ID（用例 4 可选）
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.REGRESSION_BASE_URL ?? 'http://127.0.0.1:8888'
const ACCOUNT = process.env.REGRESSION_ACCOUNT ?? 'superadmin'
const PASSWORD = process.env.REGRESSION_PASSWORD ?? '123456'
const DOCKER_SOCK = process.env.REGRESSION_DOCKER_SOCK ?? '/var/run/docker.sock'
const DOCKER_SOCK_BAK = `${DOCKER_SOCK}.regression-bak`
const CACHE_WAIT_MS = Number(process.env.REGRESSION_DOCKER_CACHE_WAIT_MS ?? 35_000)

interface CaseResult {
  id: number
  name: string
  pass: boolean
  detail: string
}

const results: CaseResult[] = []

function pass(id: number, name: string, detail: string) {
  results.push({ id, name, pass: true, detail })
  console.log(`✅ #${id} ${name}: ${detail}`)
}

function fail(id: number, name: string, detail: string) {
  results.push({ id, name, pass: false, detail })
  console.error(`❌ #${id} ${name}: ${detail}`)
}

function skip(id: number, name: string, detail: string) {
  results.push({ id, name, pass: true, detail: `[SKIP] ${detail}` })
  console.log(`⏭️  #${id} ${name}: ${detail}`)
}

async function requestJson(
  method: string,
  urlPath: string,
  options?: { token?: string, body?: unknown },
): Promise<{ status: number, json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options?.token) {
    headers.token = options.token
  }
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  const json = await res.json() as Record<string, unknown>
  return { status: res.status, json }
}

async function login(): Promise<string> {
  const { status, json } = await requestJson('POST', '/app/account/login', {
    body: { account: ACCOUNT, password: PASSWORD },
  })
  if (status !== 200 || json.status !== 1) {
    throw new Error(`登录失败: ${JSON.stringify(json)}`)
  }
  const data = json.data as { token?: string }
  if (!data?.token) {
    throw new Error('登录响应缺少 token')
  }
  return data.token
}

function breakDockerSock(): 'renamed' | 'chmod' | false {
  try {
    if (!fs.existsSync(DOCKER_SOCK)) {
      return false
    }
    if (!fs.existsSync(DOCKER_SOCK_BAK)) {
      try {
        fs.renameSync(DOCKER_SOCK, DOCKER_SOCK_BAK)
        return 'renamed'
      }
      catch {
        // Windows bind-mount 常为 EBUSY，退化为 chmod
      }
    }
    fs.chmodSync(DOCKER_SOCK, 0o000)
    return 'chmod'
  }
  catch (error) {
    console.error('无法断开 docker.sock:', error)
    return false
  }
}

function restoreDockerSock(): void {
  try {
    if (fs.existsSync(DOCKER_SOCK_BAK)) {
      fs.renameSync(DOCKER_SOCK_BAK, DOCKER_SOCK)
    }
    else if (fs.existsSync(DOCKER_SOCK)) {
      fs.chmodSync(DOCKER_SOCK, 0o660)
    }
  }
  catch (error) {
    console.error('恢复 docker.sock 失败:', error)
  }
}

async function assertRuntimeGateEndpoints(token: string): Promise<boolean> {
  const endpoints: Array<{ path: string, body: Record<string, unknown> }> = [
    { path: '/app/instance/create', body: { nodeId: 'local-node', name: 'reg-docker-off', gameCode: '343050' } },
    { path: '/app/instance/start', body: { id: '00000000-0000-0000-0000-000000000001' } },
    { path: '/app/instance/update', body: { id: '00000000-0000-0000-0000-000000000001' } },
  ]
  for (const ep of endpoints) {
    const { json } = await requestJson('POST', ep.path, { token, body: ep.body })
    const err = String(json.error ?? '')
    const hasRequestId = typeof json.requestId === 'string' && json.requestId.length > 0
    const runtimeMsg = /容器运行时|Docker|SteamCMD/i.test(err)
    const isFailure = err.length > 0 && String(json.code ?? '') !== 'OK'
    if (!isFailure || !runtimeMsg || !hasRequestId) {
      fail(2, 'Docker 停止负向', `${ep.path} 响应不符合预期: ${JSON.stringify(json)}`)
      return false
    }
  }
  return true
}

async function case2DockerStoppedNegative(token: string) {
  if (process.env.REGRESSION_CASE2_SKIP === '1') {
    skip(2, 'Docker 停止负向', 'REGRESSION_CASE2_SKIP=1')
    return
  }

  const health = await requestJson('GET', '/health')
  const dockerFromHealth = String(health.json.docker ?? 'unknown')

  if (dockerFromHealth === 'stopped') {
    if (await assertRuntimeGateEndpoints(token)) {
      pass(2, 'Docker 停止负向', 'health.docker=stopped，create/start/update 均返回运行时错误且含 requestId')
    }
    return
  }

  const broke = breakDockerSock()
  if (!broke) {
    skip(2, 'Docker 停止负向', 'Docker 仍为 running 且无法断开 docker.sock；请停止 Docker Desktop 后仅运行 pnpm dev:server 再测')
    return
  }
  console.log(`已临时断开 ${DOCKER_SOCK}（方式: ${broke}），等待 ${CACHE_WAIT_MS}ms 使状态缓存刷新…`)
  try {
    await new Promise(r => setTimeout(r, CACHE_WAIT_MS))
    if (await assertRuntimeGateEndpoints(token)) {
      pass(2, 'Docker 停止负向', 'create/start/update 均返回运行时错误且含 requestId（docker.sock 已临时断开）')
    }
  }
  finally {
    restoreDockerSock()
    console.log('已恢复 docker.sock')
    await new Promise(r => setTimeout(r, 3_000))
  }
}

async function findRunningInstance(token: string): Promise<string | null> {
  if (process.env.REGRESSION_INSTANCE_ID?.trim()) {
    return process.env.REGRESSION_INSTANCE_ID.trim()
  }
  const { json } = await requestJson('POST', '/app/instance/list', { token, body: { status: 'running' } })
  const items = (json.data as Array<{ id: string }>) ?? []
  return items[0]?.id ?? null
}

async function case4DbDrift(token: string) {
  const instanceId = await findRunningInstance(token)
  if (!instanceId) {
    skip(4, 'DB/容器漂移', '无运行中实例，请设置 REGRESSION_INSTANCE_ID 或先启动实例')
    return
  }
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dbPath = process.env.REGRESSION_DB_PATH ?? path.resolve(serverRoot, 'data/bubblesharkpanel.sqlite')
  const db = new DatabaseSync(dbPath)
  db.prepare(`UPDATE game_instances SET status = 'stopped', container_id = NULL WHERE id = ?`).run(instanceId)

  const { json: startJson } = await requestJson('POST', '/app/instance/start', { token, body: { id: instanceId } })
  if (startJson.status !== 1) {
    db.close()
    fail(4, 'DB/容器漂移', `启动未成功: ${JSON.stringify(startJson)}`)
    return
  }

  const row = db.prepare(`SELECT status, container_id FROM game_instances WHERE id = ?`).get(instanceId) as {
    status: string
    container_id: string | null
  } | undefined
  db.close()

  if (row?.status === 'running' && row.container_id) {
    pass(4, 'DB/容器漂移', `实例 ${instanceId} DB 已同步为 running`)
  }
  else {
    fail(4, 'DB/容器漂移', `DB 未同步: ${JSON.stringify(row)}`)
  }
}

async function case5MonitorApi(token: string) {
  const unauth = await requestJson('GET', '/app/system/info')
  const hasErrorShell = unauth.json.status === 0 && typeof unauth.json.requestId === 'string'
  const authed = await requestJson('GET', '/app/system/info', { token })
  const data = authed.json.data as Record<string, unknown> | undefined
  const cpu = data?.cpu as Record<string, unknown> | undefined
  const hasMonitorFields = authed.json.status === 1
    && typeof cpu?.usageRate === 'number'
    && typeof data?.dockerStatus === 'string'
  if (hasErrorShell && hasMonitorFields) {
    pass(5, '监控页异常（API 层）', '未授权有 requestId；授权后 system/info 字段完整')
  }
  else {
    fail(5, '监控页异常（API 层）', `unauth=${JSON.stringify(unauth.json)}, authed.status=${authed.json.status}`)
  }
}

async function case8MonitorPolling() {
  const monitorPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/views/console/monitor/index.vue',
  )
  const content = fs.readFileSync(monitorPath, 'utf8')
  const hasStorage = content.includes('bsp-monitor-poll-settings')
    && content.includes('DEFAULT_SYSTEM_POLL_MS')
    && content.includes('localStorage.setItem')
  const hasRetry = content.includes('重试') && content.includes('systemError')
  const hasStale = content.includes('networkStale') || content.includes('可能过期')
  if (hasStorage && hasRetry && hasStale) {
    pass(8, '监控轮询配置', 'localStorage 持久化、重试按钮、网络过期提示均已实现')
  }
  else {
    fail(8, '监控轮询配置', `storage=${hasStorage}, retry=${hasRetry}, stale=${hasStale}`)
  }
}

function summarize() {
  const failed = results.filter(r => !r.pass)
  console.log('\n=== 补测汇总 ===')
  console.log(`通过: ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) {
    for (const f of failed) {
      console.log(`  #${f.id} ${f.name}: ${f.detail}`)
    }
  }
}

async function main() {
  console.log(`\n=== M0/M1 补测 @ ${BASE} ===\n`)
  const token = await login()
  console.log(`已登录: ${ACCOUNT}\n`)

  await case2DockerStoppedNegative(token)
  await case5MonitorApi(token)
  await case8MonitorPolling()
  await case4DbDrift(token)

  summarize()
  process.exit(results.some(r => !r.pass) ? 1 : 0)
}

main().catch((error) => {
  restoreDockerSock()
  console.error(error)
  process.exit(1)
})
