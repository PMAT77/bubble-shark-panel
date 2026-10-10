import type { FastifyInstance } from 'fastify'
import type { DbGameInstance } from '../../shared/db'
import type { InstanceResourcesPayload } from '../../../../shared/contracts/instance-resources'
import { instanceResourcesBodySchema, instanceResourcesQuerySchema } from '../../../../shared/contracts/instance-resources'
import { getGameInstanceById, listInstanceMods, updateGameInstanceRuntime } from '../../shared/db'
import { buildCavesContainerName, buildMasterContainerName, getContainerRuntime } from '../../infra/container'
import { resolveInstanceResourceSettings, resolveRecommendedShardMemoryMb } from '../../infra/container/dst-container-resources'
import { sampleHostResources, sampleRuntimeResources, DST_MEMORY_SLICE } from '../../infra/container/memory-budget'
import { buildHostSwapAdvice, readHostMemoryReading, resolveMinHostAvailableMbForOperation, type HostMemoryReading } from '../../infra/container/host-resource-guard'
import { readClusterShardEnabledFromInstall } from '../../infra/game-adapter/dst/shard-service'
import { businessError, success } from '../../shared/http/response'
import { authorizeInstance } from '../system/auth'

export { resolveInstanceResourceSettings, resolveRecommendedShardMemoryMb }

export async function getInstanceResourceSettings(instance: DbGameInstance, injectedReading?: HostMemoryReading): Promise<InstanceResourcesPayload> {
  const runtime = getContainerRuntime()
  const sampledHost = await sampleHostResources(runtime)
  const protection = sampledHost ? structuredClone(sampledHost) : null
  const hostReading = injectedReading ?? protection ?? (runtime.hostResources ? { availableMb: null, totalMb: null, swapFreeMb: null, swapTotalMb: null } : readHostMemoryReading())
  const readShard = async (name: string) => {
    try {
      const ref = await runtime.findByName(name)
      return ref ? await sampleRuntimeResources(runtime, ref) : null
    }
    catch { return null }
  }
  const [master, caves, mods] = await Promise.all([
    readShard(buildMasterContainerName(instance.id)), readShard(buildCavesContainerName(instance.id)), listInstanceMods(instance.id),
  ])
  const modCount = mods.filter(mod => mod.enabled && mod.installStatus === 'ready').length
  const peak = (current: number | null | undefined, last: number | null | undefined) => current == null && last == null ? null : Math.max(current ?? 0, last ?? 0)
  const masterPeakMb = peak(master?.memoryPeakMb, instance.lastStartupReport?.master.memoryPeakMb)
  const cavesPeakMb = peak(caves?.memoryPeakMb, instance.lastStartupReport?.caves.memoryPeakMb)
  const masterDemandMb = peak(master?.memoryAndSwapPeakMb, instance.lastStartupReport?.master.memoryAndSwapPeakMb)
  const cavesDemandMb = peak(caves?.memoryAndSwapPeakMb, instance.lastStartupReport?.caves.memoryAndSwapPeakMb)
  if (protection?.budget.state === 'protected' && ((master && master.memoryParent !== DST_MEMORY_SLICE) || (caves && caves.memoryParent !== DST_MEMORY_SLICE))) {
    protection.budget = { ...protection.budget, state: 'legacy', message: '当前分片未全部归属共享预算；已运行分片保留，下次停止并启动后生效' }
  }
  const host = { availableMb: hostReading.availableMb, totalMb: hostReading.totalMb ?? null, swapFreeMb: hostReading.swapFreeMb, swapTotalMb: hostReading.swapTotalMb ?? null }
  const shardCount = instance.installPath && readClusterShardEnabledFromInstall(instance.installPath) ? 2 : 1
  const requiredMb = resolveMinHostAvailableMbForOperation('dst-container-start', { shardCount, modCount })
  const measuredAt = master?.measuredAt ?? caves?.measuredAt ?? instance.lastStartupReport?.updatedAt ?? ''
  return {
    config: instance.resourceConfig ?? { masterMemoryMb: null, cavesMemoryMb: null, shardReadyWaitSec: null },
    effective: resolveInstanceResourceSettings(instance.resourceConfig),
    current: { master, caves },
    recommendation: {
      masterMemoryMb: resolveRecommendedShardMemoryMb(modCount, peak(masterPeakMb, masterDemandMb)),
      cavesMemoryMb: resolveRecommendedShardMemoryMb(modCount, peak(cavesPeakMb, cavesDemandMb)),
      modCount, estimatedMb: 512 + 32 * modCount, measuredAt, masterPeakMb, cavesPeakMb,
      masterDemandMb, cavesDemandMb,
      masterPeakLimited: master?.peakLimited === true || instance.lastStartupReport?.master.peakLimited === true,
      cavesPeakLimited: caves?.peakLimited === true || instance.lastStartupReport?.caves.peakLimited === true,
    },
    host,
    ...(protection ? { protection: structuredClone(protection) } : {}),
    swapAdvice: buildHostSwapAdvice(hostReading, requiredMb),
  }
}

export function registerInstanceResourceRoutes(app: FastifyInstance): void {
  app.get('/app/instance/resources', async (request) => {
    const parsed = instanceResourcesQuerySchema.safeParse(request.query)
    if (!parsed.success) return businessError('请求参数无效', request)
    const auth = await authorizeInstance(request, parsed.data.id, 'instance:read')
    if (auth.error) return auth.error
    const instance = await getGameInstanceById(parsed.data.id)
    if (!instance) return businessError('实例不存在', request)
    return success(await getInstanceResourceSettings(instance), request)
  })
  app.post('/app/instance/resources', async (request) => {
    const parsed = instanceResourcesBodySchema.safeParse(request.body)
    if (!parsed.success) return businessError('资源设置无效：内存上限应为 0、至少 6 MiB 或继承，启动时限应为正整数或继承', request)
    const auth = await authorizeInstance(request, parsed.data.id, 'instance:lifecycle')
    if (auth.error) return auth.error
    const instance = await getGameInstanceById(parsed.data.id)
    if (!instance) return businessError('实例不存在', request)
    const saved = await updateGameInstanceRuntime(instance.id, { resourceConfig: parsed.data.config })
    return success(await getInstanceResourceSettings(saved ?? instance), request)
  })
}
