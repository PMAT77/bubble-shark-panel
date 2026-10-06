import fs from 'node:fs'
import path from 'node:path'
import { findDstServerBinary, ensureDstServerBinaryExecutable } from '../../infra/game-adapter/dst/cluster-config'
import { getServerContainerConfig } from '../../shared/config/container'
import { resolveSteamcmdContainerUidGid } from '../../infra/container/steamcmd-container-user'

export { resolveSteamcmdContainerUidGid }

function resolveEntryMode(entryPath: string, isDirectory: boolean): number {
  const stat = fs.statSync(entryPath)
  const baseMode = isDirectory ? 0o775 : 0o664
  return baseMode | (stat.mode & 0o111)
}

function chownRecursive(targetPath: string, uid: number, gid: number): void {
  const isDirectory = fs.statSync(targetPath).isDirectory()
  fs.chownSync(targetPath, uid, gid)
  try {
    fs.chmodSync(targetPath, resolveEntryMode(targetPath, isDirectory))
  }
  catch {
    // best-effort
  }
  if (!isDirectory) {
    return
  }
  const entries = fs.readdirSync(targetPath, { withFileTypes: true })
  for (const entry of entries) {
    const childPath = path.join(targetPath, entry.name)
    if (entry.isDirectory()) {
      chownRecursive(childPath, uid, gid)
    }
    else {
      fs.chownSync(childPath, uid, gid)
      try {
        fs.chmodSync(childPath, resolveEntryMode(childPath, false))
      }
      catch {
        // best-effort
      }
    }
  }
}

function ensureInstancesRootForSteamcmd(): string | undefined {
  const { instancesRoot } = getServerContainerConfig()
  try {
    fs.mkdirSync(instancesRoot, { recursive: true })
    const { uid, gid } = resolveSteamcmdContainerUidGid()
    fs.chownSync(instancesRoot, uid, gid)
    fs.chmodSync(instancesRoot, 0o775)
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function ensureInstallDirectoryOwnership(installPath: string): string | undefined {
  if (getServerContainerConfig().runtimeMode === 'native') {
    try {
      fs.mkdirSync(installPath, { recursive: true, mode: 0o775 })
      fs.chmodSync(installPath, 0o775)
      ensureDstServerBinaryExecutable(installPath)
      return undefined
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Native 安装目录必须由面板服务用户可写: ${message}`
    }
  }
  const rootError = ensureInstancesRootForSteamcmd()
  if (rootError) {
    return `实例根目录权限调整失败: ${rootError}`
  }
  try {
    fs.mkdirSync(installPath, { recursive: true })
  }
  catch (error) {
    return error instanceof Error ? error.message : '创建安装目录失败'
  }
  try {
    const { uid, gid } = resolveSteamcmdContainerUidGid()
    if (findDstServerBinary(installPath)) {
      fs.chownSync(installPath, uid, gid)
      fs.chmodSync(installPath, 0o775)
      ensureDstServerBinaryExecutable(installPath)
      return undefined
    }
    chownRecursive(installPath, uid, gid)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const { uid } = resolveSteamcmdContainerUidGid()
    return `安装目录权限调整失败（需对 SteamCMD 容器运行用户 uid=${uid} 可写）: ${message}`
  }
}

/**
 * 为 SteamCMD 安装准备目录：Docker 赋予容器用户权限，Native 保持 bsp 用户所有权。
 * 若目录内已有游戏文件，仅调整实例目录本身，避免递归 chmod 去掉二进制 +x。
 * 准备和重试都不清理半成品 Steam 目录，以保留断点续传缓存。
 */
export function prepareInstallPathForSteamcmd(installPath: string): string | undefined {
  return ensureInstallDirectoryOwnership(installPath)
}

/**
 * 实例启动前：确保目录存在并补齐 DST 二进制可执行位，不递归 chmod 已安装文件树。
 */
export function prepareInstallPathForRuntime(installPath: string): string | undefined {
  try {
    fs.mkdirSync(installPath, { recursive: true })
  }
  catch (error) {
    return error instanceof Error ? error.message : '创建安装目录失败'
  }
  ensureDstServerBinaryExecutable(installPath)
}
