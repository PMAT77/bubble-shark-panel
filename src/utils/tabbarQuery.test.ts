import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { TabbarRecordRaw } from '@fantastic-admin/types'
import { findTabbarRecord, replaceTabbarQuery } from './tabbarQuery'

it('工作台查询变化复用应用标签，不同实例及其他页面的标签仍分别保留', () => {
  const detail = { tabId: '/detail/A?tab=overview', fullPath: '/detail/A?tab=overview' } as TabbarRecordRaw
  const mod = { tabId: '/mods?instanceId=A', fullPath: '/mods?instanceId=A' } as TabbarRecordRaw
  const list = [detail, mod]
  assert.equal(findTabbarRecord(list, { name: 'nodeInstanceDetail', path: '/detail/A', fullPath: '/detail/A?tab=files' }), detail)
  assert.equal(findTabbarRecord(list, { name: 'nodeInstanceDetail', path: '/detail/B', fullPath: '/detail/B?tab=files' }), undefined)
  assert.equal(findTabbarRecord(list, { name: 'dstModList', path: '/mods', fullPath: '/mods?instanceId=B' }), mod)
  assert.equal(findTabbarRecord(list, { name: 'other', path: '/mods', fullPath: '/mods?instanceId=B' }), undefined)
})

it('页内切换原位更新标签，合并已添加的新 URL 且保留缓存组件和相邻标签', () => {
  const tab = (fullPath: string) => ({ tabId: fullPath, fullPath, name: ['NodeInstanceDetail'] }) as TabbarRecordRaw
  const old = tab('/detail/A?tab=overview')
  const other = tab('/mods')
  const nextPath = '/detail/A?tab=files'
  const result = replaceTabbarQuery([old, other, tab(nextPath)], old.tabId, nextPath)
  assert.deepEqual(result, [old, other])
  assert.equal(result[0].tabId, nextPath)
  assert.equal(result[0].fullPath, nextPath)
  assert.deepEqual(result[0].name, ['NodeInstanceDetail'])
  assert.equal(replaceTabbarQuery(result, nextPath, '/detail/A?tab=commands').length, 2)
  assert.equal(replaceTabbarQuery(result, '/missing', '/other'), result)
})
