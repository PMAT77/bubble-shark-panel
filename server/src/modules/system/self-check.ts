import { readBrandEnv } from '../../../../shared/brand-env'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { buildHostMemoryGuidance } from '../../../../shared/host-memory-guidance'
import type { SelfCheckItem, SelfCheckReport } from '../../../../shared/contracts/system'
import { collectHostResourceSnapshot } from '../../shared/host-metrics'
import { loadServerConfig } from '../../shared/config'
import { getCachedDockerStatus } from '../../infra/docker'
import { getCachedRuntimeStatus, isSteamcmdRuntimeReady } from '../../infra/runtime'
import { getSteamUpstreamStatus } from '../../infra/game-adapter/dst/steam-workshop'
import { getNotifySettings, listGameInstances, listNotifyChannels } from '../../shared/db/index'
import { resolveConsoleLogsDir } from '../../shared/instance-runtime/console-log-file'

/** 磁盘余量阈值：低于 fail 值基本装不下游戏本体，低于 warn 值更新时会紧张 */
export const SELF_CHECK_DISK_FAIL_GB = 2
export const SELF_CHECK_DISK_WARN_GB = 5

export interface SelfCheckWritableProbe {
  label: string
  path: string
  writable: boolean
}

/**
 * Mod 市场上游链路快照。
 *
 * 这一项不主动打上游：它读的是「上次真实请求留下的状态」，所以自检本身不会
 * 变慢，也不会因为面板刚好在断网而把自检卡住。
 */
export interface SelfCheckSteamUpstreamProbe {
  configuredSources: string[]
  sourceOrder: string[]
  openSources: string[]
  lastSuccessSource: string | null
  lastSuccessAt: string | null
  proxyEnabled: boolean
  proxySource: string | null
  proxyHost: string | null
  webApiBaseConfigured: boolean
  relayConfigured: boolean
}

/**
 * 自检输入：全部是「已经取到的实测值」。
 *
 * 判定逻辑做成纯函数，采集放在 collectSelfCheckInput 里：
 * 这样各分支的结论可以直接用单测覆盖，不必去 mock 文件系统与数据库。
 */
export interface SelfCheckInput {
  releaseVersion: string
  runtimeMode: string
  runtimeStatus: string
  dockerStatus: string
  steamcmdReady: boolean
  diskTotalGb: number
  diskFreeGb: number
  memoryTotalMb: number | null
  writablePaths: SelfCheckWritableProbe[]
  instanceCount: number
  errorInstanceCount: number
  notifyEnabled: boolean
  failingChannelCount: number
  /** Mod 市场上游链路；未提供时这一项按「跳过」展示 */
  steamUpstream?: SelfCheckSteamUpstreamProbe | null
}

function countByStatus(items: SelfCheckItem[]): SelfCheckReport['summary'] {
  return {
    ok: items.filter(item => item.status === 'ok').length,
    warn: items.filter(item => item.status === 'warn').length,
    fail: items.filter(item => item.status === 'fail').length,
    skipped: items.filter(item => item.status === 'skipped').length,
  }
}

export function buildSelfCheckReport(input: SelfCheckInput, now = new Date()): SelfCheckReport {
  const items: SelfCheckItem[] = []

  // 运行环境
  if (input.runtimeMode === 'docker') {
    const ready = input.dockerStatus === 'running'
    items.push({
      id: 'runtime',
      label: '运行环境',
      status: ready ? 'ok' : 'fail',
      detail: ready ? 'Docker 可用，游戏实例以容器方式运行' : `Docker 状态异常（${input.dockerStatus}）`,
      hint: ready ? null : '确认 Docker 服务已启动且面板能访问运行时；见安装文档的问题清单。',
    })
  }
  else {
    const active = input.runtimeStatus === 'running'
    items.push({
      id: 'runtime',
      label: '运行环境',
      status: active ? 'ok' : 'fail',
      detail: active ? '系统服务运行中，游戏实例以系统服务方式运行' : `服务状态异常（${input.runtimeStatus}）`,
      hint: active ? null : '确认面板服务处于运行状态；见安装文档的问题清单。',
    })
  }

  // SteamCMD / 游戏运行环境
  items.push({
    id: 'steamcmd',
    label: 'SteamCMD 就绪',
    status: input.steamcmdReady ? 'ok' : 'warn',
    detail: input.steamcmdReady ? 'SteamCMD 已就绪，可安装与更新游戏' : 'SteamCMD 尚未就绪',
    hint: input.steamcmdReady ? null : '首次安装或更新游戏时面板会自动准备；若长时间未就绪，去「实例管理」页点「检查 SteamCMD」。',
  })

  // 磁盘余量
  if (input.diskFreeGb < SELF_CHECK_DISK_FAIL_GB) {
    items.push({
      id: 'disk',
      label: '磁盘余量',
      status: 'fail',
      detail: `可用 ${input.diskFreeGb} GiB / 共 ${input.diskTotalGb} GiB`,
      hint: '游戏本体与存档需要数 GB 空间，请先清理磁盘再安装或更新。',
    })
  }
  else if (input.diskFreeGb < SELF_CHECK_DISK_WARN_GB) {
    items.push({
      id: 'disk',
      label: '磁盘余量',
      status: 'warn',
      detail: `可用 ${input.diskFreeGb} GiB / 共 ${input.diskTotalGb} GiB`,
      hint: '余量偏低：更新游戏本体与创建备份时会紧张，建议清理旧备份。',
    })
  }
  else {
    items.push({
      id: 'disk',
      label: '磁盘余量',
      status: 'ok',
      detail: `可用 ${input.diskFreeGb} GiB / 共 ${input.diskTotalGb} GiB`,
      hint: null,
    })
  }

  // 内存档位
  const guidance = buildHostMemoryGuidance({ totalMb: input.memoryTotalMb })
  items.push({
    id: 'memory',
    label: '内存档位',
    status: guidance.cavesWarning ? 'warn' : 'ok',
    detail: `${guidance.tierLabelZh}${input.memoryTotalMb === null ? '' : `（约 ${input.memoryTotalMb} MiB）`}：${guidance.summaryZh}`,
    hint: guidance.cavesWarning ?? null,
  })

  // 数据目录可写
  const unwritable = input.writablePaths.filter(probe => !probe.writable)
  items.push({
    id: 'paths',
    label: '数据目录可写',
    status: unwritable.length === 0 ? 'ok' : 'fail',
    detail: unwritable.length === 0
      ? `${input.writablePaths.length} 个目录均可写`
      : `${unwritable.map(probe => probe.label).join('、')}不可写`,
    hint: unwritable.length === 0
      ? null
      : '检查目录属主与权限，或确认磁盘未写满；不可写会导致实例、备份与日志功能失效。',
  })

  // 实例状态
  if (input.instanceCount === 0) {
    items.push({
      id: 'instances',
      label: '实例状态',
      status: 'skipped',
      detail: '还没有实例',
      hint: '到「实例管理」创建第一个实例。',
    })
  }
  else if (input.errorInstanceCount > 0) {
    items.push({
      id: 'instances',
      label: '实例状态',
      status: 'warn',
      detail: `${input.instanceCount} 个实例，其中 ${input.errorInstanceCount} 个处于异常状态`,
      hint: '在实例列表查看异常实例的日志与错误信息。',
    })
  }
  else {
    items.push({
      id: 'instances',
      label: '实例状态',
      status: 'ok',
      detail: `${input.instanceCount} 个实例，没有异常状态`,
      hint: null,
    })
  }

  // 通知渠道
  if (!input.notifyEnabled) {
    items.push({
      id: 'notify',
      label: '通知渠道',
      status: 'skipped',
      detail: '通知总开关未开启',
      hint: '开启后可让实例异常退出、内存超阈值等事件推送到手机。',
    })
  }
  else if (input.failingChannelCount > 0) {
    items.push({
      id: 'notify',
      label: '通知渠道',
      status: 'warn',
      detail: `${input.failingChannelCount} 个渠道连续发送失败`,
      hint: '到「系统设置 → 通知渠道」点「测试」核对配置。',
    })
  }
  else {
    items.push({
      id: 'notify',
      label: '通知渠道',
      status: 'ok',
      detail: '已开启，没有失败渠道',
      hint: null,
    })
  }

  // 面板版本（信息项，用于反馈问题时对齐）
  items.push({
    id: 'version',
    label: '面板版本',
    status: 'ok',
    detail: input.releaseVersion || '开发构建',
    hint: null,
  })

  // Mod 市场上游链路
  items.push(buildSteamUpstreamItem(input.steamUpstream ?? null))

  return {
    generatedAt: now.toISOString(),
    releaseVersion: input.releaseVersion,
    runtimeMode: input.runtimeMode,
    items,
    summary: countByStatus(items),
  }
}

/**
 * Mod 市场能不能拉到列表，取决于「哪条链路在用」和「代理有没有生效」。
 *
 * 国内服务器上最常见的情况是：没配代理、Steam 连不上，但用户只看到列表加载不出来，
 * 不知道该改什么。这一项把这两个事实直接摆出来，并给出可复制的配置写法。
 */
function buildSteamUpstreamItem(probe: SelfCheckSteamUpstreamProbe | null): SelfCheckItem {
  const hintForProxy = '配置一个能直连 Steam 的代理后重启面板：'
    + 'Docker 部署写 BSP_STEAM_HTTPS_PROXY=http://host.docker.internal:7890，'
    + 'Native 部署写 http://127.0.0.1:7890；'
    + '也可以把 Steam 接口反代到自己的域名并配置 BSP_STEAM_WEBAPI_BASE_URL。'

  if (!probe) {
    return {
      id: 'steam-workshop',
      label: 'Mod 市场上游',
      status: 'warn',
      detail: '尚未采集到上游状态（面板启动后还没拉取过 Mod 市场）',
      hint: '打开一次「Mod 市场」后重新自检，即可看到实际生效的链路与代理状态。',
    }
  }

  const sourceText = probe.sourceOrder.length > 0
    ? probe.sourceOrder.join(' → ')
    : '无可用源'
  const proxyText = probe.proxyEnabled
    ? `代理已生效（${probe.proxySource}${probe.proxyHost ? ` @ ${probe.proxyHost}` : ''}）`
    : '未配置代理'
  const lastSuccessText = probe.lastSuccessAt
    ? `最近成功：${probe.lastSuccessAt}${probe.lastSuccessSource ? `（${probe.lastSuccessSource}）` : ''}`
    : '尚无成功记录'

  if (probe.openSources.length > 0) {
    return {
      id: 'steam-workshop',
      label: 'Mod 市场上游',
      status: 'warn',
      detail: `部分源暂时熔断：${probe.openSources.join('、')}；链路 ${sourceText}；${proxyText}`,
      hint: '熔断会在冷却后自动恢复。若反复出现，说明该链路不通，按下面的代理方式处理。'
        + `（${lastSuccessText}）`,
    }
  }

  if (!probe.proxyEnabled && !probe.webApiBaseConfigured && !probe.relayConfigured && !probe.lastSuccessAt) {
    return {
      id: 'steam-workshop',
      label: 'Mod 市场上游',
      status: 'warn',
      detail: `链路 ${sourceText}；未配置代理，且还没有成功拉到过创意工坊数据`,
      hint: hintForProxy,
    }
  }

  return {
    id: 'steam-workshop',
    label: 'Mod 市场上游',
    status: 'ok',
    detail: `链路 ${sourceText}；${proxyText}；${lastSuccessText}`,
    hint: null,
  }
}

function probeWritable(label: string, targetPath: string): SelfCheckWritableProbe {
  try {
    fs.mkdirSync(targetPath, { recursive: true })
    const probePath = path.join(targetPath, `.bsp-selfcheck-${process.pid}`)
    fs.writeFileSync(probePath, 'ok', 'utf8')
    fs.rmSync(probePath, { force: true })
    return { label, path: targetPath, writable: true }
  }
  catch {
    return { label, path: targetPath, writable: false }
  }
}

export async function collectSelfCheckReport(releaseVersion: string): Promise<SelfCheckReport> {
  const config = loadServerConfig()
  const snapshot = collectHostResourceSnapshot()
  const instances = await listGameInstances()
  const channels = await listNotifyChannels()
  const notifySettings = await getNotifySettings()
  const steamcmdReady = getCachedRuntimeStatus() === 'running' && await isSteamcmdRuntimeReady()

  const input: SelfCheckInput = {
    releaseVersion,
    runtimeMode: config.runtimeMode,
    runtimeStatus: getCachedRuntimeStatus(),
    dockerStatus: getCachedDockerStatus(),
    steamcmdReady,
    diskTotalGb: snapshot.disk.totalGb,
    diskFreeGb: snapshot.disk.freeGb,
    memoryTotalMb: snapshot.memory.totalGb > 0 ? Math.round(snapshot.memory.totalGb * 1024) : null,
    writablePaths: [
      probeWritable('实例目录', config.instancesRoot),
      probeWritable('备份目录', config.backupsRoot),
      probeWritable('日志目录', resolveConsoleLogsDir(config.dbPath)),
    ],
    instanceCount: instances.length,
    errorInstanceCount: instances.filter(instance => instance.status === 'error').length,
    notifyEnabled: notifySettings.enabled,
    failingChannelCount: channels.filter(channel => channel.healthStatus === 'failing').length,
    steamUpstream: collectSteamUpstreamProbe(),
  }
  return buildSelfCheckReport(input)
}

function collectSteamUpstreamProbe(): SelfCheckSteamUpstreamProbe {
  const status = getSteamUpstreamStatus()
  return {
    configuredSources: status.configuredSources,
    sourceOrder: status.sourceOrder,
    openSources: status.openSources,
    lastSuccessSource: status.lastSuccessSource,
    lastSuccessAt: status.lastSuccessAt,
    proxyEnabled: status.proxy.enabled,
    proxySource: status.proxy.source,
    proxyHost: status.proxy.host,
    webApiBaseConfigured: Boolean(readBrandEnv('BSP_STEAM_WEBAPI_BASE_URL')?.trim()),
    relayConfigured: Boolean(readBrandEnv('BSP_STEAM_RELAY_URL')?.trim()),
  }
}
