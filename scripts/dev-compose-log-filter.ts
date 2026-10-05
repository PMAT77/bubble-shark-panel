const COMPOSE_PREFIX = /^[\w.-]+\s+\|\s/

const DROP_LINE_PATTERNS = [
  /^$/,
  /^> bubblesharkpanel@/,
  /^> vite$/,
  /^> tsx /,
  /vite-plugin-svg-spritemap/,
  /^\s*➜\s+(Local|Network):/,
  /^VITE v\d/,
  /ready in \d+ ms/i,
  /Fantastic-admin/,
  /fantastic-admin\.hurui\.me/i,
  /当前使用：/,
  /由 .* 驱动/,
  /^[\s╔╚╝║═╭╮╯╰─│┤├┴┬]+$/,
  /Server listening at http:\/\/127\.0\.0\.1/,
  /ExperimentalWarning: SQLite/,
  /Use `node --trace-warnings`/,
  /^Attaching to/,
  /^Gracefully stopping/,
  /^Aborting on container exit/,
  /^Container .* (Created|Starting|Started|Stopping|Stopped|Removed|Healthy|Waiting)/,
  /^\[[+-]\]/,
  /^corepack enable/,
  /^pnpm install/,
]

const KEEP_LINE_PATTERNS = [
  /\[dev:compose\]/,
  /\[ensure-steamcmd-image\]/,
  /\berror\b/i,
  /\bfatal\b/i,
  /\bwarn\b/i,
  /失败/,
  /异常/,
  /启动失败/,
  /拉取失败/,
]

function stripComposePrefix(line: string): string {
  return line.replace(COMPOSE_PREFIX, '')
}

function formatPinoLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) {
    return null
  }
  try {
    const json = JSON.parse(trimmed) as { level?: number, msg?: string }
    const msg = json.msg?.trim()
    if (!msg) {
      return null
    }
    if ((json.level ?? 0) >= 50) {
      return `[panel:error] ${msg}`
    }
    if ((json.level ?? 0) >= 40) {
      return `[panel:warn] ${msg}`
    }
    if ((json.level ?? 0) === 30 && /后端服务已启动|SQLite 数据库已就绪|后端服务启动失败|收到退出信号/.test(msg)) {
      return `[panel] ${msg}`
    }
  }
  catch {
    return null
  }
  return null
}

export function filterDevComposeLogLine(rawLine: string): string | null {
  const line = stripComposePrefix(rawLine.replace(/\r$/, ''))
  if (DROP_LINE_PATTERNS.some(pattern => pattern.test(line))) {
    return null
  }
  const pino = formatPinoLine(line)
  if (pino) {
    return pino
  }
  if (KEEP_LINE_PATTERNS.some(pattern => pattern.test(line))) {
    return line
  }
  return null
}

export function createDevComposeLogFilter(onLine: (line: string) => void) {
  let buffer = ''
  return (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      const filtered = filterDevComposeLogLine(rawLine)
      if (filtered) {
        onLine(filtered)
      }
      newlineIndex = buffer.indexOf('\n')
    }
  }
}
