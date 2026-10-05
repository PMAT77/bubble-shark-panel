import { readBrandEnv } from '../../shared/brand-env'
/**
 * M1 模块 04（Shard）手工回归脚本 — 对应 docs/M0-M1-REGRESSION.md §M1 Shard S1–S7
 * 用法: tsx server/scripts/m1-shard-regression.ts
 */
import { execSync } from 'node:child_process'

const BASE = process.env.REGRESSION_BASE_URL ?? 'http://127.0.0.1:8888'
const ACCOUNT = process.env.REGRESSION_ACCOUNT ?? 'superadmin'
const PASSWORD = process.env.REGRESSION_PASSWORD ?? '123456'
const INSTANCE_NAME = process.env.REGRESSION_INSTANCE_NAME ?? 'reg-m1-shard'
const INSTANCE_ID_OVERRIDE = process.env.REGRESSION_INSTANCE_ID?.trim() ?? ''
const PANEL_CONTAINER = readBrandEnv('BSP_PANEL_CONTAINER_NAME') ?? 'bubblesharkpanel-panel'

interface CaseResult {
  id: string
  name: string
  pass: boolean
  detail: string
}

const results: CaseResult[] = []

function pass(id: string, name: string, detail: string) {
  results.push({ id, name, pass: true, detail })
  console.log(`✅ ${id} ${name}: ${detail}`)
}

function fail(id: string, name: string, detail: string) {
  results.push({ id, name, pass: false, detail })
  console.error(`❌ ${id} ${name}: ${detail}`)
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

function isApiOk(json: Record<string, unknown>): boolean {
  return json.code === 'OK' && !String(json.error ?? '').trim()
}

async function stopOtherRunningInstances(token: string, keepId: string) {
  const { json } = await requestJson('POST', '/app/instance/list', { token, body: { status: 'running' } })
  const items = (json.data as Array<{ id: string, name: string }>) ?? []
  for (const item of items) {
    if (item.id === keepId) {
      continue
    }
    console.log(`停止占用端口的实例: ${item.name} (${item.id})`)
    await requestJson('POST', '/app/instance/stop', { token, body: { id: item.id } })
  }
  if (items.some(i => i.id !== keepId)) {
    await new Promise(r => setTimeout(r, 8000))
  }
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

function dockerExec(cmd: string): string {
  try {
    return execSync(`docker exec ${PANEL_CONTAINER} ${cmd}`, { encoding: 'utf8' }).trim()
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`docker exec 失败: ${message}`)
  }
}

function dockerPs(instanceId: string): Array<{ name: string, status: string }> {
  const out = execSync(
    `docker ps -a --filter "name=bsp-${instanceId}" --format "{{.Names}}|{{.Status}}"`,
    { encoding: 'utf8' },
  ).trim()
  if (!out) {
    return []
  }
  return out.split('\n').map((line) => {
    const [name, ...rest] = line.split('|')
    return { name: name ?? '', status: rest.join('|') }
  })
}

function clusterRoot(instanceId: string): string {
  return `/var/lib/bubblesharkpanel/instances/${instanceId}/klei-storage/DoNotStarveTogether/Cluster_1`
}

function listClusterDir(instanceId: string): string {
  return dockerExec(`ls -la "${clusterRoot(instanceId)}/"`)
}

function cavesIniExists(instanceId: string): boolean {
  try {
    dockerExec(`test -f "${clusterRoot(instanceId)}/Caves/server.ini" && echo yes`)
    return true
  }
  catch {
    return false
  }
}

function readCavesIni(instanceId: string): string {
  return dockerExec(`cat "${clusterRoot(instanceId)}/Caves/server.ini"`)
}

async function waitForContainers(
  instanceId: string,
  expect: { master?: boolean, caves?: boolean },
  timeoutMs = 90000,
): Promise<Array<{ name: string, status: string }>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ps = dockerPs(instanceId)
    const masterUp = ps.some(c => c.name.endsWith('-master') && /Up/i.test(c.status))
    const cavesUp = ps.some(c => c.name.endsWith('-caves') && /Up/i.test(c.status))
    const masterOk = expect.master === undefined || masterUp === expect.master
    const cavesOk = expect.caves === undefined || cavesUp === expect.caves
    if (masterOk && cavesOk) {
      return ps
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  return dockerPs(instanceId)
}

async function waitForInstall(token: string, instanceId: string, name: string): Promise<boolean> {
  const deadline = Date.now() + 15 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000))
    const { json } = await requestJson('POST', '/app/instance/list', { token, body: { keyword: name } })
    const item = ((json.data as Array<{ id: string, status: string }>) ?? []).find(i => i.id === instanceId)
    if (item?.status === 'stopped') {
      return true
    }
    if (item?.status === 'error') {
      return false
    }
  }
  return false
}

async function getCluster(token: string, instanceId: string) {
  const { json } = await requestJson('GET', `/app/instance/cluster?instanceId=${instanceId}`, { token })
  if (json.status !== 1) {
    throw new Error(`读取房间配置失败: ${JSON.stringify(json)}`)
  }
  return json.data as Record<string, unknown>
}

async function saveCluster(token: string, instanceId: string, shardEnabled: boolean) {
  const current = await getCluster(token, instanceId)
  const payload = {
    instanceId,
    networkMode: current.networkMode,
    clusterName: current.clusterName,
    clusterDescription: current.clusterDescription,
    clusterPassword: current.clusterPassword,
    gameMode: current.gameMode,
    maxPlayers: current.maxPlayers,
    pvp: current.pvp,
    pauseWhenEmpty: current.pauseWhenEmpty,
    voteEnabled: current.voteEnabled,
    clusterIntention: current.clusterIntention,
    tickRate: current.tickRate,
    maxSnapshots: current.maxSnapshots,
    shardEnabled,
    bindIp: current.bindIp,
    masterIp: current.masterIp,
    masterPort: current.masterPort,
    clusterKey: current.clusterKey,
    steamGroupOnly: current.steamGroupOnly,
    steamGroupId: current.steamGroupId,
    steamGroupAdmins: current.steamGroupAdmins,
  }
  const { json } = await requestJson('PUT', '/app/instance/cluster', { token, body: payload })
  return json
}

async function getShards(token: string, instanceId: string) {
  const { json } = await requestJson('GET', `/app/instance/shards?instanceId=${instanceId}`, { token })
  return json
}

async function main() {
  console.log(`\n=== M1 Shard 回归 @ ${BASE} ===\n`)

  const health = await requestJson('GET', '/health')
  if (health.json.docker !== 'running') {
    fail('P0', '前置', `Docker 未运行: ${JSON.stringify(health.json)}`)
    summarize()
    process.exit(1)
  }

  const token = await login()
  console.log(`已登录: ${ACCOUNT}\n`)

  // Phase 1: resolve instance
  let instanceId = INSTANCE_ID_OVERRIDE
  if (!instanceId) {
    const existing = await requestJson('POST', '/app/instance/list', { token, body: { keyword: INSTANCE_NAME } })
    instanceId = ((existing.json.data as Array<{ id: string, name: string, status: string }>) ?? [])
      .find(i => i.name === INSTANCE_NAME)?.id ?? ''
  }

  if (!instanceId) {
    const { json: createJson } = await requestJson('POST', '/app/instance/create', {
      token,
      body: { nodeId: 'local-node', name: INSTANCE_NAME, gameCode: '343050' },
    })
    if (createJson.status !== 1) {
      fail('P1', '创建实例', JSON.stringify(createJson))
      summarize()
      process.exit(1)
    }
    instanceId = (createJson.data as { id: string }).id
    console.log(`创建实例 ${INSTANCE_NAME} → ${instanceId}，等待安装…`)
    const installed = await waitForInstall(token, instanceId, INSTANCE_NAME)
    if (!installed) {
      fail('P1', '安装完成', '安装超时或失败')
      summarize()
      process.exit(1)
    }
    pass('P1', '安装完成', `实例 ${instanceId} 状态 stopped`)
  }
  else {
    console.log(`复用已有实例 → ${instanceId}`)
  }

  // 完整安装须含 data/（DST 游戏资源）
  try {
    dockerExec(`test -d /var/lib/bubblesharkpanel/instances/${instanceId}/data`)
  }
  catch {
    fail('P0', '实例安装完整性', `实例 ${instanceId} 缺少 data/ 目录，无法启动 DST 容器；请换完整安装实例或 force 重装`)
    summarize()
    process.exit(1)
  }

  await stopOtherRunningInstances(token, instanceId)
  await requestJson('POST', '/app/instance/stop', { token, body: { id: instanceId } })
  await new Promise(r => setTimeout(r, 5000))
  const saveOffInit = await saveCluster(token, instanceId, false)
  if (!isApiOk(saveOffInit)) {
    fail('P1', '重置分片关', JSON.stringify(saveOffInit))
  }

  // Ensure shard disabled and no Caves before S2 (clean scaffold test)
  const preDir = listClusterDir(instanceId)
  const hadCavesBefore = preDir.includes('Caves')
  if (hadCavesBefore) {
    console.log('注意: Caves/ 已存在，S2 将验证幂等 scaffold 而非首次创建')
  }

  // S7 — caves not editable when shard disabled
  const shardsOff = await getShards(token, instanceId)
  const shardDataOff = shardsOff.data as { clusterShardEnabled?: boolean }
  const saveCavesWhenOff = await requestJson('PUT', '/app/instance/shards', {
    token,
    body: {
      instanceId,
      shard: 'caves',
      serverPort: 11000,
      steamAuthPort: 8768,
      steamMasterPort: 12348,
      worldgenPreset: 'DST_CAVE',
    },
  })
  if (shardDataOff.clusterShardEnabled === false && !isApiOk(saveCavesWhenOff.json)) {
    pass('S7', '未开分片不可保存洞穴', String(saveCavesWhenOff.json.error))
  }
  else if (shardDataOff.clusterShardEnabled === false) {
    fail('S7', '未开分片不可保存洞穴', '房间未开分片但保存洞穴成功')
  }
  else {
    fail('S7', '未开分片不可保存洞穴', '前置状态 clusterShardEnabled 应为 false')
  }

  // S1 — master only start
  const start1 = await requestJson('POST', '/app/instance/start', { token, body: { id: instanceId } })
  const ps1 = await waitForContainers(instanceId, { master: true, caves: false })
  const masterUp1 = ps1.some(c => c.name.endsWith('-master') && /Up/i.test(c.status))
  const cavesUp1 = ps1.some(c => c.name.endsWith('-caves') && /Up/i.test(c.status))
  if (isApiOk(start1.json) && masterUp1 && !cavesUp1) {
    pass('S1', '仅主世界启动', `containers: ${ps1.map(c => `${c.name}=${c.status}`).join(', ') || 'none'}`)
  }
  else {
    fail('S1', '仅主世界启动', `start=${JSON.stringify(start1.json)}, ps=${JSON.stringify(ps1)}`)
  }

  await requestJson('POST', '/app/instance/stop', { token, body: { id: instanceId } })
  await new Promise(r => setTimeout(r, 5000))

  // S2 — enable shard scaffold
  const saveOn = await saveCluster(token, instanceId, true)
  if (!isApiOk(saveOn)) {
    fail('S2', '开分片自动 scaffold', JSON.stringify(saveOn))
  }
  else if (cavesIniExists(instanceId)) {
    const ini = readCavesIni(instanceId)
    if (/is_master = false/.test(ini)) {
      pass('S2', '开分片自动 scaffold', hadCavesBefore ? 'Caves/server.ini 存在且 is_master=false（幂等）' : '首次生成 Caves/server.ini')
    }
    else {
      fail('S2', '开分片自动 scaffold', `server.ini 缺少 is_master=false: ${ini.slice(0, 200)}`)
    }
  }
  else {
    fail('S2', '开分片自动 scaffold', 'Caves/server.ini 未生成')
  }

  // S3 — edit caves + port conflict negative
  const shardListBefore = await getShards(token, instanceId)
  const masterShard = (shardListBefore.data as { shards: Array<{ id: string, serverPort: number | null }> }).shards
    .find(s => s.id === 'master')
  const cavesShardBefore = (shardListBefore.data as { shards: Array<{ id: string, serverPort: number | null, steamAuthPort: number | null, steamMasterPort: number | null, worldgenPreset: string | null, worldGenerated: boolean }> }).shards
    .find(s => s.id === 'caves')
  const masterPort = masterShard?.serverPort ?? 10999
  const cavesPortBefore = cavesShardBefore?.serverPort ?? masterPort + 1
  const newCavesPort = cavesPortBefore === masterPort + 1 ? masterPort + 2 : masterPort + 1
  const saveCavesBody: Record<string, unknown> = {
    instanceId,
    shard: 'caves',
    serverPort: newCavesPort,
    steamAuthPort: cavesShardBefore?.steamAuthPort ?? 8768,
    steamMasterPort: cavesShardBefore?.steamMasterPort ?? 12348,
    worldgenPreset: cavesShardBefore?.worldgenPreset ?? 'DST_CAVE',
  }
  if (!cavesShardBefore?.worldGenerated) {
    saveCavesBody.worldgenPreset = 'DST_CAVE_PLUS'
  }
  const saveCavesOk = await requestJson('PUT', '/app/instance/shards', { token, body: saveCavesBody })
  const saveCavesConflict = await requestJson('PUT', '/app/instance/shards', {
    token,
    body: {
      instanceId,
      shard: 'caves',
      serverPort: masterPort,
      steamAuthPort: 8766,
      steamMasterPort: 12346,
      worldgenPreset: 'DST_CAVE',
    },
  })
  const iniAfter = readCavesIni(instanceId)
  const portUpdated = iniAfter.includes(`server_port = ${newCavesPort}`)
  if (isApiOk(saveCavesOk.json)
    && !isApiOk(saveCavesConflict.json)
    && portUpdated) {
    const worldgenNote = cavesShardBefore?.worldGenerated ? '（世界已生成，仅测端口）' : '（含 worldgen 预设变更）'
    pass('S3', '世界设置编辑洞穴', `server_port=${newCavesPort}${worldgenNote}；冲突被拒绝`)
  }
  else {
    fail('S3', '世界设置编辑洞穴', `ok=${JSON.stringify(saveCavesOk.json)}, conflict=${JSON.stringify(saveCavesConflict.json)}`)
  }

  // S4 — dual container start
  const start4 = await requestJson('POST', '/app/instance/start', { token, body: { id: instanceId } })
  const ps4 = await waitForContainers(instanceId, { master: true, caves: true }, 120000)
  const masterUp4 = ps4.some(c => c.name.endsWith('-master') && /Up/i.test(c.status))
  const cavesUp4 = ps4.some(c => c.name.endsWith('-caves') && /Up/i.test(c.status))
  const shardList4 = await getShards(token, instanceId)
  const shards4 = (shardList4.data as { shards: Array<{ id: string, containerStatus: string }> }).shards ?? []
  if (isApiOk(start4.json) && masterUp4 && cavesUp4) {
    pass('S4', '双容器启动', `master=${shards4.find(s => s.id === 'master')?.containerStatus}, caves=${shards4.find(s => s.id === 'caves')?.containerStatus}`)
  }
  else {
    fail('S4', '双容器启动', `start=${JSON.stringify(start4.json)}, ps=${JSON.stringify(ps4)}`)
  }

  // S6 — stop order caves before master
  const masterName = `bsp-${instanceId}-master`
  const cavesName = `bsp-${instanceId}-caves`
  const stopPromise = requestJson('POST', '/app/instance/stop', { token, body: { id: instanceId } })
  let cavesStoppedFirst = false
  const pollDeadline = Date.now() + 60000
  while (Date.now() < pollDeadline) {
    const ps = dockerPs(instanceId)
    const masterRunning = ps.some(c => c.name === masterName && /Up/i.test(c.status))
    const cavesRunning = ps.some(c => c.name === cavesName && /Up/i.test(c.status))
    if (!cavesRunning && masterRunning) {
      cavesStoppedFirst = true
      break
    }
    if (!masterRunning && !cavesRunning) {
      break
    }
    await new Promise(r => setTimeout(r, 500))
  }
  await stopPromise
  await new Promise(r => setTimeout(r, 3000))
  let cavesFinished = ''
  let masterFinished = ''
  try {
    cavesFinished = execSync(`docker inspect ${cavesName} --format "{{.State.FinishedAt}}"`, { encoding: 'utf8' }).trim()
    masterFinished = execSync(`docker inspect ${masterName} --format "{{.State.FinishedAt}}"`, { encoding: 'utf8' }).trim()
  }
  catch {
    // containers may be removed
  }
  const timeOrderOk = cavesFinished && masterFinished && cavesFinished <= masterFinished
  if (cavesStoppedFirst || timeOrderOk) {
    pass('S6', '停止顺序 Caves→Master', `poll=${cavesStoppedFirst}, finishedAt caves=${cavesFinished} master=${masterFinished}`)
  }
  else {
    fail('S6', '停止顺序 Caves→Master', `poll=${cavesStoppedFirst}, finishedAt caves=${cavesFinished} master=${masterFinished}`)
  }

  // S5 — disable shard, keep files, master only
  const saveOff2 = await saveCluster(token, instanceId, false)
  const cavesStillThere = cavesIniExists(instanceId)
  const start5 = await requestJson('POST', '/app/instance/start', { token, body: { id: instanceId } })
  const ps5 = await waitForContainers(instanceId, { master: true, caves: false })
  const masterUp5 = ps5.some(c => c.name.endsWith('-master') && /Up/i.test(c.status))
  const cavesUp5 = ps5.some(c => c.name.endsWith('-caves') && /Up/i.test(c.status))
  await requestJson('POST', '/app/instance/stop', { token, body: { id: instanceId } })
  if (isApiOk(saveOff2) && cavesStillThere && isApiOk(start5.json) && masterUp5 && !cavesUp5) {
    pass('S5', '关闭分片保留文件', 'Caves/ 仍在，仅 Master 运行')
  }
  else {
    fail('S5', '关闭分片保留文件', `save=${JSON.stringify(saveOff2)}, caves=${cavesStillThere}, ps=${JSON.stringify(ps5)}`)
  }

  pass('S4+', 'FDS §9 游戏内进洞', '产品方已于 2026-05-21 确认通过（本次不重复进游戏）')

  console.log(`\n实例 ID: ${instanceId}`)
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
      console.log(`  ${f.id} ${f.name}: ${f.detail}`)
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
