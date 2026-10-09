/** 与后端 stripAnsiEscapes 对齐：剥离 ANSI，保留 SteamCMD `[  0%]` / `[----]` */
function stripAnsiEscapes(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[@-Z\\-_]/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\[(?:\d{1,3}(?:;\d{1,3})*)?m/g, '')
    .replace(/\[(?:\d{1,3}(?:;\d{1,3})*)?[GK]/g, '')
}

function normalizeInstallLogLine(line: string): string {
  return stripAnsiEscapes(line)
    .replace(/\uFEFF/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/^[\u0001\u0002\u0003]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trimEnd()
}

/** 前端展示用：规范化安装日志文本排版 */
export function formatInstallLogForDisplay(raw: string): string {
  if (!raw.trim()) {
    return raw
  }
  const lines = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => normalizeInstallLogLine(line))

  const compact: string[] = []
  let previousBlank = false
  for (const line of lines) {
    const isBlank = line.trim().length === 0
    if (isBlank && previousBlank) {
      continue
    }
    compact.push(line)
    previousBlank = isBlank
  }
  return compact.join('\n').trimEnd()
}
