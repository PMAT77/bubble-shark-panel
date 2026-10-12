import dgram from 'node:dgram'
import type { ServerIniFields } from './server-ini'
import { collectPortSet } from './server-ini'

function isUdpPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4')
    socket.once('error', (err: NodeJS.ErrnoException) => {
      socket.close()
      if (err.code === 'EADDRINUSE') {
        resolve(true)
        return
      }
      resolve(false)
    })
    socket.once('listening', () => {
      socket.close()
      resolve(false)
    })
    try {
      socket.bind(port, '0.0.0.0')
    }
    catch {
      resolve(true)
    }
  })
}

export async function findHostUdpPortConflicts(ports: number[]): Promise<number[]> {
  const unique = [...new Set(ports.filter(p => Number.isInteger(p) && p >= 1 && p <= 65535))]
  const conflicts: number[] = []
  for (const port of unique) {
    if (await isUdpPortInUse(port)) {
      conflicts.push(port)
    }
  }
  return conflicts
}

export function formatPortConflictMessage(conflicts: number[]): string {
  if (conflicts.length === 0) {
    return '端口冲突'
  }
  if (conflicts.length === 1) {
    return `端口 ${conflicts[0]} 已被占用，请修改分片配置或释放该端口后重试`
  }
  return `端口 ${conflicts.join('、')} 已被占用，请修改分片配置或释放这些端口后重试`
}

export function formatCrossInstancePortConflictMessage(conflicts: number[]): string {
  if (conflicts.length === 0) {
    return '端口冲突'
  }
  if (conflicts.length === 1) {
    return `端口 ${conflicts[0]} 已被同节点上运行中的其它实例占用。多实例同机时每个实例需不同游戏端口（创建时会自动分配）；可在房间/分片设置中修改端口，或停止占用该端口的实例。`
  }
  return `端口 ${conflicts.join('、')} 已被同节点上运行中的其它实例占用。多实例同机时请为每个实例使用不同端口块，或停止冲突实例后重试。`
}

export async function validateShardPortsForStart(
  master: ServerIniFields | null,
  caves: ServerIniFields | null,
  options?: { reservedPorts?: Set<number> },
): Promise<string | undefined> {
  const ports = [...new Set([
    ...(master ? collectPortSet(master) : []),
    ...(caves ? collectPortSet(caves) : []),
  ])]
  const reservedPorts = options?.reservedPorts
  if (reservedPorts && reservedPorts.size > 0) {
    const overlap = ports.filter(port => reservedPorts.has(port))
    if (overlap.length > 0) {
      return formatCrossInstancePortConflictMessage(overlap)
    }
  }
  const conflicts = await findHostUdpPortConflicts(ports)
  if (conflicts.length > 0) {
    return formatPortConflictMessage(conflicts)
  }
  return undefined
}
