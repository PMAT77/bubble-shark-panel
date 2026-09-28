import type { FastifyInstance } from 'fastify'
import type { ApiErrorResponse, ApiSuccessResponse } from '../../../../shared/contracts/api'
import type { NodeListItem } from '../../../../shared/contracts/node'
import os from 'node:os'
import { collectHostResourceSnapshot } from '../../shared/host-metrics'
import { listServerNodes, saveServerNode } from '../../shared/db/index'
import { success } from '../../shared/http/response'
import { requirePermission } from '../system/auth'

const LOCAL_NODE_ID = 'local-node'

async function upsertLocalNode() {
  const now = new Date().toISOString()
  const snapshot = collectHostResourceSnapshot()
  const saved = await saveServerNode({
    id: LOCAL_NODE_ID,
    name: '本地节点',
    host: os.hostname(),
    status: 'online',
    cpuUsage: snapshot.cpu.usageRate,
    memoryUsage: snapshot.memory.usageRate,
    diskUsage: snapshot.disk.usageRate,
    lastHeartbeatAt: now,
  })
  return {
    id: saved.id,
    name: saved.name,
    host: saved.host,
    sshPort: saved.sshPort,
    status: saved.status,
    resources: snapshot,
    lastHeartbeatAt: saved.lastHeartbeatAt,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  } satisfies NodeListItem
}

function toNodeViewItem(item: Awaited<ReturnType<typeof listServerNodes>>[number]): NodeListItem {
  return {
    id: item.id,
    name: item.name,
    host: item.host,
    sshPort: item.sshPort,
    status: item.status,
    resources: {
      cpu: {
        cores: Math.max(1, os.cpus().length),
        usageRate: Number(item.cpuUsage.toFixed(2)),
        availableRate: Number((100 - item.cpuUsage).toFixed(2)),
      },
      memory: {
        totalGb: 0,
        usedGb: 0,
        freeGb: 0,
        usageRate: Number(item.memoryUsage.toFixed(2)),
      },
      disk: {
        totalGb: 0,
        usedGb: 0,
        freeGb: 0,
        usageRate: Number(item.diskUsage.toFixed(2)),
      },
    },
    lastHeartbeatAt: item.lastHeartbeatAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

/**
 * node 模块注册入口
 * 负责本地节点注册、资源探测与节点列表读取。
 */
export function registerNodeModule(app: FastifyInstance) {
  app.addHook('onReady', async () => {
    await upsertLocalNode()
  })

  app.post('/app/node/local/register', async (request): Promise<ApiSuccessResponse<NodeListItem> | ApiErrorResponse> => {
    /**
     * 幂等地确保本地节点记录存在。它写库，但没有任何用户可见的语义
     * （单节点架构下节点不是独立权限维度），所以归入监控读权限。
     */
    const authError = await requirePermission(request, 'console.monitor:read')
    if (authError) {
      return authError
    }
    return success(await upsertLocalNode(), request)
  })

  app.post('/app/node/list', async (request): Promise<ApiSuccessResponse<NodeListItem[]> | ApiErrorResponse> => {
    const authError = await requirePermission(request, 'console.monitor:read')
    if (authError) {
      return authError
    }
    const nodes = await listServerNodes()
    const localNode = await upsertLocalNode()
    const list = nodes
      .filter(node => node.id !== LOCAL_NODE_ID)
      .map(toNodeViewItem)
    return success([localNode, ...list], request)
  })
}
