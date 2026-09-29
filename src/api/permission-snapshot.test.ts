import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isPermissionSnapshotStale } from './permission-snapshot.ts'

/**
 * 「权限快照过期」的判据。
 *
 * 这条判据决定一个已登录账号在收到 403 之后**要不要重新拉菜单并刷新页面**：
 * 判宽了会在正常无权时白闪页面（还可能成环），判窄了用户就只能自己猜"是不是该刷新一下"。
 */
describe('权限快照是否过期', () => {
  it('两侧集合完全一致时不算过期（与顺序无关）', () => {
    assert.equal(isPermissionSnapshotStale([], []), false)
    assert.equal(isPermissionSnapshotStale(['a', 'b'], ['b', 'a']), false)
    assert.equal(isPermissionSnapshotStale(['room:read'], ['room:read']), false)
  })

  it('被撤销权限时算过期', () => {
    assert.equal(isPermissionSnapshotStale(['room:read', 'instance:read'], ['instance:read']), true)
  })

  it('被补上权限时同样算过期（新入口要出现）', () => {
    assert.equal(isPermissionSnapshotStale(['instance:read'], ['instance:read', 'room:read']), true)
    assert.equal(isPermissionSnapshotStale([], ['plugin:read']), true)
  })

  it('数量相同但内容不同时算过期', () => {
    assert.equal(isPermissionSnapshotStale(['room:read'], ['world:read']), true)
  })

  it('本地快照重复项不影响判定（集合语义）', () => {
    assert.equal(isPermissionSnapshotStale(['room:read', 'room:read'], ['room:read']), false)
  })
})
