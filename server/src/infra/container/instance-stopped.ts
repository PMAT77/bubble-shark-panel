import { getContainerRuntime } from './index'
import { buildMasterContainerName, buildCavesContainerName, shardNameCandidates } from './naming'

/** DB 停止状态之外，再确认运行时没有仍在运行的分片。 */
export async function assertInstanceRuntimeStopped(instanceId: string): Promise<void> {
  const runtime = getContainerRuntime()
  for (const name of [buildMasterContainerName(instanceId), buildCavesContainerName(instanceId)].flatMap(shardNameCandidates)) {
    const ref = await runtime.findByName(name)
    if (ref && (await runtime.inspect(ref)).running) throw new Error('实例分片仍在运行，请先停止实例')
  }
}
