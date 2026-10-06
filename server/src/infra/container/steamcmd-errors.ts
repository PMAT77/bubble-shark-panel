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
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim()
}

export type SteamcmdInstallFailureKind
  = | 'network'
    | 'timeout'
    | 'permission'
    | 'subscription'
    | 'disk'
    | 'oom'
    | 'incomplete'
    | 'unknown'

/**
 * 面板自身因超时终止 SteamCMD 时写入输出的标记。
 * 超时 kill 走 SIGKILL，容器退出码同样是 137；靠该标记与真正的 OOM 区分，
 * 并让安装流程按「可重试」处理（重试走 Steam 断点续传，不清理下载缓存）。
 */
export const STEAMCMD_TIMEOUT_MARKER = 'GSH-STEAMCMD-TIMEOUT'
export const STEAMCMD_OOM_MARKER = 'BSP-STEAMCMD-OOM'

/** 保留可用于诊断的主错误，避免后续进度/卸载输出挤掉它。 */
export const STEAMCMD_FAILURE_LINE = /error|failed|failure|missing|denied|timeout|timed?\s*out|invalid|no subscription|fatal|not enough disk|no space left|disk write|out of memory|BSP-STEAMCMD-OOM/i

export function redactSteamcmdLogLine(line: string, secrets: string[] = []): string {
  let text = sanitizeSteamcmdLogLine(line)
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[REDACTED]')
  }
  return text
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:[^=&\s]*(?:token|key|secret|password|ticket|auth)[^=&\s]*)=)[^&\s]+/gi, '$1[REDACTED]')
}

export function steamcmdLogSecrets(args: string[], proxies: string[]): string[] {
  const login = args.indexOf('+login')
  const secrets = login >= 0 && args[login + 1] !== 'anonymous'
    ? args.slice(login + 1, login + 3).filter(value => value && !value.startsWith('+'))
    : []
  for (const proxy of proxies.filter(Boolean)) {
    secrets.push(proxy)
    try {
      const url = new URL(proxy)
      for (const value of [url.username, url.password]) {
        if (value) secrets.push(value, decodeURIComponent(value))
      }
    }
    catch { /* malformed proxy must not prevent collecting diagnostics */ }
  }
  return secrets
}

export {
  resolveSteamcmdInstallMaxAttempts,
  resolveSteamcmdInstallRetryDelaysMs,
} from '../../shared/config/steamcmd'

/**
 * 根据 SteamCMD 输出归类失败原因。
 * 明确的失败证据优先于应用状态；状态码本身不证明网络或本地文件损坏。
 */
export function classifySteamcmdInstallFailure(output: string): SteamcmdInstallFailureKind {
  const text = sanitizeSteamcmdLogLine(output).split('\n')
    .filter(line => !line.startsWith('[SteamCMD 诊断]')).join('\n')
  if (text.includes(STEAMCMD_OOM_MARKER)) {
    return 'oom'
  }
  if (/not enough disk|no space left|disk full|out of disk space|insufficient disk|ENOSPC|disk write failure/i.test(text)) {
    return 'disk'
  }
  if (/Missing file permissions|permission denied|EACCES|read-only file system/i.test(text)) {
    return 'permission'
  }
  if (/No subscription/i.test(text)) {
    return 'subscription'
  }
  if (text.includes(STEAMCMD_TIMEOUT_MARKER)) {
    return 'timeout'
  }
  if (
    /needs to be online/i.test(text)
    || /network connection/i.test(text)
    || /confirm your network/i.test(text)
    || /timed?\s*out/i.test(text)
    || /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(text)
    || /Could not connect|failed to connect|Unable to connect/i.test(text)
    || /(?:content server|CDN).*?(?:failed|unavailable|unreachable|timeout)|Secure connection failed/i.test(text)
    || /HTTP (?:error[: ]*)?(?:429|5\d\d)\b/i.test(text)
  ) {
    return 'network'
  }
  if (/Missing configuration|state is 0x(?:402|602)\b/i.test(text)) {
    return 'incomplete'
  }
  return 'unknown'
}

export function isRetriableSteamcmdInstallOutput(output: string): boolean {
  const kind = classifySteamcmdInstallFailure(output)
  // timeout 也重试：已下载内容保留在 steamapps/downloading，下一轮 app_update 断点续传
  return kind === 'network' || kind === 'timeout' || kind === 'incomplete'
}

function extractSteamcmdFailureSnippet(output: string): string {
  const sanitized = sanitizeSteamcmdLogLine(output) || output.trim()
  if (!sanitized) {
    return '（无 SteamCMD 输出）'
  }
  const lines = sanitized.split('\n').map(line => line.trim()).filter(Boolean)
  const errorLine = [...lines].reverse().find(line =>
    STEAMCMD_FAILURE_LINE.test(line) && !line.startsWith('[SteamCMD 诊断]'),
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

  if (kind === 'disk' || kind === 'oom' || kind === 'incomplete') {
    const detail = {
      disk: '磁盘空间不足或写入失败。请检查实例目录和容器存储所在磁盘。',
      oom: 'Docker 确认容器被 OOM 终止。请检查内存上限及宿主机内存。',
      incomplete: '更新未完成，具体原因尚未确定。已保留下载缓存，请查看本次 content_log.txt 和 stderr.txt 诊断后重试。',
    }[kind]
    return `SteamCMD 安装 ${input.appId} 失败：${detail}SteamCMD 输出：${failureSnippet}`
  }

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
      '已下载内容保留在 steamapps/downloading，重新安装会断点续传。',
      '建议：在 panel.env 调大 BSP_STEAMCMD_APP_UPDATE_TIMEOUT_MS（毫秒，例如 7200000），',
      `SteamCMD 输出：${failureSnippet}`,
    ].join('')
  }

  if (kind === 'network') {
    return [
      `SteamCMD 安装 ${input.appId} 失败（网络或 Steam 服务不稳定）。`,
      '请检查 Steam 内容服务器连接、DNS 和 Docker 出网；必要时配置 BSP_STEAMCMD_HTTPS_PROXY（游戏 CDN 是否走代理需实际验证）；',
      '等待数分钟后点击「更新服务端」重试；在系统设置查看 SteamCMD 诊断；避免 dev:compose 与 dev:server 同时运行。',
      `SteamCMD 输出：${failureSnippet}`,
    ].join('')
  }

  return `安装失败（${input.mode}）：${failureSnippet}`
}
