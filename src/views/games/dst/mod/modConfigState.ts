import type { ModConfigDefinition, ModConfigValues } from '../../../../../shared/contracts/mod'

export interface ModConfigKvRow { key: string, value: string }

export function createConfigEditValues(definitions: ModConfigDefinition[], original: ModConfigValues): Record<string, string | null> {
  const values = new Map<string, string | null>(Object.entries(original).map(([key, value]) => [key, String(value)]))
  for (const def of definitions) {
    if (!def.isHeader && !values.has(def.name)) values.set(def.name, def.default === null ? null : String(def.default))
  }
  return Object.fromEntries(values)
}

export function resolveConfigControlKind(def: ModConfigDefinition, original: ModConfigValues): 'select' | 'switch' | 'number' | 'text' {
  if (def.options.length) return 'select'
  const raw = Object.hasOwn(original, def.name) ? original[def.name] : def.default
  if (typeof raw === 'boolean') return 'switch'
  if (typeof raw === 'number') return 'number'
  return 'text'
}

export function buildDefinitionOptionsPayload(definitions: ModConfigDefinition[], edited: Record<string, string | null>, original: ModConfigValues): ModConfigValues {
  const result = new Map(Object.entries(original))
  for (const def of definitions) {
    if (def.isHeader) { result.delete(def.name); continue }
    const value = edited[def.name]
    if (value == null) { result.delete(def.name); continue }
    const stored = Object.hasOwn(original, def.name) ? original[def.name] : undefined
    if (stored !== undefined && String(stored) === value) continue
    if (stored === undefined && def.default !== null && String(def.default) === value) continue
    const kind = resolveConfigControlKind(def, original)
    const candidate = def.options.find(option => String(option.data) === value)
    result.set(def.name, kind === 'select' ? (candidate?.data ?? value)
      : kind === 'switch' ? value === 'true'
        : kind === 'number' ? Number(value) : value)
  }
  return Object.fromEntries(result)
}

export function validateConfigKvRows(rows: ModConfigKvRow[]): string | null {
  const keys = new Set<string>()
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) return '存在未填写键名的配置行，请填写键名或删除该行'
    if (keys.has(key)) return `配置键「${key}」重复，请修改键名或删除重复行`
    keys.add(key)
  }
  return null
}

export function buildManualOptionsPayload(rows: ModConfigKvRow[], original: ModConfigValues): ModConfigValues {
  return Object.fromEntries(rows.map(({ key: rawKey, value }) => {
    const key = rawKey.trim()
    const stored = Object.hasOwn(original, key) ? original[key] : undefined
    const typed = stored !== undefined && String(stored) === value ? stored
      : value === 'true' ? true : value === 'false' ? false
        : value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : value
    return [key, typed]
  }))
}
