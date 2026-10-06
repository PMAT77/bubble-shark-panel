export interface KeyValues {
  [key: string]: string | KeyValues
}

export function parseKeyValuesRoot(output: string, rootKey: string, exact = false): KeyValues | null {
  if (!/^(?:\d+|AppState)$/.test(rootKey)) {
    return null
  }
  const root = new RegExp(`"${rootKey}"\\s*\\{`).exec(output)
  if (!root || (exact && output.slice(0, root.index).trim())) {
    return null
  }
  const input = output.slice(root.index + root[0].length)
  const token = /\s*(?:"((?:\\.|[^"\\])*)"|([{}]))/y
  let offset = 0
  const next = (): { text: string, quoted: boolean } | null => {
    token.lastIndex = offset
    const match = token.exec(input)
    if (!match) {
      return null
    }
    offset = token.lastIndex
    return { text: match[1] ?? match[2], quoted: match[1] !== undefined }
  }
  const object = (depth: number): KeyValues | null => {
    if (depth > 64) {
      return null
    }
    const result: KeyValues = Object.create(null)
    while (true) {
      const key = next()
      if (!key) {
        return null
      }
      if (!key.quoted) {
        return key.text === '}' ? result : null
      }
      if (Object.hasOwn(result, key.text)) {
        return null
      }
      const value = next()
      if (!value) {
        return null
      }
      if (value.quoted) {
        result[key.text] = value.text
      }
      else if (value.text === '{') {
        const child = object(depth + 1)
        if (!child) {
          return null
        }
        result[key.text] = child
      }
      else {
        return null
      }
    }
  }
  const result = object(0)
  return exact && input.slice(offset).trim() ? null : result
}

export function readKeyValues(root: KeyValues | null, ...keys: string[]): string | KeyValues | null {
  let current: string | KeyValues | null = root
  for (const key of keys) {
    if (!current || typeof current === 'string') {
      return null
    }
    current = current[key] ?? null
  }
  return current
}

export interface PublicAppInfo {
  checkedAt?: string
  buildId: string
  depotManifests: Record<string, string>
  linuxDepots: string[]
}

/** 只读取指定应用的正式分支；depot manifests 和测试分支不能作为兜底。 */
export function parsePublicAppInfo(output: string, appId: string): PublicAppInfo | null {
  if (!/^\d+$/.test(appId)) return null
  const root = parseKeyValuesRoot(output, appId)
  const buildId = readKeyValues(root, 'depots', 'branches', 'public', 'buildid')
  const depots = readKeyValues(root, 'depots')
  if (typeof buildId !== 'string' || !/^\d+$/.test(buildId) || !depots || typeof depots === 'string') {
    return null
  }
  const depotManifests: Record<string, string> = Object.create(null)
  const linuxDepots: string[] = []
  for (const [id, depot] of Object.entries(depots)) {
    if (!/^\d+$/.test(id) || typeof depot === 'string') continue
    const gid = readKeyValues(depot, 'manifests', 'public', 'gid')
    const osList = readKeyValues(depot, 'config', 'oslist')
    if (typeof gid === 'string' && /^[1-9]\d*$/.test(gid)) {
      depotManifests[id] = gid
    }
    if (readKeyValues(depot, 'sharedinstall') !== '1'
      && (osList === null || (typeof osList === 'string' && osList.split(',').some(os => os.trim() === 'linux')))) {
      linuxDepots.push(id)
    }
  }
  return { buildId, depotManifests, linuxDepots }
}

export function parsePublicBuildIdFromAppInfo(output: string, appId: string): string | null {
  return parsePublicAppInfo(output, appId)?.buildId ?? null
}
