import type { DbSystemPanelSettings } from './types'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { closeDatabase, getSystemPanelSettings, initDatabase, saveSystemPanelSettings } from './index'

const dbFilePath = path.join(os.tmpdir(), `bsp-panel-settings-test-${randomUUID()}.sqlite`)
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle')

function buildSettings(overrides: Partial<DbSystemPanelSettings> = {}): DbSystemPanelSettings {
  return {
    panelPort: 9527,
    theme: 'system',
    autoUpdate: true,
    checkUpdateBeforeStart: false,
    updateCheckIntervalHours: 3,
    updateSource: 'auto',
    ...overrides,
  }
}

describe('panel settings persistence', () => {
  before(async () => {
    await initDatabase(dbFilePath, migrationsFolder)
  })

  after(async () => {
    await closeDatabase()
    fs.rmSync(dbFilePath, { force: true })
  })

  it('treats rows written before updateSource existed as auto', async () => {
    const legacy = buildSettings()
    delete (legacy as { updateSource?: unknown }).updateSource
    await saveSystemPanelSettings(legacy)

    const settings = await getSystemPanelSettings()
    // 升级路径：老库里的 JSON 没有这个字段，必须回落成 auto 而不是 undefined
    assert.equal(settings?.updateSource, 'auto')
  })

  it('keeps an explicitly chosen download source', async () => {
    await saveSystemPanelSettings(buildSettings({ updateSource: 'offline' }))
    assert.equal((await getSystemPanelSettings())?.updateSource, 'offline')

    await saveSystemPanelSettings(buildSettings({ updateSource: 'pull' }))
    assert.equal((await getSystemPanelSettings())?.updateSource, 'pull')
  })

  it('normalizes an unknown download source back to auto', async () => {
    await saveSystemPanelSettings(buildSettings({ updateSource: 'nonsense' as never }))
    assert.equal((await getSystemPanelSettings())?.updateSource, 'auto')
  })
})
