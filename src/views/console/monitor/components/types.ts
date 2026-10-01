import type { SelectOption } from 'naive-ui'
import type { HostMemoryGuidancePayload } from '@/types/host-memory-guidance'

export interface SystemInfoData {
  cpu: {
    cores: number
    model: string
    usageRate: number
  }
  load: {
    oneMinute: number
    fiveMinutes: number
    fifteenMinutes: number
    usageRate: number
    isSynthetic: boolean
    cpuQueueLength: number | null
    diskQueueLength: number | null
  }
  memory: {
    totalGb: number
    usedGb: number
    freeGb: number
    usageRate: number
    availableGb: number | null
    /** 未配置缓存区时为 null —— 与「配置了但已用满」是两种处境 */
    swap: {
      totalGb: number
      usedGb: number
      freeGb: number
      usageRate: number
    } | null
  }
  memoryGuidance: HostMemoryGuidancePayload
  disk: {
    totalGb: number
    usedGb: number
    freeGb: number
  }
  os: {
    platform: string
    release: string
    arch: string
    hostname: string
  }
  panelVersion: string
  runtimeMode: 'docker' | 'native'
  runtimeStatus: 'running' | 'stopped'
  dockerStatus: 'running' | 'stopped'
}

export interface NetworkInterfaceRealtimeData {
  name: string
  upBps: number
  downBps: number
  totalSentBytes: number
  totalReceivedBytes: number
}

export interface NetworkRealtimeData {
  timestamp: number
  interfaces: NetworkInterfaceRealtimeData[]
}

export interface NetworkChartPoint {
  time: string
  upBps: number
  downBps: number
}

export type MonitorNetworkOption = SelectOption
