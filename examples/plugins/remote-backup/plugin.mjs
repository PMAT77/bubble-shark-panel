#!/usr/bin/env node
/**
 * 异地与云备份（Pro 插件）。
 *
 * 做的事：定时检查本机是否有新存档备份 → 上传到远端（WebDAV / 对象存储预签名 PUT /
 * 另一台机器的共享目录）→ 按保留份数清理**远端** → 失败时发告警，并把状态写到本目录。
 *
 * 几个刻意的取舍：
 * - **只删远端，不删本机备份**：本机备份是回滚用的最后一道防线，清理策略留给面板自己。
 *   插件动本机的存档文件风险太高，收益却只是省点磁盘。
 * - **流式上传**：备份包动辄几百 MB，整包读进内存会在小内存机器上被 OOM 杀掉。
 * - **状态写在插件目录**：`state.json` 记录每个备份的上传结果，避免重复上传；
 *   面板的「插件」页显示的进程状态与这里的日志配合，就能回答"它到底跑没跑、传没传成功"。
 *
 * 配置：与本文件同目录的 `config.json`（不存在时会自动生成一份带注释说明的默认配置）。
 * 能力：清单里声明了 backups:read / backups:write / backups:delete / network:outbound / storage:kv。
 * 商业插件必须有签名（plugin.signature.json）；缺签名或授权不含 remote-backup 时无法启用。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createReadStream } from 'node:fs'

const pluginId = process.env.BSP_PLUGIN_ID ?? process.env.GSH_PLUGIN_ID ?? ''
const baseUrl = process.env.BSP_CAPABILITY_URL ?? process.env.GSH_CAPABILITY_URL ?? ''
const token = process.env.BSP_PLUGIN_TOKEN ?? process.env.GSH_PLUGIN_TOKEN ?? ''
const pluginDir = process.env.BSP_PLUGIN_DIR ?? process.env.GSH_PLUGIN_DIR ?? process.cwd()
const configPath = path.join(pluginDir, 'config.json')
const statePath = path.join(pluginDir, 'state.json')

const DEFAULT_CONFIG = {
  // 每隔多少秒检查一次是否有新备份需要上传
  intervalSeconds: 900,
  // 远端保留多少份备份（按时间从新到旧）；设为 0 表示不清理
  keepRemote: 7,
  // 上传目标：webdav | http-put | directory
  target: {
    kind: 'webdav',
    // WebDAV 目录地址（kind=webdav 时使用），例如 https://dav.example.com/bsp-backups
    url: '',
    // http-put：每次上传 PUT 到这个地址（通常是对象存储的预签名 URL 模板），{name} 会替换为文件名
    putUrlTemplate: '',
    // directory：另一台机器挂载过来的目录（NFS / SMB / 移动硬盘）
    dir: '',
    username: '',
    password: '',
  },
  // 上传完成后是否让面板再创建一次新备份（true 时形成"备份→上传"的滚雪球循环，谨慎开启）
  createBackupBeforeUpload: false,
  // 告警 webhook（POST JSON）；留空则不告警
  alertWebhook: '',
  requestTimeoutSeconds: 600,
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8')
    log(`已生成默认配置：${configPath}。请填写 target 后重启插件（在面板里停用再启用）。`)
    return null
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }
  }
  catch (error) {
    log(`配置文件无法解析：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))
  }
  catch {
    return { uploaded: {}, lastRunAt: null, lastError: null }
  }
}

function saveState(state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

async function callCapability(pathname, body = {}) {
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
  return { status: response.status, payload }
}

function basicAuthHeader(target) {
  if (!target.username) {
    return {}
  }
  const raw = `${target.username}:${target.password ?? ''}`
  return { authorization: `Basic ${Buffer.from(raw, 'utf8').toString('base64')}` }
}

function joinUrl(base, name) {
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(name)}`
}

/** 流式上传到 WebDAV / 预签名地址；大文件不整包读进内存 */
async function uploadViaHttp(filePath, target, config, url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutSeconds * 1000)
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'content-type': 'application/gzip',
        ...basicAuthHeader(target),
      },
      body: createReadStream(filePath),
      duplex: 'half',
      signal: controller.signal,
    })
    return { ok: response.ok, status: response.status, message: response.ok ? null : `HTTP ${response.status}` }
  }
  catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) }
  }
  finally {
    clearTimeout(timeout)
  }
}

/** 复制到另一台机器挂载过来的目录（NFS / SMB / 移动硬盘） */
async function uploadViaDirectory(filePath, target, fileName) {
  if (!target.dir) {
    return { ok: false, status: 0, message: 'target.dir 未配置' }
  }
  try {
    fs.mkdirSync(target.dir, { recursive: true })
    const destination = path.join(target.dir, fileName)
    // 先写临时名再改名：中途失败不会在远端留下一个"看起来完整"的半个包
    const temporary = `${destination}.part`
    await new Promise((resolve, reject) => {
      const read = createReadStream(filePath)
      const write = fs.createWriteStream(temporary)
      read.on('error', reject)
      write.on('error', reject)
      write.on('close', resolve)
      read.pipe(write)
    })
    fs.renameSync(temporary, destination)
    return { ok: true, status: 200, message: null }
  }
  catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 远端是否已经有这个文件（WebDAV 用 HEAD，目录目标用 stat） */
async function remoteExists(target, fileName) {
  try {
    if (target.kind === 'directory') {
      return fs.existsSync(path.join(target.dir, fileName))
    }
    if (target.kind === 'webdav' && target.url) {
      const response = await fetch(joinUrl(target.url, fileName), {
        method: 'HEAD',
        headers: basicAuthHeader(target),
      })
      return response.ok
    }
  }
  catch {
    return false
  }
  return false
}

async function deleteRemote(target, fileName) {
  try {
    if (target.kind === 'directory') {
      const filePath = path.join(target.dir, fileName)
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true })
        return true
      }
      return false
    }
    if (target.kind === 'webdav' && target.url) {
      const response = await fetch(joinUrl(target.url, fileName), {
        method: 'DELETE',
        headers: basicAuthHeader(target),
      })
      return response.ok
    }
  }
  catch {
    return false
  }
  return false
}

async function sendAlert(config, payload) {
  if (!config.alertWebhook) {
    return
  }
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    await fetch(config.alertWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'pro-remote-backup', at: new Date().toISOString(), ...payload }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
  }
  catch (error) {
    log(`告警发送失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function runOnce(config, state) {
  // 1. 取本机备份列表
  const list = await callCapability('/capabilities/backups')
  if (list.status !== 200) {
    return { ok: false, message: `读取备份列表失败：HTTP ${list.status} ${list.payload?.error ?? ''}` }
  }
  const backups = (Array.isArray(list.payload?.data) ? list.payload.data : [])
    .filter(item => item.status === 'completed' && item.filePresent && item.sizeBytes > 0)
    .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))

  if (backups.length === 0) {
    return { ok: true, message: '本机还没有可上传的备份（面板里先创建一次备份）', uploaded: 0, removed: 0 }
  }

  // 2. 上传尚未上传的备份（新的优先）
  let uploaded = 0
  const failures = []
  for (const backup of backups) {
    const marker = state.uploaded[backup.id]
    if (marker?.fileName === backup.fileName) {
      if (await remoteExists(config.target, backup.fileName)) {
        continue
      }
      // 状态里有记录但远端没有：可能被清理或上一轮没传完，重传一次
    }
    let result
    if (config.target.kind === 'directory') {
      result = await uploadViaDirectory(backup.filePath, config.target, backup.fileName)
    }
    else if (config.target.kind === 'http-put') {
      const url = String(config.target.putUrlTemplate).replace('{name}', encodeURIComponent(backup.fileName))
      if (!url) {
        return { ok: false, message: 'target.putUrlTemplate 未配置' }
      }
      result = await uploadViaHttp(backup.filePath, config.target, config, url)
    }
    else if (config.target.kind === 'webdav') {
      if (!config.target.url) {
        return { ok: false, message: 'target.url 未配置' }
      }
      result = await uploadViaHttp(backup.filePath, config.target, config, joinUrl(config.target.url, backup.fileName))
    }
    else {
      return { ok: false, message: `不认识的 target.kind：${config.target.kind}` }
    }

    if (result.ok) {
      state.uploaded[backup.id] = { fileName: backup.fileName, at: new Date().toISOString(), sizeBytes: backup.sizeBytes }
      uploaded += 1
      log(`已上传 ${backup.fileName}（${(backup.sizeBytes / 1024 / 1024).toFixed(1)} MiB）`)
    }
    else {
      failures.push(`${backup.fileName}: ${result.message}`)
      log(`上传失败 ${backup.fileName}：${result.message}`)
    }
  }

  // 3. 远端保留策略：只清理远端，本机备份交给面板
  let removed = 0
  if (config.keepRemote > 0) {
    const remoteNames = backups.map(item => item.fileName)
    const stale = remoteNames.slice(config.keepRemote)
    for (const fileName of stale) {
      if (await deleteRemote(config.target, fileName)) {
        removed += 1
        log(`已清理远端旧备份 ${fileName}`)
        for (const [backupId, marker] of Object.entries(state.uploaded)) {
          if (marker.fileName === fileName) {
            delete state.uploaded[backupId]
          }
        }
      }
    }
  }

  if (failures.length > 0) {
    return { ok: false, message: `${failures.length} 个备份上传失败：${failures.slice(0, 3).join('；')}`, uploaded, removed }
  }
  return { ok: true, message: `上传 ${uploaded} 个，清理远端 ${removed} 个`, uploaded, removed }
}

async function main() {
  if (!pluginId || !baseUrl || !token) {
    log('缺少宿主注入的环境变量：插件必须由面板启动')
    process.exit(1)
  }

  const config = loadConfig()
  if (!config) {
    // 首次运行会生成默认配置；退出码 0 表示"正常结束"，宿主不会当成崩溃重启
    process.exit(0)
  }
  if (!config.target?.kind) {
    log('配置里没有 target，无法上传')
    process.exit(0)
  }

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
      await sendAlert(config, { level: 'error', message })
    }
    finally {
      running = false
    }
  }

  const intervalMs = Math.max(60, Number(config.intervalSeconds) || 900) * 1000
  log(`异地备份插件已启动：每 ${Math.round(intervalMs / 1000)} 秒检查一次，远端保留 ${config.keepRemote} 份`)
  await tick()
  const timer = setInterval(() => { void tick() }, intervalMs)

  const shutdown = () => {
    stopping = true
    clearInterval(timer)
    log('收到停止信号，异地备份插件退出')
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error) => {
  log(`插件启动失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
