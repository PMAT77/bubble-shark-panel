import { defineFakeRoute } from 'vite-plugin-fake-server/client'
import type { InstanceInstallLogPayload, InstanceInstallTask } from '../../../shared/contracts/instance'

type InstanceStatus = 'pending_install' | 'running' | 'stopped' | 'installing' | 'error'

interface FakeInstanceItem {
  id: string
  nodeId: string
  name: string
  gameCode: string
  status: InstanceStatus
  containerId: string | null
  installPath: string | null
  configPath: string | null
  queryPort: number | null
  gamePort: number | null
  rconPort: number | null
  lastCommand: string | null
  lastError: string | null
  lastErrorPhase: 'install' | 'runtime' | null
  installLogStatus: 'running' | 'success' | 'failed' | 'cancelled' | null
  installTaskId?: string
  installTask?: InstanceInstallTask
  installPercent: number | null
  installLogUpdatedAt: string | null
  updateAvailable: boolean
  localBuildId: string | null
  remoteBuildId: string | null
  updateCheckedAt: string | null
  createdAt: string
  updatedAt: string
}

const defaultInstallMeta = {
  installLogStatus: null,
  installPercent: null,
  installLogUpdatedAt: null,
} as const

const defaultUpdateMeta = {
  updateAvailable: false,
  localBuildId: null,
  remoteBuildId: null,
  updateCheckedAt: null,
} as const

interface InstallableGameItem {
  appId: string
  name: string
}

const nowIso = () => new Date().toISOString()
const generateId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
const installableGames: InstallableGameItem[] = [
  {
    appId: '343050',
    name: '饥荒联机（Dedicated Server）',
  },
]

let instanceList: FakeInstanceItem[] = []

function beginFakeInstall(id: string, kind: 'install' | 'update') {
  const taskId = generateId()
  const startedAt = nowIso()
  instanceList = instanceList.map(item => item.id !== id ? item : {
    ...item, status: 'installing', installTaskId: taskId, installLogStatus: 'running', installPercent: 1,
    lastError: null, lastErrorPhase: null, installLogUpdatedAt: startedAt, updatedAt: startedAt,
    installTask: { taskId, kind, runtimeMode: 'docker', startedAt, phaseStartedAt: startedAt, overallPercent: 1,
      phaseCode: 'prepare', phase: '准备安装环境', status: 'running', failure: null, updatedAt: startedAt,
      attempt: 1, maxAttempts: 3, retryAt: null },
  })
  const steps = [
    [3000, 23, 'download', '下载游戏文件'], [6000, 56, 'download', '下载游戏文件'],
    [9000, 82, 'verify', '校验游戏文件'], [12000, 94, 'runtime', '准备游戏运行镜像'],
    [15000, 100, 'complete', '安装完成'],
  ] as const
  for (const [delay, percent, phaseCode, phase] of steps) setTimeout(() => {
    instanceList = instanceList.map(item => {
      if (item.id !== id || item.installTaskId !== taskId || item.installLogStatus !== 'running') return item
      const status = percent === 100 ? 'success' : 'running'
      const at = nowIso()
      return { ...item, status: status === 'success' ? 'stopped' : 'installing', installPercent: percent,
        installLogStatus: status, installLogUpdatedAt: at, updatedAt: at,
        installTask: { ...item.installTask!, status, overallPercent: percent, phaseCode, phase, updatedAt: at } }
    })
  }, delay)
  return taskId
}

interface FakeUpdateCheckJobPayload {
  checking: boolean
  startedAt: string | null
  finishedAt: string | null
  result: {
    items: Array<{
      id: string
      name: string
      updateAvailable: boolean
      localBuildId: string
      remoteBuildId: string
      updateCheckedAt: string
    }>
    updateAvailableCount: number
  } | null
  error: string | null
}

let fakeUpdateCheckJob: FakeUpdateCheckJobPayload = {
  checking: false,
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
}

function buildFakeUpdateCheckResult(ids?: string[]) {
  const idSet = ids?.length ? new Set(ids) : null
  const items = instanceList
    .filter(item => item.status === 'stopped' || item.status === 'running')
    .filter(item => !idSet || idSet.has(item.id))
    .map(item => ({
      id: item.id,
      name: item.name,
      updateAvailable: item.id.endsWith('1'),
      localBuildId: '100',
      remoteBuildId: item.id.endsWith('1') ? '101' : '100',
      updateCheckedAt: nowIso(),
    }))
  instanceList = instanceList.map((item) => {
    const hit = items.find(row => row.id === item.id)
    if (!hit) {
      return item
    }
    return {
      ...item,
      updateAvailable: hit.updateAvailable,
      localBuildId: hit.localBuildId,
      remoteBuildId: hit.remoteBuildId,
      updateCheckedAt: hit.updateCheckedAt,
      updatedAt: nowIso(),
    }
  })
  return {
    items,
    updateAvailableCount: items.filter(item => item.updateAvailable).length,
  }
}

const maintenanceDrafts = new Map<string, { message: string, updatedAt: string }>()
const maintenancePushLogs = new Map<string, Array<{
  id: string
  message: string
  operatorAccount: string
  status: 'success' | 'failed'
  errorMessage: string | null
  pushedAt: string
}>>()

function getMaintenanceState(instanceId: string) {
  const draft = maintenanceDrafts.get(instanceId)
  return {
    draft: {
      message: draft?.message ?? '',
      updatedAt: draft?.updatedAt ?? null,
    },
    recentPushes: maintenancePushLogs.get(instanceId) ?? [],
  }
}

function matchStatus(value: unknown): value is InstanceStatus {
  return value === 'running' || value === 'stopped' || value === 'installing' || value === 'error'
}

export default defineFakeRoute([
  {
    url: '/fake/app/instance/games',
    method: 'get',
    response: () => {
      return {
        error: '',
        status: 1,
        data: installableGames,
      }
    },
  },
  {
    url: '/fake/app/instance/install-log/download',
    method: 'get',
    rawResponse: (req, res) => {
      const id = new URL(req.originalUrl ?? '/', 'http://localhost').searchParams.get('id')
      const target = instanceList.find(item => item.id === id)
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="install.log"')
      res.end(`Connecting anonymously to Steam Public...OK\nUpdate state (0x61) downloading, progress: ${target?.installPercent ?? 56.25}\n${target?.installLogStatus === 'success' ? "Success! App '343050' fully installed.\n" : ''}`)
    },
  },
  {
    url: '/fake/app/instance/install-log',
    method: 'get',
    response: ({ query }) => {
      const id = typeof query.id === 'string' ? query.id : ''
      const target = instanceList.find(item => item.id === id)
      const summary = [target?.lastCommand, target?.lastError].filter(Boolean).join('\n').trim()
      const status = target?.installLogStatus ?? (target?.status === 'installing' ? 'running' : 'unknown')
      const at = target?.installLogUpdatedAt ?? target?.updatedAt ?? nowIso()
      const progress: InstanceInstallLogPayload['progress'] = status === 'unknown' ? null : {
        ...target?.installTask,
        status, phaseCode: target?.installTask?.phaseCode ?? (status === 'success' ? 'complete' : 'download'),
        phase: status === 'cancelled' ? '安装已取消' : target?.installTask?.phase ?? '下载游戏文件',
        percent: status === 'running' ? 56.25 : null,
        updatedAt: at, attempt: 1, maxAttempts: 3, retryAt: null,
        failure: status === 'failed' ? { message: target?.lastError ?? '安装未完成', advice: '查看原始日志，处理后点击“更新服务端”重试。' } : null,
        events: [
          { at, level: 'info', message: '安装任务已开始' },
          { at, level: 'info', message: '连接 Steam' },
          { at, level: 'info', message: '下载游戏文件' },
          ...(status === 'success' ? [{ at, level: 'info' as const, message: '安装完成，可以启动实例。' }] : []),
        ],
      }
      const raw = progress ? `Connecting anonymously to Steam Public...OK\nUpdate state (0x61) downloading, progress: ${target?.installPercent ?? 56.25}\n${status === 'success' ? "Success! App '343050' fully installed." : ''}` : summary
      return {
        error: '',
        status: 1,
        data: {
          content: query.view === 'summary' && progress ? '' : raw || '暂无安装输出。',
          status,
          updatedAt: at,
          source: progress ? 'install_log' : summary ? 'status_summary' : 'empty',
          phase: progress?.phase ?? null,
          progress,
          rawAvailable: !!progress,
          rawTruncated: false,
        },
      }
    },
  },
  {
    url: '/fake/app/instance/list',
    method: 'post',
    response: ({ body }) => {
      const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : ''
      const status = typeof body.status === 'string' && matchStatus(body.status)
        ? body.status
        : ''
      const keyword = typeof body.keyword === 'string' ? body.keyword.trim().toLowerCase() : ''
      const data = instanceList.filter((item) => {
        if (nodeId && item.nodeId !== nodeId) {
          return false
        }
        if (status && item.status !== status) {
          return false
        }
        if (!keyword) {
          return true
        }
        return item.name.toLowerCase().includes(keyword) || item.gameCode.toLowerCase().includes(keyword)
      })
      return {
        error: '',
        status: 1,
        data,
      }
    },
  },
  {
    // 统计卡计数：跟随节点/关键词范围，不受 status 筛选影响
    url: '/fake/app/instance/status-counts',
    method: 'post',
    response: ({ body }) => {
      const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : ''
      const keyword = typeof body.keyword === 'string' ? body.keyword.trim().toLowerCase() : ''
      const scoped = instanceList.filter((item) => {
        if (nodeId && item.nodeId !== nodeId) {
          return false
        }
        if (!keyword) {
          return true
        }
        return item.name.toLowerCase().includes(keyword) || item.gameCode.toLowerCase().includes(keyword)
      })
      const counts = { total: scoped.length, pendingInstall: 0, running: 0, stopped: 0, installing: 0, error: 0 }
      for (const item of scoped) {
        switch (item.status) {
          case 'pending_install':
            counts.pendingInstall++
            break
          case 'running':
            counts.running++
            break
          case 'stopped':
            counts.stopped++
            break
          case 'installing':
            counts.installing++
            break
          case 'error':
            counts.error++
            break
        }
      }
      return {
        error: '',
        status: 1,
        data: counts,
      }
    },
  },
  {
    url: '/fake/app/instance/create',
    method: 'post',
    response: ({ body }) => {
      const createdAt = nowIso()
      const item: FakeInstanceItem = {
        id: generateId(),
        nodeId: body.nodeId,
        name: body.name,
        gameCode: body.gameCode,
        status: 'stopped',
        containerId: null,
        installPath: body.installPath ?? null,
        configPath: body.configPath ?? null,
        queryPort: Number.isInteger(body.queryPort) ? body.queryPort : null,
        gamePort: Number.isInteger(body.gamePort) ? body.gamePort : null,
        rconPort: Number.isInteger(body.rconPort) ? body.rconPort : null,
        lastCommand: '等待安装任务启动',
        lastError: null,
        lastErrorPhase: null,
        ...defaultInstallMeta,
        ...defaultUpdateMeta,
        createdAt,
        updatedAt: createdAt,
      }
      instanceList = [...instanceList, item]
      const taskId = beginFakeInstall(item.id, 'install')
      return {
        error: '',
        status: 1,
        data: { ...instanceList.find(row => row.id === item.id), taskId },
      }
    },
  },
  {
    url: '/fake/app/instance/check-updates',
    method: 'post',
    response: ({ body }) => {
      const ids = Array.isArray(body?.ids)
        ? body.ids.map((id: unknown) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean)
        : undefined
      if (fakeUpdateCheckJob.checking) {
        return {
          error: '',
          status: 1,
          data: fakeUpdateCheckJob,
        }
      }
      fakeUpdateCheckJob = {
        checking: true,
        startedAt: nowIso(),
        finishedAt: null,
        result: null,
        error: null,
      }
      setTimeout(() => {
        const result = buildFakeUpdateCheckResult(ids)
        fakeUpdateCheckJob = {
          checking: false,
          startedAt: fakeUpdateCheckJob.startedAt,
          finishedAt: nowIso(),
          result,
          error: null,
        }
      }, 1500)
      return {
        error: '',
        status: 1,
        data: fakeUpdateCheckJob,
      }
    },
  },
  {
    url: '/fake/app/instance/check-updates/status',
    method: 'get',
    response: () => ({
      error: '',
      status: 1,
      data: fakeUpdateCheckJob,
    }),
  },
  {
    url: '/fake/app/instance/update',
    method: 'post',
    response: ({ body }) => {
      const id = body.id as string
      const taskId = beginFakeInstall(id, 'update')
      return {
        error: '',
        status: 1,
        data: {
          isSuccess: true,
          taskId,
        },
      }
    },
  },
  {
    url: '/fake/app/instance/start',
    method: 'post',
    response: ({ body }) => {
      const id = body.id as string
      instanceList = instanceList.map(item => item.id === id ? { ...item, status: 'running', updatedAt: nowIso() } : item)
      return {
        error: '',
        status: 1,
        data: {
          isSuccess: true,
        },
      }
    },
  },
  {
    url: '/fake/app/instance/stop',
    method: 'post',
    response: ({ body }) => {
      const id = body.id as string
      instanceList = instanceList.map(item => item.id !== id ? item : {
        ...item, status: 'stopped', updatedAt: nowIso(),
        ...(item.installLogStatus === 'running' ? { installLogStatus: 'cancelled' as const, installPercent: null,
          installTask: { ...item.installTask!, status: 'cancelled' as const, phase: '安装已取消' } } : {}),
      })
      return {
        error: '',
        status: 1,
        data: {
          isSuccess: true,
        },
      }
    },
  },
  {
    url: '/fake/app/instance/restart',
    method: 'post',
    response: ({ body }) => {
      const id = body.id as string
      instanceList = instanceList.map(item => item.id === id ? { ...item, status: 'running', updatedAt: nowIso() } : item)
      return {
        error: '',
        status: 1,
        data: {
          isSuccess: true,
        },
      }
    },
  },
  {
    url: '/fake/app/instance/delete',
    method: 'post',
    response: ({ body }) => {
      const id = body.id as string
      instanceList = instanceList.filter(item => item.id !== id)
      return {
        error: '',
        status: 1,
        data: {
          isSuccess: true,
        },
      }
    },
  },
  {
    url: '/fake/app/instance/connect-info',
    method: 'get',
    response: ({ query }) => {
      const instanceId = typeof query.instanceId === 'string' ? query.instanceId : ''
      const target = instanceList.find(item => item.id === instanceId)
      const running = target?.status === 'running'
      return {
        error: '',
        status: 1,
        data: {
          running,
          command: running ? 'c_connect("203.0.113.1", 10999)' : 'c_connect("<宿主机 IP>", 10999)',
          localCommand: running ? 'c_connect("127.0.0.1", 10999)' : 'c_connect("127.0.0.1", 10999)',
          lanCommand: running ? 'c_connect("192.168.1.100", 10999)' : null,
          host: running ? '127.0.0.1' : '<宿主机 IP>',
          port: target?.gamePort ?? 10999,
          udpPorts: [10999, 8766, 12346, 11000, 8768, 12348],
          roomName: target?.name ?? 'BubbleSharkPanel',
          networkMode: 'offline',
          networkModeLabel: '离线',
          hasPassword: false,
          hostSourceLabel: '未探测到',
          isPlaceholder: !running,
          preferredMode: running ? 'lan' : 'local',
          hints: [],
          consoleShards: {
            masterRunning: running,
            cavesConfigured: true,
            cavesRunning: running,
          },
        },
      }
    },
  },
  {
    url: '/fake/app/instance/console/logs',
    method: 'get',
    response: ({ query }) => {
      const instanceId = typeof query.instanceId === 'string' ? query.instanceId : ''
      const target = instanceList.find(item => item.id === instanceId)
      return {
        error: '',
        status: 1,
        data: {
          lines: target
            ? [{
                id: 1,
                stream: 'system',
                text: `[fake] 实例「${target.name}」控制台已连接`,
                at: nowIso(),
              }]
            : [],
          running: target?.status === 'running',
        },
      }
    },
  },
  {
    url: '/fake/app/instance/console/logs/clear',
    method: 'post',
    response: () => ({
      error: '',
      status: 1,
      data: { isSuccess: true },
    }),
  },
  {
    url: '/fake/app/instance/console/command',
    method: 'post',
    response: ({ body }) => {
      const instanceId = body.instanceId as string
      const command = String(body.command ?? '').trim()
      const target = instanceList.find(item => item.id === instanceId)
      return {
        error: '',
        status: 1,
        data: {
          isSuccess: Boolean(target && command),
        },
      }
    },
  },
  {
    url: '/fake/app/instance/maintenance/announce',
    method: 'get',
    response: ({ query }) => {
      const instanceId = typeof query.instanceId === 'string' ? query.instanceId : ''
      return {
        error: '',
        status: 1,
        data: getMaintenanceState(instanceId),
      }
    },
  },
  {
    url: '/fake/app/instance/maintenance/announce',
    method: 'put',
    response: ({ body }) => {
      const instanceId = String(body.instanceId ?? '')
      const message = String(body.message ?? '').trim()
      const updatedAt = nowIso()
      maintenanceDrafts.set(instanceId, { message, updatedAt })
      return {
        error: '',
        status: 1,
        data: getMaintenanceState(instanceId),
      }
    },
  },
  {
    url: '/fake/app/instance/maintenance/announce/push',
    method: 'post',
    response: ({ body }) => {
      const instanceId = String(body.instanceId ?? '')
      const target = instanceList.find(item => item.id === instanceId)
      const bodyMessage = String(body.message ?? '').trim()
      const draftMessage = maintenanceDrafts.get(instanceId)?.message?.trim() ?? ''
      const message = bodyMessage || draftMessage
      const running = target?.status === 'running'
      const pushLog = {
        id: generateId(),
        message,
        operatorAccount: 'admin',
        status: running && message ? 'success' as const : 'failed' as const,
        errorMessage: running && message ? null : (message ? '实例未运行' : '公告内容不能为空'),
        pushedAt: nowIso(),
      }
      const logs = maintenancePushLogs.get(instanceId) ?? []
      maintenancePushLogs.set(instanceId, [pushLog, ...logs].slice(0, 20))
      if (bodyMessage) {
        maintenanceDrafts.set(instanceId, { message, updatedAt: nowIso() })
      }
      return {
        error: '',
        status: 1,
        data: {
          isSuccess: pushLog.status === 'success',
          pushLog,
          ...(pushLog.errorMessage ? { errorMessage: pushLog.errorMessage } : {}),
        },
      }
    },
  },
])
