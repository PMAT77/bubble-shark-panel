import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { resolveRepoRoot } from '../repo-root'

/**
 * panel.env 里的键必须同时在 compose 的 environment: 中显式映射才会进入容器：
 * `docker compose --env-file panel.env` 只做 compose 文件里的 ${} 插值。
 * 漏掉 ADMIN_PASSWORD / FORCE_PASSWORD_CHANGE 会导致容器随机生成密码、且首次登录不强制改密。
 */
const REQUIRED_PANEL_ENV_KEYS = [
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'FORCE_PASSWORD_CHANGE',
  'BSP_SYNC_ADMIN_PASSWORD_FROM_ENV',
  'BSP_PASSWORD_RECOVERY_TOKEN',
  // 面板内一键更新：updater 容器镜像覆盖项，漏映射会让用户设了也不生效
  'BSP_PANEL_UPDATER_IMAGE',
]

const REQUIRED_DEV_PANEL_ENV_KEYS = [
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'BSP_PANEL_UPDATER_IMAGE',
]

/** 取第一个匹配的服务块中 environment: 段下的键名（compose 缩进固定：服务 2 空格、键 4 空格、条目 6 空格） */
function extractEnvironmentKeys(content: string, serviceName: string): string[] {
  const lines = content.split(/\r?\n/)
  const serviceStart = lines.findIndex(line => new RegExp(`^  ${serviceName}:\\s*$`).test(line))
  assert.notEqual(serviceStart, -1, `compose 缺少服务 ${serviceName}`)

  const envStart = lines.findIndex((line, index) => index > serviceStart && /^ {4}environment:\s*$/.test(line))
  assert.notEqual(envStart, -1, `服务 ${serviceName} 缺少 environment 段`)

  const keys: string[] = []
  for (let index = envStart + 1; index < lines.length; index++) {
    const line = lines[index]!
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent <= 4) {
      break
    }
    const matched = /^([A-Z_][A-Z0-9_]*):/.exec(trimmed)
    if (matched?.[1]) {
      keys.push(matched[1])
    }
  }
  return keys
}

function readComposeFile(filename: string): string {
  return fs.readFileSync(path.join(resolveRepoRoot(), filename), 'utf8')
}

describe('docker compose 环境变量透传', () => {
  it('production compose 把 panel.env 的管理员凭证与首登策略映射进容器', () => {
    const keys = extractEnvironmentKeys(readComposeFile('docker-compose.yml'), 'panel')
    for (const key of REQUIRED_PANEL_ENV_KEYS) {
      assert.ok(keys.includes(key), `docker-compose.yml 的 panel 服务缺少 environment 键 ${key}`)
    }
  })

  it('dev compose 仍保留管理员凭证映射', () => {
    const keys = extractEnvironmentKeys(readComposeFile('docker-compose.dev.yml'), 'panel')
    for (const key of REQUIRED_DEV_PANEL_ENV_KEYS) {
      assert.ok(keys.includes(key), `docker-compose.dev.yml 的 panel 服务缺少 environment 键 ${key}`)
    }
  })
})
