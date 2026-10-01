import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildRestartLoopWarning, shouldClearRuntimeWarning } from './runtime-warning.ts'

/**
 * 线上实测的读数：「运行时长 16 分 55 秒 + 实例进程反复重启（已重启 1 次）」。
 *
 * 这两句话并不矛盾——`NRestarts` 是累计值，面板记的启动时刻又是点启动的那一刻，
 * 进程被 systemd 拉起后不会更新。真正要区分的是「现在还在崩」与「启动时崩过一次、
 * 之后一直稳跑」，判据只能是当前进程连续运行了多久。
 */
describe('buildRestartLoopWarning', () => {
  it('没重启过就不写警告', () => {
    assert.equal(
      buildRestartLoopWarning({ restarts: 0, restarting: false, uptimeSeconds: 30 }),
      null,
    )
  })

  it('正在被 auto-restart 拉起时，即便跑了很久也照实说反复重启', () => {
    const message = buildRestartLoopWarning({ restarts: 3, restarting: true, uptimeSeconds: 20 * 60 })
    assert.ok(message)
    assert.match(message, /反复重启（已重启 3 次）/)
    assert.match(message, /减少订阅的 Mod/)
  })

  it('重启后刚跑了几分钟，还不能算站稳', () => {
    const message = buildRestartLoopWarning({ restarts: 1, restarting: false, uptimeSeconds: 3 * 60 })
    assert.ok(message)
    assert.match(message, /反复重启/)
  })

  it('读不到运行时长时按仍在崩说，不把崩溃循环说成已恢复', () => {
    const message = buildRestartLoopWarning({ restarts: 2, restarting: false })
    assert.ok(message)
    assert.match(message, /反复重启（已重启 2 次）/)
  })

  it('启动阶段崩过一次、之后稳跑 20 分钟：改说启动阶段崩溃，不再让人去减 Mod', () => {
    const message = buildRestartLoopWarning({ restarts: 1, restarting: false, uptimeSeconds: 20 * 60 })
    assert.ok(message)
    assert.match(message, /启动阶段崩溃过 1 次/)
    assert.match(message, /当前进程已恢复运行/)
    assert.match(message, /大厅仍搜不到房间/)
    assert.doesNotMatch(message, /反复重启/)
    assert.doesNotMatch(message, /减少订阅的 Mod/)
  })

  it('已经站稳的文案不随分钟数变化，避免每次对账都写一次库', () => {
    const first = buildRestartLoopWarning({ restarts: 1, restarting: false, uptimeSeconds: 20 * 60 })
    const later = buildRestartLoopWarning({ restarts: 1, restarting: false, uptimeSeconds: 26 * 60 })
    assert.equal(first, later)
  })

  it('两种状态都带上运行时报得出的退出原因', () => {
    const reason = '内存不足被系统终止（该分片上限 1024 MiB）'
    const looping = buildRestartLoopWarning({ restarts: 1, restarting: true, uptimeSeconds: 60, exitReason: reason })
    assert.match(looping ?? '', /最近一次退出：内存不足被系统终止/)
    const recovered = buildRestartLoopWarning({ restarts: 1, restarting: false, uptimeSeconds: 20 * 60, exitReason: reason })
    assert.match(recovered ?? '', /（最近一次退出：内存不足被系统终止（该分片上限 1024 MiB））/)
  })

  it('退出原因为 null 或空串时不留下空的「最近一次退出：」', () => {
    const message = buildRestartLoopWarning({
      restarts: 1,
      restarting: false,
      uptimeSeconds: 20 * 60,
      exitReason: null,
    })
    assert.ok(message)
    assert.doesNotMatch(message, /最近一次退出/)
  })
})

describe('shouldClearRuntimeWarning', () => {
  it('连续干净运行满 30 分钟才清', () => {
    assert.equal(shouldClearRuntimeWarning(30 * 60), true)
    assert.equal(shouldClearRuntimeWarning(30 * 60 - 1), false)
  })

  it('读不到运行时长时不清，避免抹掉正在发生的崩溃告警', () => {
    assert.equal(shouldClearRuntimeWarning(undefined), false)
  })
})
