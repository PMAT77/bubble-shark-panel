import fs from 'node:fs'
import { buildMasterContainerName } from '../../container/naming'
import { backupFile, writeFileAtomic } from './atomic-write'
import { buildClusterIni, parseClusterIni } from './cluster-ini'
import { resolveClusterPaths } from './cluster-service'

/** Docker 双容器分片：主世界 bind 全接口，洞穴通过主世界容器名互联。 */
export const DOCKER_SHARD_BIND_IP = '0.0.0.0'
export const NATIVE_SHARD_LOOPBACK_IP = '127.0.0.1'

export function resolveDockerShardMasterIp(instanceId: string): string {
  return buildMasterContainerName(instanceId)
}

export function ensureDockerShardInterconnectConfig(installPath: string, instanceId: string): boolean {
  const { clusterIniPath } = resolveClusterPaths(installPath)
  if (!fs.existsSync(clusterIniPath)) {
    return false
  }
  const content = fs.readFileSync(clusterIniPath, 'utf8')
  const { fields } = parseClusterIni(content)
  if (!fields.shardEnabled) {
    return false
  }
  const canonicalName = resolveDockerShardMasterIp(instanceId)
  const legacyName = canonicalName.replace(/^bsp-/, 'gsh-')
  const masterIp = fields.masterIp === legacyName ? legacyName : canonicalName
  if (fields.bindIp === DOCKER_SHARD_BIND_IP && fields.masterIp === masterIp) {
    return false
  }
  fields.bindIp = DOCKER_SHARD_BIND_IP
  fields.masterIp = masterIp
  backupFile(clusterIniPath)
  writeFileAtomic(clusterIniPath, buildClusterIni(fields))
  return true
}

/** Native 双进程分片：地上与洞穴在同一宿主机上通过 loopback 互联。 */
export function ensureNativeShardInterconnectConfig(installPath: string): boolean {
  const { clusterIniPath } = resolveClusterPaths(installPath)
  if (!fs.existsSync(clusterIniPath)) {
    return false
  }
  const content = fs.readFileSync(clusterIniPath, 'utf8')
  const { fields } = parseClusterIni(content)
  if (!fields.shardEnabled) {
    return false
  }
  if (fields.bindIp === NATIVE_SHARD_LOOPBACK_IP && fields.masterIp === NATIVE_SHARD_LOOPBACK_IP) {
    return false
  }
  fields.bindIp = NATIVE_SHARD_LOOPBACK_IP
  fields.masterIp = NATIVE_SHARD_LOOPBACK_IP
  backupFile(clusterIniPath)
  writeFileAtomic(clusterIniPath, buildClusterIni(fields))
  return true
}
