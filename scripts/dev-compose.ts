/**
 * 开发 Compose 启动器：SteamCMD 前置拉取 → compose up → 就绪后打印可配置横幅
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const panelEnvPath = path.join(repoRoot, 'panel.env')

function readEnvFileVar(key: string): string | undefined {
  if (!fs.existsSync(panelEnvPath)) {
    return undefined
  }
  const content = fs.readFileSync(panelEnvPath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }
    const name = trimmed.slice(0, separatorIndex).trim()
    if (name !== key) {
      continue
    }
    return trimmed.slice(separatorIndex + 1).trim()
  }
  return undefined
}

const panelPort = process.env.PANEL_PORT?.trim() || readEnvFileVar('PANEL_PORT') || '8888'
const webPort = process.env.VITE_DEV_WEB_PORT?.trim() || readEnvFileVar('VITE_DEV_WEB_PORT') || '9527'
const panelUrl = `http://127.0.0.1:${panelPort}`
const webUrl = `http://127.0.0.1:${webPort}`
const steamcmdImage = process.env.GSH_STEAMCMD_IMAGE?.trim() || 'ghcr.io/pmat77/game-server-hub:v0.13.4'
const account = process.env.ADMIN_USERNAME?.trim() || 'superadmin'
const password = process.env.ADMIN_PASSWORD ?? '123456'

import { createDevComposeLogFilter, filterDevComposeLogLine } from './dev-compose-log-filter.ts'

const verboseComposeLogs = process.env.GSH_DEV_COMPOSE_VERBOSE === '1'
const READY_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 2_000
const IMAGE_PULL_ATTEMPTS = 3
const IMAGE_PULL_RETRY_DELAY_MS = 3_000
const DEV_BASE_IMAGES = ['node:22-bookworm-slim']
// Docker Hub 基础镜像的拉取候选（逗号分隔 registry 主机名，拉取成功后 tag 回标准名）；
// 设为空字符串可禁用候选、强制直连 Docker Hub。
const DEV_PULL_MIRRORS = (process.env.GSH_DEV_PULL_MIRRORS ?? 'docker.m.daocloud.io,docker.1ms.run,dockerproxy.net')
  .split(',')
  .map(item => item.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''))
  .filter(Boolean)

interface BannerConfig {
  panelUrlTemplate?: string
  webUrlTemplate?: string
  lines?: string[]
  template?: string
}

function runPrepare() {
  try {
    const output = execFileSync(process.execPath, [
      path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(repoRoot, 'server', 'scripts', 'ensure-steamcmd-image.ts'),
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    if (verboseComposeLogs) {
      process.stdout.write(output)
      return
    }
    for (const line of output.split(/\r?\n/)) {
      const filtered = filterDevComposeLogLine(line)
      if (filtered) {
        console.log(filtered)
      }
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[dev:compose] SteamCMD 镜像准备未完成，将继续启动 compose：${message}`)
  }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetryableRegistryError(message: string): boolean {
  return /tls: bad record MAC|unexpected EOF|connection reset|i\/o timeout|temporary failure/i.test(message)
}

function commandErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const result = error as { message?: unknown, stderr?: unknown, stdout?: unknown }
    return [result.message, result.stderr, result.stdout]
      .map(value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? ''))
      .filter(Boolean)
      .join('\n')
  }
  return String(error)
}

function dockerImageExists(image: string): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', image], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  }
  catch {
    return false
  }
}

async function pullDockerImage(image: string): Promise<void> {
  for (let attempt = 1; attempt <= IMAGE_PULL_ATTEMPTS; attempt++) {
    try {
      execFileSync('docker', ['pull', image], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'inherit', 'pipe'],
      })
      return
    }
    catch (error) {
      const message = commandErrorMessage(error)
      if (attempt === IMAGE_PULL_ATTEMPTS || !isRetryableRegistryError(message)) {
        throw new Error(`无法拉取镜像 ${image}。\n${message.trim()}`)
      }
      console.warn(`[dev:compose] 镜像拉取发生临时网络错误，${IMAGE_PULL_RETRY_DELAY_MS / 1000}s 后重试…`)
      await wait(IMAGE_PULL_RETRY_DELAY_MS)
    }
  }
}

async function ensureDevBaseImages() {
  for (const image of DEV_BASE_IMAGES) {
    if (dockerImageExists(image)) {
      console.log(`[dev:compose] 开发基础镜像已存在，跳过: ${image}`)
      continue
    }

    const candidates = [
      ...DEV_PULL_MIRRORS.map(mirror => `${mirror}/${image}`),
      image,
    ]
    let lastError: unknown = null
    for (const candidate of candidates) {
      try {
        console.log(`[dev:compose] 准备开发基础镜像: ${candidate}`)
        await pullDockerImage(candidate)
        if (candidate !== image) {
          console.log(`[dev:compose] 拉取成功，标记为标准引用: ${image}`)
          execFileSync('docker', ['tag', candidate, image], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        }
        lastError = null
        break
      }
      catch (error) {
        lastError = error
      }
    }
    if (lastError) {
      const message = lastError instanceof Error ? lastError.message : String(lastError)
      throw new Error(`无法拉取开发基础镜像 ${image}（已尝试镜像源：${DEV_PULL_MIRRORS.join(', ') || '无'}）。请检查 Docker 网络或代理后重试；也可先手动执行 docker pull ${image}。\n${message.trim()}`)
    }
  }
}

function loadBannerConfig(): BannerConfig {
  const paths = [
    path.join(repoRoot, 'scripts/dev-compose.banner.local.json'),
    path.join(repoRoot, 'scripts/dev-compose.banner.json'),
  ]
  for (const filePath of paths) {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as BannerConfig
    }
  }
  return {}
}

function renderBanner(config: BannerConfig) {
  const resolvedPanelUrl = (config.panelUrlTemplate ?? 'http://localhost:{panelPort}')
    .replace(/\{panelPort\}/g, panelPort)
  const resolvedWebUrl = (config.webUrlTemplate ?? 'http://localhost:{webPort}')
    .replace(/\{webPort\}/g, webPort)

  const vars: Record<string, string> = {
    panelPort,
    webPort,
    panelUrl: resolvedPanelUrl,
    webUrl: resolvedWebUrl,
    account,
    password,
    steamcmdImage,
  }

  const substitute = (text: string) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`)

  if (config.template) {
    console.log(substitute(config.template))
    return
  }

  const lines = config.lines ?? [
    '',
    `前端: ${resolvedWebUrl}`,
    `后端: ${resolvedPanelUrl}`,
    `账号: ${account}  密码: ${password}`,
    '',
  ]
  for (const line of lines) {
    console.log(substitute(line))
  }
}

async function waitForUrl(url: string, label: string): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) })
      if (res.ok || res.status < 500) {
        return true
      }
    }
    catch {
      // retry
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    process.stdout.write(`[dev:compose] 等待 ${label}…\r`)
  }
  return false
}

async function waitForPanelHealth(): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${panelUrl}/health`, { signal: AbortSignal.timeout(3_000) })
      if (res.ok) {
        const json = await res.json() as { docker?: string }
        if (json.docker === 'running' || json.docker === 'stopped') {
          return true
        }
      }
    }
    catch {
      // retry
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
  return false
}

let bannerPrinted = false
let bannerCheckInProgress = false

async function tryPrintReadyBanner(): Promise<boolean> {
  if (bannerPrinted || bannerCheckInProgress) {
    return bannerPrinted
  }
  bannerCheckInProgress = true
  try {
    const [panelOk, webOk] = await Promise.all([
      waitForPanelHealth(),
      waitForUrl(webUrl, '前端'),
    ])
    if (panelOk && webOk) {
      bannerPrinted = true
      renderBanner(loadBannerConfig())
      if (!verboseComposeLogs) {
        console.log('[dev:compose] 详细日志: GSH_DEV_COMPOSE_VERBOSE=1 pnpm dev:compose')
      }
    }
  }
  finally {
    if (!bannerPrinted) {
      bannerCheckInProgress = false
    }
  }
  return bannerPrinted
}

function startComposeOnce(): Promise<{ code: number, output: string }> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const composeArgs = [
      'compose',
      ...(fs.existsSync(panelEnvPath) ? ['--env-file', 'panel.env'] : []),
      '-f', 'docker-compose.yml',
      '-f', 'docker-compose.dev.yml',
      'up',
      '--build',
      '--quiet-pull',
    ]
    const child = spawn(
      isWin ? 'docker.exe' : 'docker',
      composeArgs,
      {
        cwd: repoRoot,
        stdio: verboseComposeLogs ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        shell: false,
      },
    )
    let output = ''
    if (!verboseComposeLogs && child.stdout && child.stderr) {
      const emit = (line: string) => console.log(line)
      const filterStdout = createDevComposeLogFilter(emit)
      const filterStderr = createDevComposeLogFilter(emit)
      child.stdout.on('data', (chunk) => {
        output += chunk.toString()
        filterStdout(chunk)
      })
      child.stderr.on('data', (chunk) => {
        output += chunk.toString()
        filterStderr(chunk)
      })
    }
    const pollTimer = setInterval(() => {
      void tryPrintReadyBanner().then((printed) => {
        if (printed) {
          clearInterval(pollTimer)
        }
      })
    }, POLL_INTERVAL_MS)

    child.on('error', (error) => {
      clearInterval(pollTimer)
      reject(error)
    })
    child.on('close', (code) => {
      clearInterval(pollTimer)
      resolve({ code: code ?? 1, output })
    })
  })
}

async function startCompose(): Promise<number> {
  for (let attempt = 1; attempt <= IMAGE_PULL_ATTEMPTS; attempt++) {
    const result = await startComposeOnce()
    if (result.code === 0 || attempt === IMAGE_PULL_ATTEMPTS || !isRetryableRegistryError(result.output)) {
      return result.code
    }
    console.warn(`[dev:compose] Compose 拉取发生临时网络错误，${IMAGE_PULL_RETRY_DELAY_MS / 1000}s 后重试 (${attempt + 1}/${IMAGE_PULL_ATTEMPTS})…`)
    await wait(IMAGE_PULL_RETRY_DELAY_MS)
  }
  return 1
}

async function main() {
  runPrepare()
  await ensureDevBaseImages()
  if (!verboseComposeLogs) {
    console.log('[dev:compose] 启动 docker compose…')
  }
  else {
    console.log('[dev:compose] 启动 docker compose（就绪后将打印访问地址）…\n')
  }
  const exitCode = await startCompose()
  process.exit(exitCode)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
