/**
 * 剥离 ANSI/CSI 转义。须先于 C0 控制符清理调用，避免 ESC 被删掉后残留 `[0m`。
 * 不处理 SteamCMD 进度方括号（如 `[  0%]`、`[----]`）。
 */
export function stripAnsiEscapes(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[@-Z\\-_]/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\[(?:\d{1,3}(?:;\d{1,3})*)?m/g, '')
    .replace(/\[(?:\d{1,3}(?:;\d{1,3})*)?[GK]/g, '')
}

/** 去掉 Docker 多路复用流里偶发的控制字符，避免安装日志/错误信息乱码 */
export function sanitizeSteamcmdLogLine(line: string): string {
  return stripAnsiEscapes(line)
    .replace(/\uFEFF/g, '')
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/^[\u0001\u0002\u0003]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export type SteamcmdInstallFailureKind
  = | 'network'
    | 'timeout'
    | 'permission'
    | 'subscription'
    | 'unknown'

/**
 * 面板自身因超时终止 SteamCMD 时写入输出的标记。
 * 超时 kill 走 SIGKILL，容器退出码同样是 137；靠该标记与真正的 OOM 区分，
 * 并让安装流程按「可重试」处理（重试走 Steam 断点续传，不清理下载缓存）。
 */
export const STEAMCMD_TIMEOUT_MARKER = 'GSH-STEAMCMD-TIMEOUT'

export {
  resolveSteamcmdInstallMaxAttempts,
  resolveSteamcmdInstallRetryDelaysMs,
} from '../../shared/config/steamcmd'

/**
 * 根据 SteamCMD 输出归类失败原因。
 * Missing configuration / 0x602 在 bind 已修复后仍偶发，运行时证据指向 Steam 侧瞬时故障，归入 network。
 */
export function classifySteamcmdInstallFailure(output: string): SteamcmdInstallFailureKind {
  const text = sanitizeSteamcmdLogLine(output) || output.trim()
  if (text.includes(STEAMCMD_TIMEOUT_MARKER)) {
    return 'timeout'
  }
  if (/Missing file permissions/i.test(text)) {
    return 'permission'
  }
  if (/No subscription/i.test(text)) {
    return 'subscription'
  }
  if (
    /needs to be online/i.test(text)
    || /network connection/i.test(text)
    || /confirm your network/i.test(text)
    || /timed?\s*out/i.test(text)
    || /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(text)
    || /Could not connect|failed to connect|Unable to connect/i.test(text)
    || /content server|CDN|Secure connection failed/i.test(text)
    || /Fatal Error/i.test(text)
    || /Missing configuration/i.test(text)
    || /state is 0x602/i.test(text)
    || /Illegal termination of worker thread/i.test(text)
  ) {
    return 'network'
  }
  return 'unknown'
}

export function isRetriableSteamcmdInstallOutput(output: string): boolean {
  const kind = classifySteamcmdInstallFailure(output)
  // timeout 也重试：已下载内容保留在 steamapps/downloading，下一轮 app_update 断点续传
  return kind === 'network' || kind === 'timeout'
}

/**
 * Steam 本地状态损坏特征（Missing configuration / 0x602 / worker thread 异常终止）。
 * 仅这类失败需要清空半成品 Steam 目录后重试；普通网络中断必须保留
 * steamapps/downloading 下载缓存，否则会失去 SteamCMD 的断点续传。
 */
export function isSteamcmdCorruptStateOutput(output: string): boolean {
  const text = sanitizeSteamcmdLogLine(output) || output.trim()
  return /Missing configuration/i.test(text)
    || /state is 0x602/i.test(text)
    || /Illegal termination of worker thread/i.test(text)
}

function extractSteamcmdFailureSnippet(output: string): string {
  const sanitized = sanitizeSteamcmdLogLine(output) || output.trim()
  if (!sanitized) {
    return '（无 SteamCMD 输出）'
  }
  const lines = sanitized.split('\n').map(line => line.trim()).filter(Boolean)
  const errorLine = [...lines].reverse().find(line =>
    /error|failed|failure|missing|denied|timeout|invalid|not available|no subscription|fatal|online/i.test(line),
  )
  if (errorLine) {
    return errorLine
  }
  if (lines.length <= 3) {
    return lines.join(' | ')
  }
  return lines.slice(-3).join(' | ')
}

export function formatSteamcmdAppUpdateFailureMessage(input: {
  appId: string
  output: string
  mode: 'anonymous' | 'account'
  hasAccountCredentials: boolean
}): string {
  const output = sanitizeSteamcmdLogLine(input.output) || input.output.trim()
  const failureSnippet = extractSteamcmdFailureSnippet(input.output)
  const kind = classifySteamcmdInstallFailure(input.output)

  if (kind === 'subscription') {
    const steamClientSelfUpdate = /app\s*['"]?8['"]?/i.test(output)
    if (steamClientSelfUpdate) {
      return [
        'SteamCMD 自更新 Steam 客户端（AppID 8）失败（No subscription），未开始安装目标游戏。',
        '容器镜像已内置 SteamCMD，请勿在安装命令中执行 app_update 8；若仍出现此错误请升级面板版本。',
        `SteamCMD 输出：${failureSnippet}`,
      ].join('')
    }
    return [
      `SteamCMD 安装 ${input.appId} 失败（No subscription）。`,
      '该 AppID 可能需要已入库对应游戏的 Steam 账号登录安装；',
      '部分未来游戏将支持在 panel.env 配置 STEAMCMD_USERNAME / STEAMCMD_PASSWORD。',
      `SteamCMD 输出：${failureSnippet}`,
    ].join('')
  }

  if (kind === 'permission') {
    return [
      `SteamCMD 安装 ${input.appId} 失败（Missing file permissions）。`,
      '通常为 Docker 卷挂载或安装目录权限问题：',
      '请检查 force_install_dir 是否可写、panel 是否正确解析 instances 卷挂载、',
      '必要时在 panel.env 设置 BSP_STEAMCMD_RUN_USER=0:0 或 BSP_STEAMCMD_BIND_OPTS=rw,z。',
      `SteamCMD 输出：${failureSnippet}`,
    ].join('')
  }

  if (kind === 'timeout') {
    return [
      `SteamCMD 安装 ${input.appId} 失败（下载超时）。`,
      '面板在单次 app_update 超过 BSP_STEAMCMD_APP_UPDATE_TIMEOUT_MS（默认 60 分钟）后终止了任务；',
      '已下载内容保留在 steamapps/downloading，重新安装会断点续传（共享内存不足与本次失败无关）。',
      '建议：在 panel.env 调大 BSP_STEAMCMD_APP_UPDATE_TIMEOUT_MS（毫秒，例如 7200000），',
      '并设置 BSP_STEAMCMD_DOWNLOAD_REGION=cn 提升下载速度。',
      `SteamCMD 输出：${failureSnippet}`,
    ].join('')
  }

  if (kind === 'network') {
    return [
      `SteamCMD 安装 ${input.appId} 失败（网络或 Steam 服务不稳定）。`,
      '可能原因：访问 Steam CDN/API 超时、连续安装触发限速、Docker 出网抖动，或 Steam 返回瞬时错误（如 Missing configuration）。',
      '建议：在 panel.env 设置 BSP_STEAMCMD_DOWNLOAD_REGION=cn；必要时配置 BSP_STEAMCMD_HTTPS_PROXY；',
      '等待数分钟后点击「更新服务端」重试；在系统设置查看 SteamCMD 诊断；避免 dev:compose 与 dev:server 同时运行。',
      `SteamCMD 输出：${failureSnippet}`,
    ].join('')
  }

  return `安装失败（${input.mode}）：${failureSnippet}`
}
