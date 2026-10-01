import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildRuntimeFailureWarning, classifyRuntimeFailure } from './runtime-failure.ts'

function makeInput(overrides: Partial<Parameters<typeof classifyRuntimeFailure>[0]> = {}) {
  return {
    readySeen: false,
    restarts: 0,
    bufferMb: 4096,
    loadingSeconds: 60,
    notReadyAfterSec: 900,
    ...overrides,
  }
}

/**
 * 归因决定界面给不给「增加缓存区」：把 Mod 报错误判成内存问题会让人白折腾一轮缓存区，
 * 反过来把内存问题说成 Mod 问题则什么都不会改善。所以每条判据都要有测试钉住。
 */
describe('classifyRuntimeFailure', () => {
  it('已经就绪就不给归因，免得界面上一直挂着「当初没起来」的引导', () => {
    assert.equal(classifyRuntimeFailure(makeInput({ readySeen: true, memOomKillCount: 3 })), null)
  })

  it('cgroup OOM 计数是最确凿的证据，带上次数与上限', () => {
    const failure = classifyRuntimeFailure(makeInput({
      restarts: 3,
      memOomKillCount: 3,
      memPeakMb: 1520,
      shardCapMb: 1536,
    }))
    assert.ok(failure)
    assert.equal(failure.kind, 'memory')
    assert.match(failure.detail, /终止过 3 次/)
    assert.match(failure.detail, /上限 1536 MiB/)
    assert.match(failure.detail, /峰值约 1520 MiB/)
  })

  it('systemd 记下的 oom-kill 同样算内存证据（重启成功会被重置，所以只作补充）', () => {
    const failure = classifyRuntimeFailure(makeInput({ exitResult: 'oom-kill', shardCapMb: 1024 }))
    assert.ok(failure)
    assert.equal(failure.kind, 'memory')
    assert.match(failure.detail, /内存不足被系统终止（该分片上限 1024 MiB）/)
  })

  it('反复重启且可用缓冲见底：没有直接证据时按内存推断', () => {
    const failure = classifyRuntimeFailure(makeInput({ restarts: 2, bufferMb: 775 }))
    assert.ok(failure)
    assert.equal(failure.kind, 'memory')
    assert.match(failure.detail, /可用缓冲仅 775 MiB/)
  })

  it('同样反复重启但内存宽松时不下内存结论，改让人去看日志', () => {
    const failure = classifyRuntimeFailure(makeInput({ restarts: 2, bufferMb: 4096 }))
    assert.ok(failure)
    assert.equal(failure.kind, 'not_ready')
    assert.match(failure.detail, /退出过 2 次/)
  })

  it('一次没崩、只是加载超时：也算未就绪，但不说内存', () => {
    const failure = classifyRuntimeFailure(makeInput({ loadingSeconds: 16 * 60 }))
    assert.ok(failure)
    assert.equal(failure.kind, 'not_ready')
    assert.match(failure.detail, /已加载 16 分钟仍未就绪/)
  })

  it('刚启动、没崩过、也没超时：不给结论', () => {
    assert.equal(classifyRuntimeFailure(makeInput({ loadingSeconds: 30 })), null)
  })

  it('读不到可用缓冲时不做内存推断（拿不到证据就不猜）', () => {
    const failure = classifyRuntimeFailure(makeInput({ restarts: 1, bufferMb: null }))
    assert.ok(failure)
    assert.equal(failure.kind, 'not_ready')
  })
})

describe('buildRuntimeFailureWarning', () => {
  it('内存归因指向增加缓存区，并保留减 Mod / 关洞穴两条出路', () => {
    const warning = buildRuntimeFailureWarning({ kind: 'memory', detail: '内存不足被系统终止' })
    assert.match(warning, /先停止实例/)
    assert.match(warning, /增加缓存区/)
    assert.match(warning, /减少订阅的 Mod/)
    assert.match(warning, /关闭洞穴分片/)
  })

  it('非内存归因指向控制台日志，避免误导去加缓存区', () => {
    const warning = buildRuntimeFailureWarning({ kind: 'not_ready', detail: '世界在加载途中退出过 2 次，尚未就绪' })
    assert.match(warning, /控制台/)
    assert.doesNotMatch(warning, /增加缓存区/)
  })
})
