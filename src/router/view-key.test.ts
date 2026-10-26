import assert from 'node:assert/strict'
import { it } from 'node:test'
import { resolveRouterViewKey } from './view-key'

it('工作台页签保留页面，实例详情按实例隔离，其余页面保留原有缓存规则', () => {
  const detail = (id: string, tab: string) => ({ name: 'nodeInstanceDetail', params: { instanceId: id }, fullPath: `/node/instance/${id}?tab=${tab}` })
  assert.equal(resolveRouterViewKey(detail('A', 'files')), resolveRouterViewKey(detail('A', 'commands')))
  assert.notEqual(resolveRouterViewKey(detail('A', 'files')), resolveRouterViewKey(detail('B', 'files')))
  assert.equal(resolveRouterViewKey({ name: 'dstModList', params: {}, fullPath: '/games/dst/mod?instanceId=A&tab=market' }),
    resolveRouterViewKey({ name: 'dstModList', params: {}, fullPath: '/games/dst/mod?instanceId=B&tab=subscribed' }))
  assert.equal(resolveRouterViewKey({ name: 'nodeInstanceConsole', params: { instanceId: 'A' }, fullPath: '/console/A' }), 'nodeInstanceConsole')
  assert.equal(resolveRouterViewKey({ name: 'other', params: {}, fullPath: '/other?q=1' }), '/other?q=1')
})
