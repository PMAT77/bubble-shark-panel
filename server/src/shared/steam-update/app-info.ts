interface KeyValues {
  [key: string]: string | KeyValues
}

/** 只读取指定应用的正式分支；depot manifests 和测试分支不能作为兜底。 */
export function parsePublicBuildIdFromAppInfo(output: string, appId: string): string | null {
  if (!/^\d+$/.test(appId)) {
    return null
  }
  const root = new RegExp(`"${appId}"\\s*\\{`).exec(output)
  if (!root) {
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
  let current: string | KeyValues | null = object(0)
  for (const key of ['depots', 'branches', 'public', 'buildid']) {
    if (!current || typeof current === 'string') {
      return null
    }
    current = current[key] ?? null
  }
  return typeof current === 'string' && /^\d+$/.test(current) ? current : null
}
