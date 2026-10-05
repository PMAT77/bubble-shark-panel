import fs from 'node:fs'
import path from 'node:path'

/**
 * 把「面板端口」设置落到部署配置上。
 *
 * 背景：面板实际监听/对外的端口只来自部署配置——Docker 部署读 `panel.env` 的 `PANEL_PORT`
 * （决定宿主机端口映射，容器内恒为 8888），Native/systemd 部署读同一文件的 `SERVER_PORT`。
 * 数据库里的 `panelPort` 此前没有任何代码消费，设置页改完再重启也不会换端口，
 * 「需重启面板才能生效」于是成了空头支票。
 *
 * 这里在保存设置时把新端口写进配置文件，用户下次重启面板时自然生效（刻意不自动重建面板：
 * 重建会立刻掐断当前连接，而用户本来就预期"下次重启生效"）。
 *
 * 面板容器对部署目录是只读挂载（`docker-compose.bind.yml` 的 `/stack:ro`），因此 Docker 部署
 * 借一次性容器写入（与一键更新同一套镜像解析）；Native 部署直接写文件，权限不足则退化为手动命令。
 */

export type PanelPortEnvKey = 'PANEL_PORT' | 'SERVER_PORT'

/** written=已写入配置；unchanged=与当前端口一致；skipped=该环境无需处理；manual=需要用户手动改 */
export type PanelPortSyncStatus = 'written' | 'unchanged' | 'skipped' | 'manual'

export interface PanelPortSyncResult {
  status: PanelPortSyncStatus
  envKey: PanelPortEnvKey | null
  port: number
  /** 面向用户的一句话说明（成功与失败都要能据此行动） */
  message: string
  /** manual 时给出的可复制命令 */
  manualCommand: string | null
}

export const DEFAULT_STACK_DIR = '/opt/bubblesharkpanel'
export const PANEL_ENV_FILENAME = 'panel.env'

/** 在配置文件内容里替换或追加一个键；注释、其他键与顺序都保持原样，行尾统一为 LF */
export function upsertEnvValueInContent(content: string, key: string, value: string | number): string {
  const nextLines = content.replace(/\r\n/g, '\n').split('\n')
  // 文件结尾换行会split出一个空尾项，先摘掉，最后统一补回一个换行
  if (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') {
    nextLines.pop()
  }
  let replaced = false
  for (let index = 0; index < nextLines.length; index += 1) {
    const line = nextLines[index]
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const separatorIndex = line.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }
    if (line.slice(0, separatorIndex).trim() !== key) {
      continue
    }
    replaced = true
    nextLines[index] = `${key}=${value}`
  }
  if (!replaced) {
    nextLines.push(`${key}=${value}`)
  }
  return `${nextLines.join('\n')}\n`
}

/**
 * 一次性容器内执行的脚本：先备份 panel.env，再写入端口。
 * 刻意不执行 compose up——端口在用户下次重启面板时生效。
 */
export function buildPanelPortWriteScript(envKey: PanelPortEnvKey, port: number): string {
  return [
    'set -e',
    'cd /stack',
    'backup="panel.env.bak.$(date +%Y%m%d%H%M%S)"',
    'cp panel.env "$backup"',
    `if grep -q '^${envKey}=' panel.env; then`,
    `  sed -i 's|^${envKey}=.*|${envKey}=${port}|' panel.env`,
    'else',
    `  printf '%s\\n' '${envKey}=${port}' >> panel.env`,
    'fi',
    `echo "[bsp] 已写入 ${envKey}=${port}（备份：$backup）"`,
  ].join('\n')
}

/** 无法自动写入时给用户的手动命令；Docker 与 Native 的重启方式不同 */
export function buildPanelPortManualCommand(input: {
  runtimeMode: 'docker' | 'native'
  stackDir?: string
  composeFiles?: string[]
  envKey: PanelPortEnvKey
  port: number
}): string {
  const stackDir = input.stackDir?.trim() || DEFAULT_STACK_DIR
  const envFile = `${stackDir}/${PANEL_ENV_FILENAME}`
  const replacePort = `sudo sed -i 's|^${input.envKey}=.*|${input.envKey}=${input.port}|' ${envFile}`
  if (input.runtimeMode === 'native') {
    return [replacePort, 'sudo bsp restart'].join('\n')
  }
  const composeFiles = input.composeFiles?.length
    ? input.composeFiles
    : ['docker-compose.yml', 'docker-compose.bind.yml']
  const composeArgs = composeFiles.map(file => `-f ${file}`).join(' ')
  return [
    `cd ${stackDir}`,
    `sudo sed -i 's|^${input.envKey}=.*|${input.envKey}=${input.port}|' ${PANEL_ENV_FILENAME}`,
    `docker compose --env-file ${PANEL_ENV_FILENAME} ${composeArgs} up -d panel`,
  ].join('\n')
}

/**
 * 找出 Native 部署真正在用的 panel.env：候选文件必须存在且含目标键，
 * 避免把端口写进一个无关的同名文件。
 */
export function resolvePanelEnvFileWithKey(candidates: string[], key: PanelPortEnvKey): string | null {
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) {
        continue
      }
      if (new RegExp(`^${key}=`, 'm').test(fs.readFileSync(candidate, 'utf8'))) {
        return candidate
      }
    }
    catch {
      // 读不了就换下一个候选
    }
  }
  return null
}

/** Native 部署的 panel.env 候选：安装目录默认 /opt/bubblesharkpanel */
export function buildPanelEnvCandidates(stackDir: string): string[] {
  const dir = stackDir.trim() || DEFAULT_STACK_DIR
  return [path.join(dir, PANEL_ENV_FILENAME)]
}

/** 就地写入端口，写前留一份带时间戳的备份 */
export function writePanelEnvPort(envFile: string, key: PanelPortEnvKey, port: number): void {
  const content = fs.readFileSync(envFile, 'utf8')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.writeFileSync(`${envFile}.bak.${stamp}`, content, 'utf8')
  fs.writeFileSync(envFile, upsertEnvValueInContent(content, key, port), 'utf8')
}
