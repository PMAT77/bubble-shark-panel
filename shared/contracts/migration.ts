import { z } from 'zod'

const workshopId = z.string().regex(/^[1-9]\d{0,19}$/)
const contentSchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  hashAlgorithm: z.literal('sha256-tree-v1'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export const migrationModSchema = z.object({
  workshopId,
  name: z.string().min(1).max(1024),
  enabled: z.boolean(),
  loadOrder: z.number().int().nonnegative(),
  configurationOptions: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
  dependencyIds: z.array(workshopId).max(10_000),
  version: z.string().max(1024).nullable(),
  localUpdatedAt: z.string().datetime().nullable(),
  content: contentSchema.nullable(),
})
export type MigrationMod = z.infer<typeof migrationModSchema>
export const migrationManifestSchema = z.object({
  formatVersion: z.literal(1),
  game: z.literal('dont-starve-together'),
  clusterDirectory: z.string().min(1).max(256).refine(value => !/[\\/]/.test(value) && value !== '.' && value !== '..'),
  includeMods: z.boolean(),
  mods: z.array(migrationModSchema).max(10_000),
}).superRefine((manifest, context) => {
  const byId = new Map(manifest.mods.map(mod => [mod.workshopId, mod]))
  if (byId.size !== manifest.mods.length) context.addIssue({ code: 'custom', message: 'Mod ID 重复' })
  if (!manifest.includeMods && manifest.mods.some(mod => mod.content)) context.addIssue({ code: 'custom', message: '配置迁移包不能声明 Mod 文件' })
  if (manifest.includeMods) {
    const visited = new Set<string>()
    const visit = (id: string) => {
      if (visited.has(id)) return
      visited.add(id)
      const mod = byId.get(id)
      if (!mod?.content) context.addIssue({ code: 'custom', message: `必需 Mod ${id} 缺少内容` })
      for (const dependency of mod?.dependencyIds ?? []) visit(dependency)
    }
    for (const mod of manifest.mods.filter(item => item.enabled)) visit(mod.workshopId)
  }
})
export type MigrationManifest = z.infer<typeof migrationManifestSchema>
export interface MigrationContentSummary {
  includedModCount: number
  estimatedContentBytes: number
  missingRequiredMods: string[]
  missingOptionalMods: string[]
  canExport: boolean
}
