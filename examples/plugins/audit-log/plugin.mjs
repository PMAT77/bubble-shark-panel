#!/usr/bin/env node
/**
 * 操作审计日志（Pro 插件）。
 *
 * 面板本身已经能查操作审计（左侧菜单「插件」页下方，以及 `/app/system/audit/operations` 接口），
 * 这个插件解决的是**留存与交付**：
 * 1. 按天归档成可交付的文件（NDJSON / CSV），便于交给客户、审计方或长期保存；
 * 2. 可选推送到远端（WebDAV / 目录），与存档备份分开——审计不该和存档存在同一块盘上；
 * 3. 发现敏感操作（删除备份、重置世界、踢人封禁、改配置等）时告警。
 *
 * 为什么不做成"只读列表"：面板里已经能看列表，插件再做一遍没有价值；
 * 审计的真实痛点是**留存**——面板的审计文件有保留上限，超出后会丢最旧的记录。
 *
 * 配置：同目录 `config.json`（不存在时自动生成）。能力：operations:read / network:outbound / storage:kv。
 * 商业插件：需要 `plugin.signature.json`，且授权需包含 `audit-log`。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const pluginId = process.env.BSP_PLUGIN_ID ?? process.env.GSH_PLUGIN_ID ?? ''
const baseUrl = process.env.BSP_CAPABILITY_URL ?? process.env.GSH_CAPABILITY_URL ?? ''
const token = process.env.BSP_PLUGIN_TOKEN ?? process.env.GSH_PLUGIN_TOKEN ?? ''
const pluginDir = process.env.BSP_PLUGIN_DIR ?? process.env.GSH_PLUGIN_DIR ?? process.cwd()
const configPath = path.join(pluginDir, 'config.json')
const statePath = path.join(pluginDir, 'state.json')
const archiveDir = path.join(pluginDir, 'archive')

const DEFAULT_CONFIG = {
  // 每隔多少秒拉取一次审计并归档
  intervalSeconds: 300,
  // 每次最多拉取多少条
  fetchLimit: 500,
  // 归档格式：ndjson | csv
  format: 'ndjson',
  // 关注的敏感操作（路径包含这些片段就告警）
  sensitivePathPatterns: [
    '/app/instance/backup/delete',
    '/app/instance/delete',
    '/app/instance/shards/reset',
    '/app/instance/backup/restore',
    '/app/instance/player',
    '/app/system/plugins/toggle',
    '/app/account/password',
  ],
  // 告警 webhook（POST JSON）；留空则不告警
  alertWebhook: '',
  // 归档后是否推送到远端目录（与存档备份分开的盘更稳）
  remoteDir: '',
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8')
    log(`已生成默认配置：${configPath}`)
    return { ...DEFAULT_CONFIG }
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }
  }
  catch (error) {
    log(`配置文件无法解析：${error instanceof Error ? error.message : String(error)}`)
    return { ...DEFAULT_CONFIG }
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))
  }
  catch {
    return { lastSeenId: 0, written: 0, lastRunAt: null, lastError: null }
  }
}

function saveState(state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

async function callCapability(pathname, body = {}) {
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bsp-plugin-token': token },
      body: JSON.stringify({ pluginId, ...body }),
    })
    let payload = null
    try {
      payload = await response.json()
    }
    catch {
      payload = null
    }
    return { status: response.status, payload, error: null }
  }
  catch (error) {
    /**
     * 网络层失败（宿主能力服务不可达、被防火墙拦掉等）不该让整个插件崩掉：
     * 返回结构化的错误，让调用方把原因写进 state.json 并告警，而不是抛出去变成一次"崩溃"。
     */
    return {
      status: 0,
      payload: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function toCsv(records) {
  const columns = ['at', 'account', 'method', 'path', 'outcome', 'statusCode', 'durationMs', 'requestId', 'params']
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value)
    return `"${text.replace(/"/g, '""')}"`
  }
  const lines = [columns.join(',')]
  for (const record of records) {
    lines.push(columns.map(column => escape(column === 'params' ? JSON.stringify(record.params ?? {}) : record[column])).join(','))
  }
  return `${lines.join('\n')}\n`
}

/** 按天归档：文件名用 UTC 日期，避免跨时区交付时对不上 */
function archivePathFor(record, format) {
  const day = String(record.at ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10)
  return path.join(archiveDir, `${day}.${format}`)
}

function appendRecords(records, format) {
  const touched = new Set()
  for (const record of records) {
    const filePath = archivePathFor(record, format)
    const line = format === 'csv'
      ? toCsv([record]).split('\n').slice(1).join('\n')
      : `${JSON.stringify(record)}\n`
    const needsHeader = format === 'csv' && !fs.existsSync(filePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.appendFileSync(filePath, needsHeader ? toCsv([]).trimEnd() + '\n' + line : line, 'utf8')
    touched.add(filePath)
  }
  return [...touched]
}

/** 推送到远端目录：先写临时名再改名，避免远端出现半个文件 */
function pushToRemote(files, remoteDir) {
  let pushed = 0
  for (const filePath of files) {
    const destination = path.join(remoteDir, path.basename(filePath))
    const temporary = `${destination}.part`
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(filePath, temporary)
    fs.renameSync(temporary, destination)
    pushed += 1
  }
  return pushed
}

async function sendAlert(config, payload) {
  if (!config.alertWebhook) {
    return
  }
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const response = await fetch(config.alertWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'pro-audit-log', at: new Date().toISOString(), ...payload }),
      signal: controller.signal,
    })
    void response
    clearTimeout(timeout)
  }
  catch (error) {
    log(`告警发送失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function runOnce(config, state) {
  const response = await callCapability('/capabilities/operations', { limit: config.fetchLimit })
  if (response.status !== 200) {
    const detail = response.error ?? response.payload?.error ?? ''
    return {
      ok: false,
      message: `读取操作审计失败：${response.status === 0 ? '无法连接宿主能力服务' : `HTTP ${response.status}`}${detail ? `（${detail}）` : ''}`,
      written: 0,
    }
  }
  const all = Array.isArray(response.payload?.data?.records) ? response.payload.data.records : []
  // 只归档上一次之后的新记录：宿主侧的记录里 id 递增，用 id 做游标最稳
  const fresh = all.filter(record => Number(record.id) > Number(state.lastSeenId ?? 0)).reverse()
  if (fresh.length === 0) {
    return { ok: true, message: '没有新的审计记录', written: 0, sensitive: 0 }
  }

  const format = config.format === 'csv' ? 'csv' : 'ndjson'
  const files = appendRecords(fresh, format)
  state.lastSeenId = Math.max(...fresh.map(record => Number(record.id) || 0))
  state.written = Number(state.written ?? 0) + fresh.length

  let pushed = 0
  if (config.remoteDir) {
    try {
      pushed = pushToRemote(files, config.remoteDir)
    }
    catch (error) {
      return {
        ok: false,
        message: `归档已写入本机，但推送到远端失败：${error instanceof Error ? error.message : String(error)}`,
        written: fresh.length,
        sensitive: 0,
      }
    }
  }

  // 敏感操作告警：被拒的写操作也算——那是安全事件
  const patterns = Array.isArray(config.sensitivePathPatterns) ? config.sensitivePathPatterns : []
  const sensitive = fresh.filter(record =>
    record.outcome !== 'ok' || patterns.some(pattern => String(record.path ?? '').includes(pattern)),
  )
  for (const record of sensitive.slice(0, 20)) {
    await sendAlert(config, {
      level: record.outcome === 'ok' ? 'info' : 'warn',
      message: `${record.account ?? '未登录'} ${record.method} ${record.path}（${record.outcome}，HTTP ${record.statusCode}）`,
      record: { at: record.at, account: record.account, path: record.path, outcome: record.outcome },
    })
  }

  return {
    ok: true,
    message: `归档 ${fresh.length} 条到 ${files.length} 个文件${pushed > 0 ? `，推送 ${pushed} 个` : ''}，其中敏感操作 ${sensitive.length} 条`,
    written: fresh.length,
    sensitive: sensitive.length,
  }
}

async function main() {
  if (!pluginId || !baseUrl || !token) {
    log('缺少宿主注入的环境变量：插件必须由面板启动')
    process.exit(1)
  }
  const config = loadConfig()
  const state = loadState()
  let running = false
  let stopping = false

  async function tick() {
    if (running || stopping) {
      return
    }
    running = true
    try {
      const result = await runOnce(config, state)
      state.lastRunAt = new Date().toISOString()
      state.lastError = result.ok ? null : result.message
      state.lastResult = result.message
      saveState(state)
      log(result.ok ? `本轮完成：${result.message}` : `本轮有失败：${result.message}`)
      if (!result.ok) {
        await sendAlert(config, { level: 'error', message: result.message })
      }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      state.lastRunAt = new Date().toISOString()
      state.lastError = message
      saveState(state)
      log(`本轮异常：${message}`)
    }
    finally {
      running = false
    }
  }

  const intervalMs = Math.max(60, Number(config.intervalSeconds) || 300) * 1000
  log(`操作审计插件已启动：每 ${Math.round(intervalMs / 1000)} 秒归档一次，归档目录 ${archiveDir}`)
  await tick()
  const timer = setInterval(() => { void tick() }, intervalMs)

  const shutdown = () => {
    stopping = true
    clearInterval(timer)
    log('收到停止信号，操作审计插件退出')
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// 仅在作为插件进程直接运行时启动循环（被测试 import 时不启动）
if (process.argv[1] && process.argv[1].endsWith('plugin.mjs')) {
  main().catch((error) => {
    log(`插件启动失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
