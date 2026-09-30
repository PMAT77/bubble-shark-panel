import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModItemDto } from '@/api/modules/mod'
import { countOutdatedMods, resolveUpdateIneffectiveNotice, selectUpdatableMods } from './modUpdateTargets.ts'

function createMod(overrides: Partial<ModItemDto> & { workshopId: string }): ModItemDto {
  return {
    id: overrides.workshopId,
    workshopId: overrides.workshopId,
    name: `Mod ${overrides.workshopId}`,
    previewImage: null,
    rating: null,
    enabled: true,
    loadOrder: 0,
    version: null,
    installStatus: 'ready',
    installError: null,
    localUpdatedAt: null,
    remoteUpdatedAt: null,
    updateCheckedAt: null,
    updateStatus: 'unknown',
    dependencyIds: [],
    missingDependencyIds: [],
    dependentModIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('selectUpdatableMods', () => {
  it('只把「就绪、有新版本、且不在下载中」的 Mod 算作更新目标', () => {
    const mods = [
      createMod({ workshopId: '1', updateStatus: 'outdated' }),
      // 正在下载中：不能算进「全部更新」，否则按钮显示 N 个却点了没反应
      createMod({ workshopId: '2', updateStatus: 'outdated' }),
      createMod({ workshopId: '3', updateStatus: 'up_to_date' }),
      createMod({ workshopId: '4', updateStatus: 'outdated', installStatus: 'pending' }),
      createMod({ workshopId: '5', updateStatus: 'outdated', installStatus: 'failed' }),
    ]
    const downloading = new Set(['2'])

    const targets = selectUpdatableMods(mods, workshopId => downloading.has(workshopId))

    assert.deepEqual(targets.map(mod => mod.workshopId), ['1'])
    // 但「有 2 个 Mod 有新版本」这件事本身仍然是事实：提示要能说清是「正在下载」而不是「没有」
    assert.equal(countOutdatedMods(mods), 4)
  })

  it('没有任何可更新目标时返回空数组', () => {
    const mods = [createMod({ workshopId: '1', updateStatus: 'up_to_date' })]
    assert.deepEqual(selectUpdatableMods(mods, () => false), [])
  })
})

describe('resolveUpdateIneffectiveNotice', () => {
  it('队列刚跑完却仍有可更新项时说清原因', () => {
    const notice = resolveUpdateIneffectiveNotice({
      wasRunning: true,
      status: 'idle',
      updatableCount: 3,
    })
    assert.ok(notice)
    assert.match(notice, /仍有 3 个 Mod 显示有新版本/)
  })

  it('手动暂停、还在运行、或已经没有可更新项时都不提示', () => {
    assert.equal(resolveUpdateIneffectiveNotice({ wasRunning: true, status: 'paused', updatableCount: 3 }), null)
    assert.equal(resolveUpdateIneffectiveNotice({ wasRunning: true, status: 'running', updatableCount: 3 }), null)
    assert.equal(resolveUpdateIneffectiveNotice({ wasRunning: true, status: 'idle', updatableCount: 0 }), null)
    assert.equal(resolveUpdateIneffectiveNotice({ wasRunning: false, status: 'idle', updatableCount: 3 }), null)
  })
})
