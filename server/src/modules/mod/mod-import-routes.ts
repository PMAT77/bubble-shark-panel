import type { FastifyInstance } from 'fastify'
import type { Readable } from 'node:stream'
import { modImportCommitSchema, modInstanceParamsSchema, type ModItemDto } from '../../../../shared/contracts/mod'
import { authorizeInstance } from '../system/auth'
import { resolveLocalDstInstance } from '../../shared/dst/local-dst-instance'
import { businessError, success } from '../../shared/http/response'
import { commitLocalMods, discardLocalMod, inspectLocalMod, modImportLimits } from './mod-import-service'

export function registerModImportRoutes(app: FastifyInstance, buildDto: (instanceId: string, workshopId: string) => Promise<ModItemDto | null>): void {
  app.addContentTypeParser('application/x-gsh-mod-archive', (_request, payload, done) => done(null, payload))
  app.get('/app/instances/:instanceId/mods/import/limits', async (request) => {
    const params = modInstanceParamsSchema.parse(request.params)
    const auth = await authorizeInstance(request, params.instanceId, 'mod:install')
    if (auth.error) return auth.error
    return success(modImportLimits(), request)
  })
  app.post('/app/instances/:instanceId/mods/import/inspect', { bodyLimit: modImportLimits().maxArchiveBytes }, async (request, reply) => {
    const parsed = modInstanceParamsSchema.safeParse(request.params)
    if (!parsed.success) return businessError('实例参数无效', request)
    const auth = await authorizeInstance(request, parsed.data.instanceId, 'mod:install')
    if (auth.error || !auth.context) return reply.status(403).send(auth.error)
    const resolved = await resolveLocalDstInstance(parsed.data.instanceId, request, { ensureClusterDirectory: false })
    if (!resolved.ok) return resolved.error
    try {
      const query = request.query as { fileName?: string }
      const sourceName = (query.fileName ?? '').replace(/^.*[\\/]/, '').slice(0, 200)
      return success(await inspectLocalMod(request.body as Readable, parsed.data.instanceId, auth.context.user.id, sourceName), request)
    }
    catch (error) { return reply.status(400).send(businessError(error instanceof Error ? error.message : 'Mod 包分析失败', request)) }
  })
  app.post('/app/instances/:instanceId/mods/import/commit', async (request) => {
    const params = modInstanceParamsSchema.safeParse(request.params)
    const body = modImportCommitSchema.safeParse(request.body)
    if (!params.success || !body.success) return businessError('导入参数无效', request)
    const auth = await authorizeInstance(request, params.data.instanceId, 'mod:install')
    if (auth.error || !auth.context) return auth.error
    const resolved = await resolveLocalDstInstance(params.data.instanceId, request, { ensureClusterDirectory: false })
    if (!resolved.ok) return resolved.error
    try {
      const result = await commitLocalMods(body.data, params.data.instanceId, auth.context.user.id, resolved.instance.installPath)
      if (!('items' in body.data) && !result.installedMods.length) throw new Error(result.results[0]?.error ?? 'Mod 导入失败')
      const mods: ModItemDto[] = []
      for (const mod of result.installedMods) {
        const dto = await buildDto(params.data.instanceId, mod.workshopId)
        if (dto) mods.push(dto)
      }
      const riskTip = result.riskTip
      if (!('items' in body.data)) return success({ saved: true, riskTip, mod: mods[0] ?? null }, request)
      return success({ saved: result.summary.installed > 0, riskTip, results: result.results, mods,
        summary: result.summary, retryBlocked: result.retryBlocked, error: result.error }, request)
    }
    catch (error) { return businessError(error instanceof Error ? error.message : 'Mod 导入失败', request) }
  })
  app.delete('/app/instances/:instanceId/mods/import/:importId', async (request) => {
    const params = request.params as { instanceId: string, importId: string }
    const auth = await authorizeInstance(request, params.instanceId, 'mod:install')
    if (auth.error || !auth.context) return auth.error
    try { discardLocalMod(params.importId, auth.context.user.id, params.instanceId); return success({ saved: true }, request) }
    catch (error) { return businessError(error instanceof Error ? error.message : '清理失败', request) }
  })
}
