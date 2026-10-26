import assert from 'node:assert/strict'
import { it } from 'node:test'
import { availableInstanceDetailTabs, resolveInstanceDetailTab } from './instanceDetailTabs'
import { routeToDstModList, routeToInstanceDetail } from '@/navigation/game-routes'

it('详情页签按权限和游戏能力开放，无权或无效直达回退概览', () => {
  const readOnly = availableInstanceDetailTabs(() => false, true)
  assert.deepEqual(readOnly, ['overview'])
  assert.equal(resolveInstanceDetailTab('files', readOnly), 'overview')
  const all = availableInstanceDetailTabs(() => true, true)
  assert.deepEqual(all, ['overview', 'commands', 'files', 'migration'])
  for (const tab of all) assert.equal(resolveInstanceDetailTab(tab, all), tab)
  for (const value of [undefined, 'invalid', ['files']]) assert.equal(resolveInstanceDetailTab(value, all), 'overview')
  assert.deepEqual(availableInstanceDetailTabs(() => true, false), ['overview', 'commands', 'files'])
  assert.deepEqual(availableInstanceDetailTabs(permission => permission === 'file:read', true), ['overview', 'files'])
})

it('导航 helper 兼容旧调用，并支持详情页签和当前实例 Mod 链接', () => {
  assert.deepEqual(routeToInstanceDetail('A'), { name: 'nodeInstanceDetail', params: { instanceId: 'A' } })
  assert.deepEqual(routeToInstanceDetail('A', 'files'), { name: 'nodeInstanceDetail', params: { instanceId: 'A' }, query: { tab: 'files' } })
  assert.deepEqual(routeToDstModList('A', 'subscribed'), { name: 'dstModList', query: { instanceId: 'A', tab: 'subscribed' } })
})
