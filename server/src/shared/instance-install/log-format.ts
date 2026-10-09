import type { InstanceInstallProgress } from '../../../../shared/contracts/instance'
import { classifySteamcmdInstallFailure, sanitizeSteamcmdLogLine } from '../../infra/container/steamcmd-errors'

export const INSTALL_PHASE_LABELS: Record<InstanceInstallProgress['phaseCode'], string> = {
  prepare: '准备安装环境', queue: '等待安装队列', connect: '连接 Steam',
  download: '下载游戏文件', verify: '校验游戏文件', stage: '整理游戏文件', commit: '提交游戏文件',
  finalize: '准备启动文件', runtime: '准备运行环境镜像', copy: '复制本地游戏文件',
  retry: '等待重试', complete: '安装完成',
}

/** 只识别有阶段含义的输出，技术诊断与孤立百分比不改变阶段。 */
export function parseInstallLogPhase(line: string): InstanceInstallProgress['phaseCode'] | null {
  if (/^\[(?:SteamCMD 诊断|资源快照)/.test(line)) return null
  const state = line.match(/Update state \(0x[0-9a-f]+\)\s+(downloading|verifying|validating|staging|committing)\b/i)
  if (state) {
    switch (state[1].toLowerCase()) {
      case 'downloading': return 'download'
      case 'verifying': case 'validating': return 'verify'
      case 'staging': return 'stage'
      case 'committing': return 'commit'
    }
  }
  if (/排队等待|等待.*SteamCMD/.test(line)) return 'queue'
  if (/秒后进行第|等待重试/.test(line)) return 'retry'
  if (/正在准备游戏运行环境镜像/.test(line)) return 'runtime'
  if (/正在复制本地游戏文件|已从实例.*复制游戏文件/.test(line)) return 'copy'
  if (/fully installed|app_update 已完成|正在准备启动文件/i.test(line)) return 'finalize'
  if (/Connecting|Waiting for (?:client config|user info)|Loading Steam API|登录安装|账号登录重试/i.test(line)) return 'connect'
  if (/安装任务启动|正在启动 SteamCMD|容器已启动|Checking for available updates|Verifying installation|^\[\s*(?:\d{1,3}%|----)\]/i.test(line)) return 'prepare'
  return null
}

export function resolveSteamcmdInstallPhase(line: string): string | null {
  const code = parseInstallLogPhase(line)
  return code ? INSTALL_PHASE_LABELS[code] : null
}

/** 保留 SteamCMD 报告的小数；该值属于当前阶段。 */
export function parseSteamcmdProgressPercent(line: string): number | null {
  const match = line.match(/progress:\s*(\d+(?:\.\d+)?)/i)
    ?? line.match(/\[\s*(\d{1,3})%\]/)
    ?? line.match(/安装进度\s*(\d{1,3})\s*%/)
  const value = match ? Number(match[1]) : Number.NaN
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null
}

export function summarizeInstallFailure(message: string): NonNullable<InstanceInstallProgress['failure']> {
  const kind = classifySteamcmdInstallFailure(message)
  const advice = {
    network: '检查网络、DNS 和 SteamCMD 代理配置后重试。',
    timeout: '检查下载连接或调整下载超时后重试，已下载内容会保留。',
    permission: '检查安装目录和挂载目录的写入权限后重试。',
    subscription: '检查游戏是否需要拥有该游戏的 Steam 账号登录。',
    disk: '检查安装目录及容器存储所在磁盘的可用空间和写入权限。',
    oom: '检查宿主机可用内存和 SteamCMD 内存限制后重试。',
    incomplete: '查看原始日志中的内容服务器诊断后重试，已下载内容会保留。',
    unknown: '展开原始日志查看具体原因，处理后点击“更新服务端”重试。',
  }[kind]
  const clean = message.split(/SteamCMD 输出[:：]|\n---/)[0].trim()
  const reason = {
    network: '连接 Steam 或下载服务器失败。', timeout: '本次下载超过等待时间，任务已终止。',
    permission: '安装目录无法写入。', subscription: 'Steam 账号没有对应内容的下载权限。',
    disk: '磁盘空间不足或写入失败。', oom: 'SteamCMD 因内存不足被终止。',
    incomplete: '游戏文件更新未完成。',
    unknown: /[\u4E00-\u9FFF]/.test(clean) && !/安装失败[（(]|^安装失败。$/.test(clean) ? clean : '安装未完成。',
  }[kind]
  return { message: reason, advice }
}

export function normalizeInstallLogLine(line: string): string {
  return sanitizeSteamcmdLogLine(line)
}

/** 清理显示字符，保留每一条原始进度，不再做阶段合并。 */
export function formatInstallLogContent(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').split('\n')
    .map(normalizeInstallLogLine).join('\n').trimEnd()
}
