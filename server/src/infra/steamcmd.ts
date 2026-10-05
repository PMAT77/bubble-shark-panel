import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const LEGACY_DEFAULT_INSTALL_ROOT = path.resolve(process.cwd(), 'data', 'instances')

function buildSteamcmdPathCandidates(commandPath: string): string[] {
  const candidates = [
    commandPath.trim(),
    process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd',
  ]
  if (process.platform === 'win32') {
    candidates.push('C:\\steamcmd\\steamcmd.exe')
    candidates.push('D:\\steamcmd\\steamcmd.exe')
  }
  else {
    candidates.push('/usr/games/steamcmd')
    candidates.push('/usr/bin/steamcmd')
    candidates.push('/usr/local/bin/steamcmd')
  }
  return [...new Set(candidates.filter(Boolean))]
}

function resolveSteamcmdByCommand(commandPath: string): string {
  if (!commandPath.trim()) {
    return ''
  }
  const command = process.platform === 'win32'
    ? `$cmd = Get-Command "${commandPath}" -ErrorAction SilentlyContinue; if ($cmd) { $cmd.Source }`
    : `command -v "${commandPath}" 2>/dev/null`
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'sh'
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', command]
    : ['-lc', command]
  const result = spawnSync(shell, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 1_500,
    windowsHide: true,
  })
  if (result.status !== 0) {
    return ''
  }
  return result.stdout?.trim() || ''
}

export function resolveSteamcmdPath(commandPath: string): string {
  for (const candidate of buildSteamcmdPathCandidates(commandPath)) {
    const resolved = resolveSteamcmdByCommand(candidate)
    if (resolved) {
      return resolved
    }
  }
  return ''
}

export function resolveDefaultInstallRoot(steamcmdCommandPath: string): string {
  const resolvedSteamcmdPath = resolveSteamcmdPath(steamcmdCommandPath)
  if (resolvedSteamcmdPath) {
    return path.resolve(path.dirname(resolvedSteamcmdPath), 'instances')
  }
  return process.platform === 'win32'
    ? 'C:\\steamcmd\\instances'
    : '/var/lib/bubblesharkpanel/instances'
}

export function resolveEffectiveInstallRoot(rawInstallRoot: string | undefined, steamcmdCommandPath: string): string {
  const installRoot = rawInstallRoot?.trim() || ''
  if (!installRoot) {
    return resolveDefaultInstallRoot(steamcmdCommandPath)
  }
  if (path.resolve(installRoot) === LEGACY_DEFAULT_INSTALL_ROOT) {
    return resolveDefaultInstallRoot(steamcmdCommandPath)
  }
  return installRoot
}

export function buildSteamcmdImageReadyMessage(_image?: string): string {
  return 'SteamCMD 镜像已就绪，可以创建游戏实例'
}
