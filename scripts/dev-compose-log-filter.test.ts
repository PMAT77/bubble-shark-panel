import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { filterDevComposeLogLine } from './dev-compose-log-filter.ts'

describe('filterDevComposeLogLine', () => {
  it('drops vite and fantastic-admin noise', () => {
    assert.equal(filterDevComposeLogLine('web-1  |   VITE v8.0.13  ready in 2785 ms'), null)
    assert.equal(filterDevComposeLogLine('web-1  |    ║       由 Fantastic-admin 驱动        ║'), null)
    assert.equal(filterDevComposeLogLine('[vite-plugin-svg-spritemap] Using SVGO'), null)
  })

  it('formats key panel startup logs', () => {
    const line = 'bubblesharkpanel-panel  | {"level":30,"msg":"后端服务已启动: http://0.0.0.0:3000"}'
    assert.equal(filterDevComposeLogLine(line), '[panel] 后端服务已启动: http://0.0.0.0:3000')
  })

  it('keeps errors and warnings', () => {
    assert.match(filterDevComposeLogLine('panel  | something failed with Error: boom')!, /Error/)
    assert.match(filterDevComposeLogLine('[ensure-steamcmd-image] 拉取失败: image')!, /拉取失败/)
  })
})
