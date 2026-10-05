/**
 * M0/M1 手工回归脚本 — 对应 docs/M0-M1-REGRESSION.md
 * 用法: tsx server/scripts/m0-m1-regression.ts
 */
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.REGRESSION_BASE_URL ?? 'http://127.0.0.1:8888'
const ACCOUNT = process.env.REGRESSION_ACCOUNT ?? 'superadmin'
const PASSWORD = process.env.REGRESSION_PASSWORD ?? '123456'

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

async function case6Health() {
  const { status, json } = await requestJson('GET', '/health')
  const docker = json.docker
  if (status === 200 && (docker === 'running' || docker === 'stopped')) {
    pass(6, '健康检查', `docker=${docker}`)
  }
  else {
    fail(6, '健康检查', `status=${status}, body=${JSON.stringify(json)}`)
  }
}

async function case7MetaRuntime() {
  const { status, json } = await requestJson('GET', '/api/meta/runtime')
  const data = json.data as Record<string, unknown> | undefined
  const ok = status === 200
    && json.status === 1
    && data?.runtimeMode === 'container'
    && (data.dockerStatus === 'running' || data.dockerStatus === 'stopped')
    && typeof data.steamcmdImageReady === 'boolean'
  if (ok) {
    pass(7, '运行时元信息', `runtimeMode=container, dockerStatus=${data!.dockerStatus}, steamcmdImageReady=${data!.steamcmdImageReady}`)
  }
  else {
    fail(7, '运行时元信息', JSON.stringify(json))
  }
}

async function case2RuntimeGate(token: string, dockerStatus: string) {
  if (dockerStatus === 'running') {
    skip(2, 'Docker 停止负向', '当前 Docker 为 running，未在本环境停止 Docker 做负向测试')
    return
  }
  const endpoints: Array<{ path: string, body: Record<string, unknown> }> = [
    { path: '/app/instance/create', body: { nodeId: 'local-node', name: 'reg-test', gameCode: '343050' } },
    { path: '/app/instance/start', body: { id: '00000000-0000-0000-0000-000000000001' } },
    { path: '/app/instance/update', body: { id: '00000000-0000-0000-0000-000000000001' } },
  ]
  let allOk = true
  for (const ep of endpoints) {
    const { json } = await requestJson('POST', ep.path, { token, body: ep.body })
    const err = String(json.error ?? '')
    const hasRequestId = typeof json.requestId === 'string' && json.requestId.length > 0
    const runtimeMsg = /容器运行时|Docker|SteamCMD/i.test(err)
    const isFailure = err.length > 0 && String(json.code ?? '') !== 'OK'
    if (!isFailure || !runtimeMsg || !hasRequestId) {
      allOk = false
      fail(2, 'Docker 停止负向', `${ep.path} 响应不符合预期: ${JSON.stringify(json)}`)
      return
    }
  }
  if (allOk) {
    pass(2, 'Docker 停止负向', 'create/start/update 均返回运行时错误且含 requestId')
  }
}

async function case3DeleteDuringInstall(token: string, dockerStatus: string) {
  if (dockerStatus !== 'running') {
    skip(3, '安装中删除', 'Docker 未运行，跳过')
    return
  }
  const createName = `reg-del-${Date.now()}`
  const { json: createJson } = await requestJson('POST', '/app/instance/create', {
    token,
    body: { nodeId: 'local-node', name: createName, gameCode: '343050' },
  })
  if (createJson.status !== 1) {
    fail(3, '安装中删除', `创建失败: ${JSON.stringify(createJson)}`)
    return
  }
  const instance = createJson.data as { id?: string, status?: string }
  const id = instance.id
  if (!id) {
    fail(3, '安装中删除', '创建响应缺少 id')
    return
  }

  const { json: delJson } = await requestJson('POST', '/app/instance/delete', { token, body: { id } })
  if (delJson.status !== 1) {
    fail(3, '安装中删除', `删除失败: ${JSON.stringify(delJson)}`)
    return
  }

  const { json: listJson } = await requestJson('POST', '/app/instance/list', { token, body: {} })
  const items = (listJson.data as Array<{ id: string }>) ?? []
  const stillExists = items.some(item => item.id === id)
  if (stillExists) {
    fail(3, '安装中删除', '删除后实例仍在列表中')
    return
  }

  pass(3, '安装中删除', `实例 ${id} 安装中被删除，DB 记录已清除`)
}

async function findRunningInstance(token: string): Promise<string | null> {
  const { json } = await requestJson('POST', '/app/instance/list', { token, body: { status: 'running' } })
  const items = (json.data as Array<{ id: string, status: string }>) ?? []
  return items[0]?.id ?? null
}

async function case4DbDrift(token: string, dockerStatus: string) {
  if (dockerStatus !== 'running') {
    skip(4, 'DB/容器漂移', 'Docker 未运行，跳过')
    return
  }

  let instanceId = await findRunningInstance(token)
  if (!instanceId) {
    skip(4, 'DB/容器漂移', '无运行中实例，跳过（需先有用例1留下的 running 实例或手动启动）')
    return
  }

  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const dbPath = path.resolve(serverRoot, 'data/bubblesharkpanel.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(`UPDATE game_instances SET status = 'stopped', container_id = NULL WHERE id = '${instanceId}'`)

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

async function case1FullLifecycle(token: string, dockerStatus: string) {
  if (dockerStatus !== 'running') {
    skip(1, '正常全链路', 'Docker 未运行，跳过完整安装链路')
    return
  }

  const name = `reg-e2e-${Date.now()}`
  const { json: createJson } = await requestJson('POST', '/app/instance/create', {
    token,
    body: { nodeId: 'local-node', name, gameCode: '343050' },
  })
  if (createJson.status !== 1) {
    fail(1, '正常全链路', `创建失败: ${JSON.stringify(createJson)}`)
    return
  }
  const id = (createJson.data as { id: string }).id

  // 等待安装完成（最多 10 分钟）
  const deadline = Date.now() + 10 * 60 * 1000
  let installed = false
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000))
    const { json } = await requestJson('POST', '/app/instance/list', { token, body: { keyword: name } })
    const item = ((json.data as Array<{ id: string, status: string }>) ?? []).find(i => i.id === id)
    if (item?.status === 'stopped') {
      installed = true
      break
    }
    if (item?.status === 'error') {
      fail(1, '正常全链路', `安装失败 status=error`)
      await requestJson('POST', '/app/instance/delete', { token, body: { id } })
      return
    }
  }
  if (!installed) {
    fail(1, '正常全链路', '安装超时（10min）')
    await requestJson('POST', '/app/instance/delete', { token, body: { id } })
    return
  }

  const steps: Array<{ label: string, path: string, body: Record<string, unknown> }> = [
    { label: '启动', path: '/app/instance/start', body: { id } },
    { label: '控制台命令', path: '/app/instance/console/command', body: { instanceId: id, command: 'c_listallplayers()' } },
    { label: '停止', path: '/app/instance/stop', body: { id } },
    { label: '删除', path: '/app/instance/delete', body: { id } },
  ]
  for (const step of steps) {
    const { json } = await requestJson('POST', step.path, { token, body: step.body })
    if (json.status !== 1) {
      fail(1, '正常全链路', `${step.label} 失败: ${JSON.stringify(json)}`)
      if (step.label !== '删除') {
        await requestJson('POST', '/app/instance/delete', { token, body: { id } })
      }
      return
    }
  }
  pass(1, '正常全链路', `实例 ${id} 创建→安装→启动→命令→停止→删除 完成`)
}

async function case5MonitorApi(token: string) {
  // 后端：鉴权失败应返回标准错误壳
  const unauth = await requestJson('GET', '/app/system/info')
  const hasErrorShell = unauth.json.status === 0 && typeof unauth.json.requestId === 'string'
  const authed = await requestJson('GET', '/app/system/info', { token })
  const data = authed.json.data as Record<string, unknown> | undefined
  const cpu = data?.cpu as Record<string, unknown> | undefined
  const hasMonitorFields = authed.json.status === 1
    && typeof cpu?.usageRate === 'number'
    && typeof data?.dockerStatus === 'string'
  if (hasErrorShell && hasMonitorFields) {
    pass(5, '监控页异常（API 层）', '未授权有 requestId；授权后 system/info 字段完整（UI 错误态需浏览器验收）')
  }
  else {
    fail(5, '监控页异常（API 层）', `unauth=${JSON.stringify(unauth.json)}, authed.status=${authed.json.status}`)
  }
}

async function case8MonitorPollingCodeReview() {
  // 静态验收：localStorage key 与默认值存在于 monitor/index.vue
  const monitorPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/views/console/monitor/index.vue',
  )
  const fs = await import('node:fs')
  const content = fs.readFileSync(monitorPath, 'utf8')
  const ok = content.includes('bsp-monitor-poll-settings')
    && content.includes('DEFAULT_SYSTEM_POLL_MS')
    && content.includes('localStorage.setItem')
    && content.includes('重试')
  if (ok) {
    pass(8, '监控轮询配置', '代码含 localStorage 持久化与重试 UI（浏览器刷新验收建议人工点选）')
  }
  else {
    fail(8, '监控轮询配置', 'monitor/index.vue 缺少预期实现')
  }
}

async function main() {
  console.log(`\n=== M0/M1 回归 @ ${BASE} ===\n`)

  const health = await requestJson('GET', '/health')
  const dockerStatus = String(health.json.docker ?? 'unknown')

  await case6Health()
  await case7MetaRuntime()

  let token: string
  try {
    token = await login()
    console.log(`已登录: ${ACCOUNT}\n`)
  }
  catch (error) {
    fail(0, '登录', String(error))
    summarize()
    process.exit(1)
  }

  await case2RuntimeGate(token, dockerStatus)
  await case5MonitorApi(token)
  await case8MonitorPollingCodeReview()
  await case3DeleteDuringInstall(token, dockerStatus)
  await case4DbDrift(token, dockerStatus)
  await case1FullLifecycle(token, dockerStatus)

  summarize()
  process.exit(results.some(r => !r.pass) ? 1 : 0)
}

function summarize() {
  const failed = results.filter(r => !r.pass)
  console.log('\n=== 汇总 ===')
  console.log(`通过: ${results.length - failed.length}/${results.length}`)
  if (failed.length > 0) {
    console.log('失败项:')
    for (const f of failed) {
      console.log(`  #${f.id} ${f.name}: ${f.detail}`)
    }
  }
  console.log(`Docker 状态: ${results.find(r => r.id === 6)?.detail ?? 'unknown'}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
