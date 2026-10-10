import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModConfigDefinition } from '../../../../../shared/contracts/mod'
import { buildDefinitionOptionsPayload, buildManualOptionsPayload, createConfigEditValues, resolveConfigControlKind, validateConfigKvRows } from './modConfigState'

const defs: ModConfigDefinition[] = [
  { name: 'header', isHeader: true, label: 'Title', hover: null, options: [], default: null },
  { name: 'enabled', label: null, hover: null, options: [{ description: 'Yes', data: true }, { description: 'No', data: false }], default: true },
  { name: 'amount', label: null, hover: null, options: [], default: 5 },
  { name: 'text', label: null, hover: null, options: [], default: '01' },
]

describe('Mod configuration edits', () => {
  it('shows defaults without pinning untouched defaults or submitting headers', () => {
    const values = createConfigEditValues(defs, {})
    assert.deepEqual(values, { enabled: 'true', amount: '5', text: '01' })
    assert.deepEqual(buildDefinitionOptionsPayload(defs, values, {}), {})
    assert.equal(resolveConfigControlKind(defs[3], {}), 'text')
  })

  it('keeps unknown keys and original scalar types, and removes cleared overrides', () => {
    const original = { enabled: false, amount: 7, text: 'true', hidden: '001' }
    const values = createConfigEditValues(defs, original)
    assert.deepEqual(buildDefinitionOptionsPayload(defs, values, original), original)
    assert.deepEqual(buildDefinitionOptionsPayload(defs, { ...values, enabled: 'true', amount: null, text: 'new' }, original), { enabled: true, text: 'new', hidden: '001' })
    assert.deepEqual(buildDefinitionOptionsPayload(defs, { ...values, amount: '0' }, original), { ...original, amount: 0 })
  })

  it('preserves empty string values until explicitly reset and excludes stored headers', () => {
    const original = { header: 0, text: '', hidden: false }
    const values = createConfigEditValues(defs, original)
    assert.deepEqual(buildDefinitionOptionsPayload(defs, values, original), { text: '', hidden: false })
    assert.deepEqual(buildDefinitionOptionsPayload(defs, { ...values, text: null }, original), { hidden: false })
  })

  it('preserves unchanged manual numeric and boolean-looking strings while inferring new values', () => {
    assert.deepEqual(buildManualOptionsPayload([
      { key: ' text ', value: 'true' }, { key: 'numberText', value: '001' },
      { key: 'flag', value: 'false' }, { key: 'count', value: '2.5' },
    ], { text: 'true', numberText: '001' }), { text: 'true', numberText: '001', flag: false, count: 2.5 })
    assert.deepEqual(buildManualOptionsPayload([], { deleted: true }), {})
  })

  it('rejects empty and duplicate keys before constructing a payload', () => {
    assert.match(validateConfigKvRows([{ key: '', value: '' }]) ?? '', /未填写键名/)
    assert.match(validateConfigKvRows([{ key: 'a', value: '1' }, { key: ' a ', value: '2' }]) ?? '', /重复/)
    assert.equal(validateConfigKvRows([{ key: 'a', value: '1' }]), null)
  })

  it('treats prototype-like configuration keys as ordinary data', () => {
    const rows = [{ key: '__proto__', value: 'safe' }]
    const result = buildManualOptionsPayload(rows, {})
    assert.equal(Object.getPrototypeOf(result), Object.prototype)
    assert.equal(Object.hasOwn(result, '__proto__'), true)
    assert.equal(result.__proto__, 'safe')
  })
})
