import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cleanupOrphanedSteamcmdInstallContainers } from './steamcmd-job.ts'

describe('cleanupOrphanedSteamcmdInstallContainers', () => {
  it('returns 0 when jobId is empty (no global sweep)', async () => {
    assert.equal(await cleanupOrphanedSteamcmdInstallContainers(), 0)
    assert.equal(await cleanupOrphanedSteamcmdInstallContainers('   '), 0)
  })
})

/**
 * dev:compose 手工验收清单：
 * 1. 删除残留 cm2network/steamcmd 容器；error 实例点「更新服务端」→ running 的 bsp-steamcmd-*，日志有 [xx%]
 * 2. 安装中 docker restart bubblesharkpanel-panel → 列表不再永久 installing，可再次更新
 * 3. 取消安装 → 再更新 → 不应秒退「安装已中断」
 */
