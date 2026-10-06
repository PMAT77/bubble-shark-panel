import { readBrandEnv } from '../../shared/brand-env'
/**
 * dev:compose 前置：若本地无 SteamCMD 镜像则 pull（幂等）。
 * 拉取失败时不阻塞 compose 启动（实例安装前仍会检测镜像）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function loadPanelEnvFile() {
  const panelEnvPath = path.join(repoRoot, 'panel.env')
  if (!fs.existsSync(panelEnvPath)) {
    return
  }
  for (const line of fs.readFileSync(panelEnvPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const eq = trimmed.indexOf('=')
    if (eq <= 0) {
      continue
    }
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}

loadPanelEnvFile()

// 兜底默认值必须与其它镜像引用（compose、panel.env.example、配置默认值）保持同一版本；
// 这里曾长期停在 v0.2.0，而它又不在发布校验的扫描清单里，于是没人发现。
const image = readBrandEnv('BSP_STEAMCMD_IMAGE')?.trim() || 'ghcr.io/pmat77/bubblesharkpanel:v0.15.4'
const FALLBACK_IMAGE = 'cm2network/steamcmd:steam-bookworm'

function imageExists(target: string): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', target], { stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
}

function pullOnce(target: string) {
  execFileSync('docker', ['pull', target], { stdio: 'inherit' })
}

function main() {
  if (imageExists(image)) {
    console.log(`[ensure-steamcmd-image] 已存在: ${image}`)
    return
  }

  console.log(`[ensure-steamcmd-image] 拉取: ${image}`)
  try {
    pullOnce(image)
    console.log(`[ensure-steamcmd-image] 完成: ${image}`)
    return
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[ensure-steamcmd-image] 拉取失败: ${image}`)
    console.warn(`[ensure-steamcmd-image] ${message}`)
  }

  if (image !== FALLBACK_IMAGE && imageExists(FALLBACK_IMAGE)) {
    console.warn(`[ensure-steamcmd-image] 将使用本地已有镜像 ${FALLBACK_IMAGE}（可在 panel.env 设置 BSP_STEAMCMD_IMAGE）`)
    return
  }

  console.warn('[ensure-steamcmd-image] SteamCMD 镜像未就绪，compose 仍会继续启动；请在实例页拉取镜像或配置 BSP_STEAMCMD_IMAGE')
}

main()
