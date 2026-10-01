import type { InstanceItem } from '@/api/modules/instance'
import { GAME_CODES } from '@/constants/games'

type InstallStatus = Pick<InstanceItem, 'status'>
type InstallGuideTarget = Pick<InstanceItem, 'gameCode' | 'status'>
type InstallResultTarget = Pick<InstanceItem, 'name' | 'status' | 'lastErrorPhase'>

export interface InstallResultNotificationPayload {
  type: 'success' | 'error'
  title: string
  content: string
  durationMs: number
}

export function shouldShowPostCreateInstallGuide(instance: InstallGuideTarget): boolean {
  return instance.gameCode === GAME_CODES.DST
    && (instance.status === 'pending_install' || instance.status === 'installing')
}

function isInstallTerminalStatus(status: InstallStatus['status']): status is 'stopped' | 'error' {
  return status === 'stopped' || status === 'error'
}

export function buildInstallResultNotification(
  instance: InstallResultTarget,
): InstallResultNotificationPayload | null {
  if (!isInstallTerminalStatus(instance.status)) {
    return null
  }
  if (instance.status === 'stopped') {
    return {
      type: 'success',
      title: '实例安装完成',
      content: `「${instance.name}」安装完成，可以启动实例`,
      durationMs: 5000,
    }
  }
  /**
   * error 未必是安装的结果：安装成功后启动失败（内存不足、端口占用）也会落到 error。
   * 只有安装环节的失败才作为「安装失败」上报，其余的交给启动路径自己的提示。
   */
  if (instance.lastErrorPhase !== 'install') {
    return null
  }
  return {
    type: 'error',
    title: '实例安装失败',
    content: `「${instance.name}」安装失败，请查看安装日志`,
    durationMs: 5000,
  }
}
