import assert from 'node:assert/strict'
import { it } from 'node:test'
import { validateModImportIds } from './modImportPresentation.ts'

it('accepts recognized IDs and flags missing, duplicate and reserved IDs before installation', () => {
  assert.equal(validateModImportIds([{ itemId: 'a', workshopId: ' 123 ' }, { itemId: 'b', workshopId: '456' }], []).size, 0)
  const errors = validateModImportIds([
    { itemId: 'a', workshopId: '123' }, { itemId: 'b', workshopId: ' 123 ' },
    { itemId: 'c', workshopId: '' }, { itemId: 'd', workshopId: '0' }, { itemId: 'e', workshopId: '999' },
  ], ['999'])
  assert.equal(errors.size, 5)
  assert.match(errors.get('a')!, /重复/)
  assert.match(errors.get('b')!, /重复/)
  assert.match(errors.get('c')!, /有效/)
  assert.match(errors.get('e')!, /保留/)
})
