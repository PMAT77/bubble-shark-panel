/**
 * panel.env 内存预设一致性检查。
 *
 * 预设存在两份拷贝：
 *   1. `config/panel.env.presets/<name>.env`（安装器同步到 PANEL_INSTALL_DIR 的版本）
 *   2. `scripts/install.linux.sh` 内置的 heredoc（离线/镜像池装包时的兜底）
 *
 * 两份必须逐字节一致。历史上已经因为不一致出过一次线上问题：
 * 内置 small.env 的 `BSP_DST_CONTAINER_MEMORY_MB` 停在 768 而仓库文件已改成 1536，
 * 走兜底路径安装的小内存机器因此拿到了一半的内存上限。此前没有任何检查会拦住它。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PRESET_NAMES = ['small.env', 'medium.env', 'large.env']

/**
 * 不需要映射进 panel 容器的变量。
 *
 * 三类：① compose 文件插值专用（如 BSP_STACK_DIR 供安装器定位面板目录）；
 * ② 面板容器自己不做这件事、只由别的组件消费的（如 SteamCMD 子容器代理）；
 * ③ 只在宿主机 / 安装器 / 开发机上生效的调试开关。
 */
const COMPOSE_EXEMPT = new Set([
  // ② SteamCMD 子容器专用：由面板透传给孩子容器，面板自身不读
  'BSP_STEAMCMD_HTTP_PROXY',
  'BSP_STEAMCMD_HTTPS_PROXY',
  'BSP_STEAMCMD_NO_PROXY',
  // ① compose / 安装器插值
  'BSP_STACK_DIR',
  'BSP_COMPOSE_FILES',
  'BSP_PANEL_MEMORY_LIMIT',
  'BSP_WEB_MEMORY_LIMIT',
  // ③ 安装器与开发机
  'BSP_INSTALL_DIR',
  'BSP_DEV_NPM_REGISTRY',
  'BSP_DEV_AUTO_SEED',
  'BSP_DEV_COMPOSE_QUIET',
  'BSP_UNIT_TEST',
])

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

/** 归一化：统一换行、去掉行尾空白与末尾空行，避免 CRLF/编辑器空格造成假差异 */
function normalize(text) {
  return `${text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '')}\n`
}

function extractBuiltinPreset(installer, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `^[ \\t]*${escaped}\\)[ \\t]*\\n[ \\t]*content="\\$\\(cat <<'EOF'\\n([\\s\\S]*?)\\nEOF\\n\\)"`,
    'm',
  )
  const match = pattern.exec(installer)
  return match ? match[1] : null
}

function describeDifference(expected, actual) {
  const expectedLines = expected.split('\n')
  const actualLines = actual.split('\n')
  const lines = []
  const total = Math.max(expectedLines.length, actualLines.length)
  for (let index = 0; index < total; index += 1) {
    const left = expectedLines[index]
    const right = actualLines[index]
    if (left !== right) {
      lines.push(`    第 ${index + 1} 行：`)
      lines.push(`      仓库文件： ${left ?? '(无)'}`)
      lines.push(`      安装器内置：${right ?? '(无)'}`)
    }
  }
  return lines.join('\n')
}

function main() {
  const installer = readText('scripts/install.linux.sh')
  const failures = []

  for (const name of PRESET_NAMES) {
    const repoContent = normalize(readText(`config/panel.env.presets/${name}`))
    const builtin = extractBuiltinPreset(installer, name)
    if (builtin === null) {
      failures.push(`[presets] scripts/install.linux.sh 里找不到 ${name} 的内置 heredoc`)
      continue
    }
    const builtinContent = normalize(builtin)
    if (builtinContent !== repoContent) {
      failures.push(
        `[presets] ${name} 的两份拷贝不一致（config/panel.env.presets/${name} vs scripts/install.linux.sh 内置）\n${
          describeDifference(repoContent, builtinContent)}`,
      )
    }
  }

  // 预设引用的变量必须都在 panel.env.example 里有说明，否则用户改完不知道它做什么
  const example = readText('panel.env.example')
  const documented = new Set(
    [...example.matchAll(/^#?\s*(BSP_[A-Z0-9_]+)=/gm)].map(match => match[1]),
  )
  const presetKeys = new Set()
  for (const name of PRESET_NAMES) {
    for (const line of readText(`config/panel.env.presets/${name}`).split('\n')) {
      const match = /^(BSP_[A-Z0-9_]+)=/.exec(line.trim())
      if (match) {
        presetKeys.add(match[1])
      }
    }
  }
  for (const key of [...presetKeys].sort()) {
    if (!documented.has(key)) {
      failures.push(`[presets] ${key} 出现在预设里，但 panel.env.example 没有任何说明`)
    }
  }

  // 反向检查：panel.env.example 里说明过的变量，必须在 docker-compose.yml 的 panel 服务
  // environment 段里被显式映射。compose 的 --env-file 只做文件插值，不映射就进不了容器——
  // 历史上 BSP_STEAM_WEBAPI_KEY / BSP_GITHUB_API_BASE 就是这样「文档写了、配了没用」。
  const composeVars = new Set(
    [...readText('docker-compose.yml').matchAll(/^\s{6}([A-Z][A-Z0-9_]*):\s/gm)].map(match => match[1]),
  )
  for (const key of [...documented].sort()) {
    if (!key.startsWith('BSP_')) {
      continue
    }
    if (COMPOSE_EXEMPT.has(key)) {
      continue
    }
    if (!composeVars.has(key)) {
      failures.push(`[compose] ${key} 在 panel.env.example 里有说明，但 docker-compose.yml 的 environment 段没有映射它（配了也不会生效）`)
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure)
    }
    process.exit(1)
  }
  console.log(`[presets] ${PRESET_NAMES.length} 份内存预设与安装器内置拷贝一致，变量均有文档且已映射进 panel 容器`)
}

main()
