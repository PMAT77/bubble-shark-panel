import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { InstanceResourcesPayload, InstanceStartupSnapshot, ResourceSnapshot } from '@/api/modules/instance'
import { resourceOomKillCount, resourceRecommendationWarning } from './resourceSettingsPresentation'

const recommendation: InstanceResourcesPayload['recommendation'] = {
  masterMemoryMb: 2816, cavesMemoryMb: 2560, modCount: 40, estimatedMb: 1792,
  measuredAt: '2026-10-10T10:00:00Z', masterPeakMb: 2300, cavesPeakMb: null,
}

it('低于后端推荐的已保存硬限提示风险，不把不限或禁用洞穴误判为不足', () => {
  const effective = { masterMemoryMb: 1536, cavesMemoryMb: 1536, shardReadyWaitSec: 300 }
  assert.match(resourceRecommendationWarning(effective, recommendation, true) ?? '', /主世界、洞穴.*低于推荐值/)
  const single = resourceRecommendationWarning({ ...effective, masterMemoryMb: null }, recommendation, false)
  assert.equal(single, null)
  assert.equal(resourceRecommendationWarning({ ...effective, masterMemoryMb: 2816, cavesMemoryMb: 0 }, recommendation, true), null)
  assert.match(resourceRecommendationWarning({ ...effective, masterMemoryMb: null }, recommendation, true) ?? '', /洞穴内存/)
})

it('启动中 OOM 展示本轮增量，未知增量不能显示历史累计；终态使用当前运行数据', () => {
  const startup: InstanceStartupSnapshot = {
    taskId: 'startup', status: 'running', phase: 'master_loading', startedAt: '2026-10-10T10:00:00Z',
    phaseStartedAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:03Z', phaseDeadlineAt: null,
    elapsedSeconds: 3, remainingSeconds: null, diagnosis: null,
    master: { state: 'loading', memoryPeakMb: null, resourceDeltas: { highEvents: 0, maxEvents: 0, oomKillCount: 0, throttledUsec: 0, restarts: 0 } },
    caves: { state: 'pending', memoryPeakMb: null },
  }
  const current: ResourceSnapshot = {
    memoryCurrentMb: null, memoryPeakMb: null, memoryMaxMb: null, swapCurrentMb: null, swapMaxMb: null,
    memoryHighMb: null, highEvents: null, maxEvents: null, oomKillCount: 8, memoryPressureFullAvg10: null,
    throttledUsec: null, exitCode: null, restarts: null, oomKilled: null, measuredAt: startup.updatedAt,
  }
  assert.equal(resourceOomKillCount(startup, 'master', current), 0)
  assert.equal(resourceOomKillCount(startup, 'caves', current), null)
  assert.equal(resourceOomKillCount({ ...startup, status: 'success', phase: 'ready' }, 'master', current), 8)
  assert.equal(resourceOomKillCount(null, 'master', null), null)
})
