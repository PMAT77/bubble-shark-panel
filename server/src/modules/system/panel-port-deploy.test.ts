import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  buildPanelEnvCandidates,
  buildPanelPortManualCommand,
  buildPanelPortWriteScript,
  resolvePanelEnvFileWithKey,
  upsertEnvValueInContent,
  writePanelEnvPort,
} from './panel-port-deploy'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bsp-port-${randomUUID()}`))
}

describe('upsertEnvValueInContent', () => {
  it('替换已有键，保留注释与其他键的顺序', () => {
    assert.equal(
      upsertEnvValueInContent('# 面板端口\nPANEL_PORT=9527\nTZ=Asia/Shanghai\n', 'PANEL_PORT', 9278),
      '# 面板端口\nPANEL_PORT=9278\nTZ=Asia/Shanghai\n',
    )
  })

  it('缺少键时追加，并把行尾归一为 LF', () => {
    assert.equal(
      upsertEnvValueInContent('TZ=Asia/Shanghai\r\n', 'PANEL_PORT', 9278),
      'TZ=Asia/Shanghai\nPANEL_PORT=9278\n',
    )
  })

  it('被注释掉的键不算已设置', () => {
    assert.equal(
      upsertEnvValueInContent('# PANEL_PORT=1\n', 'PANEL_PORT', 9278),
      '# PANEL_PORT=1\nPANEL_PORT=9278\n',
    )
  })
})

describe('buildPanelPortWriteScript', () => {
  it('先备份 panel.env 再写入端口，且不重建面板', () => {
    const script = buildPanelPortWriteScript('PANEL_PORT', 9278)
    assert.match(script, /cp panel\.env "\$backup"/)
    assert.match(script, /PANEL_PORT=9278/)
    assert.ok(!script.includes('compose up'))
  })
})

describe('buildPanelPortManualCommand', () => {
  it('Docker 部署给出改配置并重建面板的命令', () => {
    const command = buildPanelPortManualCommand({
      runtimeMode: 'docker',
      stackDir: '/opt/bubblesharkpanel',
      composeFiles: ['docker-compose.yml', 'docker-compose.bind.yml'],
      envKey: 'PANEL_PORT',
      port: 9278,
    })
    assert.match(command, /cd \/opt\/bubblesharkpanel/)
    assert.match(command, /PANEL_PORT=9278/)
    assert.match(command, /docker compose .* up -d panel/)
  })

  it('Native 部署给出改配置并重启服务的命令', () => {
    const command = buildPanelPortManualCommand({
      runtimeMode: 'native',
      envKey: 'SERVER_PORT',
      port: 9278,
    })
    assert.match(command, /SERVER_PORT=9278/)
    assert.match(command, /sudo bsp restart/)
  })
})

describe('resolvePanelEnvFileWithKey', () => {
  it('只认含目标键的文件，避免写错同名文件', () => {
    const dir = makeTempDir()
    const withKey = path.join(dir, 'panel.env')
    const withoutKey = path.join(dir, 'other.env')
    fs.writeFileSync(withKey, 'SERVER_PORT=9527\n', 'utf8')
    fs.writeFileSync(withoutKey, 'TZ=Asia/Shanghai\n', 'utf8')
    assert.equal(resolvePanelEnvFileWithKey([withoutKey, withKey], 'SERVER_PORT'), withKey)
    assert.equal(resolvePanelEnvFileWithKey([withoutKey], 'SERVER_PORT'), null)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('writePanelEnvPort', () => {
  it('写入新端口并留下带时间戳的备份', () => {
    const dir = makeTempDir()
    const envFile = path.join(dir, 'panel.env')
    const original = 'SERVER_PORT=9527\nTZ=Asia/Shanghai\n'
    fs.writeFileSync(envFile, original, 'utf8')
    writePanelEnvPort(envFile, 'SERVER_PORT', 9278)
    assert.equal(fs.readFileSync(envFile, 'utf8'), 'SERVER_PORT=9278\nTZ=Asia/Shanghai\n')
    const backups = fs.readdirSync(dir).filter(name => name.startsWith('panel.env.bak.'))
    assert.equal(backups.length, 1)
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), original)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('buildPanelEnvCandidates', () => {
  it('缺省使用安装目录', () => {
    assert.deepEqual(buildPanelEnvCandidates(''), [path.join('/opt/bubblesharkpanel', 'panel.env')])
  })
})
