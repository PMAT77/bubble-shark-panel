import fs from 'node:fs'
import path from 'node:path'
import { DST_APP_ID } from './constants'
import { findDstServerBinary } from './cluster-config'

export type DstInstallReadinessCode
  = | 'ok'
    | 'missing_install_dir'
    | 'missing_game_files'
    | 'missing_game_data'
    | 'partial_steam_install'

function resolveAppManifestPath(installPath: string): string | null {
  const candidates = [
    path.join(installPath, 'steamapps', `appmanifest_${DST_APP_ID}.acf`),
    path.join(installPath, `appmanifest_${DST_APP_ID}.acf`),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

function hasGameDataDirectory(installPath: string): boolean {
  const dataDir = path.join(installPath, 'data')
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    return false
  }
  return fs.readdirSync(dataDir).length > 0
}

export interface DstInstallReadiness {
  ready: boolean
  code: DstInstallReadinessCode
  message: string
}

export interface DstStartBlockedContext {
  installLogStatus?: string | null
  instanceStatus?: string
  lastError?: string | null
  /**
   * 最近一次失败的环节（`last_error_phase`）。启动/运行期失败（内存不足、端口占用）的
   * 实例同样是 error，把它的原因当"安装未就绪"的说明拼进提示，会把人引去重装服务端文件。
   */
  lastErrorPhase?: 'install' | 'runtime' | null
}

const GAME_FILES_PREFIX = '游戏文件未安装'

function firstMeaningfulLine(text: string, maxLen = 240): string {
  const line = text.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? text.trim()
  if (line.length <= maxLen) {
    return line
  }
  return `${line.slice(0, maxLen)}…`
}

function isPanelGameFilesMessage(text: string): boolean {
  return text.startsWith(GAME_FILES_PREFIX) || text.startsWith('SteamCMD 镜像')
}

function isLegacyVerbosePanelMessage(text: string): boolean {
  return text.includes('【游戏服务端未安装】') || text.includes('【SteamCMD 镜像未就绪】')
}

export function diagnoseDstInstallReadiness(installPath: string): DstInstallReadiness {
  const normalizedPath = installPath.trim()
  if (!normalizedPath) {
    return {
      ready: false,
      code: 'missing_install_dir',
      message: '安装路径为空',
    }
  }
  if (!fs.existsSync(normalizedPath)) {
    return {
      ready: false,
      code: 'missing_install_dir',
      message: '安装目录不存在',
    }
  }
  if (findDstServerBinary(normalizedPath)) {
    if (!hasGameDataDirectory(normalizedPath)) {
      return {
        ready: false,
        code: 'missing_game_data',
        message: '缺少游戏资源目录 data/',
      }
    }
    return {
      ready: true,
      code: 'ok',
      message: '',
    }
  }
  const manifestPath = resolveAppManifestPath(normalizedPath)
  if (manifestPath) {
    return {
      ready: false,
      code: 'partial_steam_install',
      message: '安装清单存在但缺少可执行文件',
    }
  }
  return {
    ready: false,
    code: 'missing_game_files',
    message: '未检测到游戏服务端文件',
  }
}

export function buildGameFilesBlockedMessage(
  readiness: DstInstallReadiness,
  context?: DstStartBlockedContext,
): string {
  const installFailed = context?.installLogStatus === 'failed'
    || (context?.instanceStatus === 'error' && context?.lastErrorPhase !== 'runtime')
  const storedError = context?.lastError?.trim()

  if (storedError && isPanelGameFilesMessage(storedError)) {
    return storedError
  }

  if (installFailed && storedError && !isLegacyVerbosePanelMessage(storedError)) {
    return `${GAME_FILES_PREFIX}：${firstMeaningfulLine(storedError)}。请点击「更新服务端」重试。`
  }

  if (readiness.code === 'missing_install_dir') {
    return installFailed
      ? `${GAME_FILES_PREFIX}：安装失败。请点击「更新服务端」重试。`
      : `${GAME_FILES_PREFIX}：安装目录不存在。`
  }

  if (readiness.code === 'partial_steam_install' || readiness.code === 'missing_game_data') {
    return `${GAME_FILES_PREFIX}：下载不完整。请点击「更新服务端」重试。`
  }

  if (installFailed) {
    return `${GAME_FILES_PREFIX}：下载失败或已中断。请点击「更新服务端」重试。`
  }

  return `${GAME_FILES_PREFIX}：尚未下载完成。请等待安装，或点击「更新服务端」。`
}

export function buildDstStartBlockedMessage(
  readiness: DstInstallReadiness,
  steamcmdImageReady: boolean,
  context?: DstStartBlockedContext,
): string {
  if (!steamcmdImageReady) {
    return 'SteamCMD 镜像未拉取。请在上方 SteamCMD 面板点击「拉取 / 检测镜像」后再试。'
  }
  return buildGameFilesBlockedMessage(readiness, context)
}
