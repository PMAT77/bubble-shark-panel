#!/usr/bin/env node
/**
 * 示例插件：调用宿主能力并把结果写到自己的目录。
 *
 * 它演示插件开发的全部约定：
 * 1. 从环境变量读取身份、能力服务地址与一次性令牌（**不要硬编码地址**，每次启动端口都不同）；
 * 2. 用 `POST /capabilities/<能力>` 调用宿主，请求头带 `x-bsp-plugin-token`，body 带 `pluginId`；
 * 3. 只能调用清单里声明过的能力，越权会拿到 403 —— 而且**这次尝试会被宿主记进审计**；
 * 4. 处理完就退出（退出码 0 会被记为「已正常退出」，不会触发重启）；
 *    想常驻就用事件循环保持运行，宿主停用时会发 SIGTERM。
 *
 * 安装：把本目录整体复制到面板数据目录下的 `plugins/` 里，然后在左侧菜单「插件」启用。
 * 用法示例见同目录 README.md。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const pluginId = process.env.BSP_PLUGIN_ID ?? process.env.GSH_PLUGIN_ID ?? ''
const baseUrl = process.env.BSP_CAPABILITY_URL ?? process.env.GSH_CAPABILITY_URL ?? ''
const token = process.env.BSP_PLUGIN_TOKEN ?? process.env.GSH_PLUGIN_TOKEN ?? ''
const pluginDir = process.env.BSP_PLUGIN_DIR ?? process.env.GSH_PLUGIN_DIR ?? process.cwd()

function log(message) {
  // 插件的 stdout / stderr 会被宿主流转写到本目录的 plugin.log
  console.log(`[${new Date().toISOString()}] ${message}`)
}

async function callCapability(pathname, body = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bsp-plugin-token': token,
    },
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

async function main() {
  if (!pluginId || !baseUrl || !token) {
    log('缺少宿主注入的环境变量：插件必须由面板启动，不能手工运行')
    process.exit(1)
  }

  const instances = await callCapability('/capabilities/instances')
  if (instances.status !== 200) {
    log(`读取实例失败：HTTP ${instances.status} ${instances.payload?.error ?? ''}`)
    process.exit(1)
  }
  const list = Array.isArray(instances.payload?.data) ? instances.payload.data : []
  log(`读到 ${list.length} 个实例`)

  const running = list.filter(item => item.status === 'running')
  for (const instance of running) {
    log(`实例 ${instance.name}（${instance.id}）正在运行，游戏端口 ${instance.gamePort ?? '未知'}`)
  }

  // 读取自己的调用记录：宿主侧的审计，插件只能读、改不了
  const audit = await callCapability('/capabilities/audit', { limit: 20 })

  const summary = {
    generatedAt: new Date().toISOString(),
    hostApiVersion: process.env.BSP_PLUGIN_API_VERSION ?? process.env.GSH_PLUGIN_API_VERSION ?? null,
    instanceCount: list.length,
    runningInstances: running.map(item => ({ id: item.id, name: item.name, gamePort: item.gamePort ?? null })),
    auditStatus: audit.status,
    recentCalls: Array.isArray(audit.payload?.data?.records)
      ? audit.payload.data.records.map(record => ({
          at: record.at,
          action: record.action,
          outcome: record.outcome,
          durationMs: record.durationMs,
        }))
      : [],
  }

  const target = path.join(pluginDir, 'summary.json')
  fs.writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  log(`结果已写入 ${target}`)
  process.exit(0)
}

process.on('SIGTERM', () => {
  log('收到停止信号，示例插件退出')
  process.exit(0)
})

main().catch((error) => {
  log(`插件执行失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
