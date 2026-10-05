import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  CONSOLE_LOG_KEEP_FILES,
  CONSOLE_LOG_MAX_BYTES,
  formatConsoleLogLine,
  InstanceConsoleLogFile,
  resolveConsoleLogFilePath,
  resolveConsoleLogsDir,
} from './console-log-file'
import type { ConsoleLogLine } from './console-log-store'

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsp-console-log-'))
  tempDirs.push(dir)
  return dir
}

function buildLine(text: string, overrides: Partial<ConsoleLogLine> = {}): ConsoleLogLine {
  return {
    id: 1,
    stream: 'stdout',
    text,
    at: '2026-09-15T12:00:00.000Z',
    shard: 'master',
    ...overrides,
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('console-log-file', () => {
  it('resolves the log directory next to the install logs', () => {
    assert.equal(
      resolveConsoleLogsDir('/var/lib/bubblesharkpanel/panel.sqlite'),
      path.join('/var/lib/bubblesharkpanel', 'install-logs', 'console'),
    )
  })

  it('formats shard and panel source into a single readable line', () => {
    assert.equal(
      formatConsoleLogLine(buildLine('world loaded', { shard: 'caves' })),
      '2026-09-15T12:00:00.000Z [caves] world loaded',
    )
    assert.equal(
      formatConsoleLogLine(buildLine('实例已启动', { stream: 'system', shard: null })),
      '2026-09-15T12:00:00.000Z [panel] 实例已启动',
    )
  })

  it('appends lines and reads back the tail', () => {
    const dir = createTempDir()
    const store = new InstanceConsoleLogFile(dir)

    store.append('inst-1', buildLine('first'))
    store.append('inst-1', buildLine('second'))
    store.append('inst-2', buildLine('other instance'))

    assert.equal(store.readTail('inst-1'), [
      '2026-09-15T12:00:00.000Z [master] first',
      '2026-09-15T12:00:00.000Z [master] second',
    ].join('\n'))
    assert.equal(store.readTail('unknown'), null)
  })

  it('rotates files instead of growing without bound', () => {
    const dir = createTempDir()
    const store = new InstanceConsoleLogFile(dir)
    const filePath = store.resolveFilePath('inst-1')
    // 先写满一个大文件，再追加一行触发轮转
    fs.writeFileSync(filePath, 'x'.repeat(CONSOLE_LOG_MAX_BYTES), 'utf8')
    store.append('inst-1', buildLine('after rotation'))

    assert.equal(fs.existsSync(`${filePath}.1`), true)
    assert.equal(fs.readFileSync(`${filePath}.1`, 'utf8').length, CONSOLE_LOG_MAX_BYTES)
    assert.match(fs.readFileSync(filePath, 'utf8'), /after rotation/)

    // 再触发两次轮转，历史文件数量不超过保留上限
    fs.writeFileSync(filePath, 'y'.repeat(CONSOLE_LOG_MAX_BYTES), 'utf8')
    store.append('inst-1', buildLine('third'))
    fs.writeFileSync(filePath, 'z'.repeat(CONSOLE_LOG_MAX_BYTES), 'utf8')
    store.append('inst-1', buildLine('fourth'))

    const rotated = fs.readdirSync(dir).filter(name => name.startsWith(`${path.basename(filePath)}.`))
    assert.equal(rotated.length, CONSOLE_LOG_KEEP_FILES - 1)
    assert.equal(fs.existsSync(`${filePath}.${CONSOLE_LOG_KEEP_FILES}`), false)
  })

  it('limits the tail to the requested line count', () => {
    const dir = createTempDir()
    const store = new InstanceConsoleLogFile(dir)
    for (let index = 0; index < 10; index += 1) {
      store.append('inst-1', buildLine(`line-${index}`))
    }
    const tail = store.readTail('inst-1', 3)
    assert.equal(tail?.split('\n').length, 3)
    assert.match(tail ?? '', /line-9$/)
  })

  it('removes every file of an instance, including rotated ones', () => {
    const dir = createTempDir()
    const store = new InstanceConsoleLogFile(dir)
    const filePath = resolveConsoleLogFilePath(dir, 'inst-1')
    store.append('inst-1', buildLine('current'))
    fs.writeFileSync(`${filePath}.1`, 'rotated', 'utf8')

    store.remove('inst-1')
    assert.equal(fs.existsSync(filePath), false)
    assert.equal(fs.existsSync(`${filePath}.1`), false)
    // 删除不存在的实例日志不抛错
    store.remove('inst-1')
  })

  it('keeps sanitized instance ids inside the log directory', () => {
    const dir = createTempDir()
    const store = new InstanceConsoleLogFile(dir)
    // 实例 ID 会拼进文件名：路径分隔符必须被消掉，最终文件仍落在日志目录内
    const filePath = store.resolveFilePath('../../evil')
    assert.equal(path.dirname(filePath), dir)
    assert.equal(path.basename(filePath).includes('/'), false)
    assert.equal(path.basename(filePath).includes('\\'), false)

    store.append('../../evil', buildLine('x'))
    assert.equal(fs.readdirSync(dir).length, 1)
  })
})
