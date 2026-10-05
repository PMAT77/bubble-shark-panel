import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { InstanceConsoleLogLine } from '@/api/modules/instance'
import { filterConsoleLines, formatConsoleLogLineForCopy, isCommandEcho } from './consoleLogDisplay.ts'

function makeLine(partial: Partial<InstanceConsoleLogLine> & { text: string }): InstanceConsoleLogLine {
  return {
    id: 1,
    stream: 'stdout',
    at: '2026-09-15T19:41:01.000Z',
    shard: null,
    ...partial,
  }
}

/** 面板消息 / 游戏输出 / 错误输出各一条，外加一条命令回显 */
function sampleLines(): InstanceConsoleLogLine[] {
  return [
    makeLine({ id: 1, stream: 'system', text: '已连接地上运行时，开始采集控制台输出', shard: 'master' }),
    makeLine({ id: 2, stream: 'system', text: '> print("BSP_PLAYER_COUNT:abc:")', shard: 'master' }),
    makeLine({ id: 3, stream: 'stdout', text: 'KU_Mjne0Map 玩家甲', shard: 'master' }),
    makeLine({ id: 4, stream: 'stderr', text: 'attempt to index a nil value', shard: 'caves' }),
  ]
}

describe('filterConsoleLines', () => {
  it('returns every line for the all filter', () => {
    const lines = sampleLines()
    assert.deepEqual(filterConsoleLines(lines, 'all'), lines)
  })

  it('keeps only game output for the game filter', () => {
    const filtered = filterConsoleLines(sampleLines(), 'game')
    assert.deepEqual(filtered.map(line => line.id), [3, 4])
  })

  it('keeps only panel messages for the panel filter', () => {
    const filtered = filterConsoleLines(sampleLines(), 'panel')
    assert.deepEqual(filtered.map(line => line.id), [1, 2])
  })

  it('preserves the original order of the input', () => {
    const lines = sampleLines()
    const filtered = filterConsoleLines(lines, 'game')
    assert.ok(filtered[0].id < filtered[1].id)
  })

  it('does not mutate the input array', () => {
    const lines = sampleLines()
    filterConsoleLines(lines, 'panel')
    filterConsoleLines(lines, 'game')
    assert.equal(lines.length, 4)
  })

  it('handles an empty input', () => {
    assert.deepEqual(filterConsoleLines([], 'all'), [])
    assert.deepEqual(filterConsoleLines([], 'game'), [])
    assert.deepEqual(filterConsoleLines([], 'panel'), [])
  })
})

describe('isCommandEcho', () => {
  it('detects the panel echo of a sent command', () => {
    assert.equal(isCommandEcho(makeLine({ stream: 'system', text: '> c_save()' })), true)
  })

  it('ignores game output that merely starts with the same prefix', () => {
    assert.equal(isCommandEcho(makeLine({ stream: 'stdout', text: '> not from the panel' })), false)
  })

  it('ignores other panel messages', () => {
    assert.equal(isCommandEcho(makeLine({ stream: 'system', text: 'Server paused' })), false)
  })

  it('requires the separator after the marker', () => {
    assert.equal(isCommandEcho(makeLine({ stream: 'system', text: '>' })), false)
  })
})

describe('formatConsoleLogLineForCopy', () => {
  it('prefixes the shard label when present', () => {
    assert.equal(
      formatConsoleLogLineForCopy(makeLine({ text: 'hello', shard: 'master' })),
      '[地上] hello',
    )
    assert.equal(
      formatConsoleLogLineForCopy(makeLine({ text: 'hello', shard: 'caves' })),
      '[洞穴] hello',
    )
  })

  it('omits the prefix when the line has no shard', () => {
    assert.equal(formatConsoleLogLineForCopy(makeLine({ text: 'hello', shard: null })), 'hello')
    assert.equal(formatConsoleLogLineForCopy(makeLine({ text: 'hello', shard: undefined })), 'hello')
  })
})
