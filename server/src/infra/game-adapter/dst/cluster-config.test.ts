import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildDstLaunchArgs } from './cluster-config'

describe('buildDstLaunchArgs', () => {
  it('skips the server mod update pass', () => {
    /**
     * 面板已经用 SteamCMD 下载并落位 Mod，DST 不该再联网核对一遍：
     * 少了这个参数，Mod 一多就会把 CPU、带宽与磁盘占满，小机器陷入
     * 「启动 → 超时 → 崩溃 → 重启」的循环，玩家始终连不上。
     */
    assert.ok(buildDstLaunchArgs('/srv/bsp/instance-1').includes('-skip_update_server_mods'))
  })

  it('points the shard at its cluster and opens the console', () => {
    assert.deepEqual(buildDstLaunchArgs('/srv/bsp/instance-1', 'Caves'), [
      '-persistent_storage_root',
      '/srv/bsp/instance-1',
      '-conf_dir',
      'DoNotStarveTogether',
      '-cluster',
      'Cluster_1',
      '-shard',
      'Caves',
      '-console',
      '-skip_update_server_mods',
    ])
  })

  it('defaults to the master shard', () => {
    const args = buildDstLaunchArgs('/srv/bsp/instance-1')
    const shardIndex = args.indexOf('-shard')
    assert.equal(args[shardIndex + 1], 'Master')
  })
})
