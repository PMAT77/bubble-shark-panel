import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  isPanelMasterWorldSaved,
  isPanelRoomSaved,
  markPanelMasterWorldSaved,
  markPanelRoomSaved,
  readPanelConfigMeta,
} from './panel-config-meta.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeInstallPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-panel-meta-'))
  tempDirs.push(dir)
  return dir
}

describe('panel-config-meta', () => {
  it('marks room and master world saves independently', () => {
    const installPath = makeInstallPath()
    assert.equal(isPanelRoomSaved(readPanelConfigMeta(installPath)), false)

    markPanelRoomSaved(installPath)
    const afterRoom = readPanelConfigMeta(installPath)
    assert.equal(isPanelRoomSaved(afterRoom), true)
    assert.equal(isPanelMasterWorldSaved(afterRoom), false)

    markPanelMasterWorldSaved(installPath)
    const afterWorld = readPanelConfigMeta(installPath)
    assert.equal(isPanelRoomSaved(afterWorld), true)
    assert.equal(isPanelMasterWorldSaved(afterWorld), true)
  })
})
