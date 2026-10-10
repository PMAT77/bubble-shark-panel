import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { ModItemDto } from '@/api/modules/mod'
import { moveModLoadOrder } from './modLoadOrder'

const mods = [
  { workshopId: '1', installStatus: 'ready' },
  { workshopId: '2', installStatus: 'failed' },
  { workshopId: '3', installStatus: 'ready' },
  { workshopId: '4', installStatus: 'ready' },
  { workshopId: '5', installStatus: 'pending' },
] as ModItemDto[]

it('moves ready items in both directions and includes locked ready rows in the complete payload', () => {
  assert.deepEqual(moveModLoadOrder(mods, '1', '4', id => id === '3'), ['3', '4', '1'])
  assert.deepEqual(moveModLoadOrder(mods, '4', '1', () => false), ['4', '1', '3'])
  assert.deepEqual(mods.map(mod => mod.workshopId), ['1', '2', '3', '4', '5'])
})
it('ignores unchanged, unknown, failed, pending and actively downloading source/target rows', () => {
  for (const [from, to] of [['1', '1'], ['missing', '1'], ['1', 'missing'], ['2', '1'], ['1', '2'], ['5', '1'], ['1', '5'], ['3', '1'], ['1', '3']]) {
    assert.equal(moveModLoadOrder(mods, from, to, id => id === '3'), null)
  }
})
