/** Brand configuration aliases. Process settings outrank file settings; BSP wins within each source. */
export function readBrandEnv(key: string, env: Record<string, string | undefined> = process.env, file: Record<string, string | undefined> = {}): string | undefined {
  const canonical = key.replace(/^GSH_/, 'BSP_')
  const legacy = canonical.replace(/^BSP_/, 'GSH_')
  return env[canonical] ?? env[legacy] ?? file[canonical] ?? file[legacy]
}

export function resolveBrandEnvSource(env: Record<string, string | undefined>, file: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const result = { ...file, ...env }
  for (const key of new Set([...Object.keys(env), ...Object.keys(file)])) {
    if (/^(BSP|GSH)_/.test(key)) result[key.replace(/^GSH_/, 'BSP_')] = readBrandEnv(key, env, file)
  }
  return result
}
