import { defineFakeRoute } from 'vite-plugin-fake-server/client'

let panelSettings = {
  panelPort: 9527,
  theme: 'system' as const,
  autoUpdate: true,
  checkUpdateBeforeStart: false,
  updateCheckIntervalHours: 3,
  updateSource: 'auto' as const,
}

const panelUpdateStatus = {
  runtimeMode: 'docker' as const,
  image: {
    image: 'ghcr.io/pmat77/bubblesharkpanel:v0.2.0',
    tag: 'latest',
    releaseVersion: '0.2.0',
    localDigest: 'sha256:abc123',
    localDigestShort: 'abc123',
    remoteDigest: 'sha256:def456',
    remoteDigestShort: 'def456',
    updateAvailable: true,
    localPresent: true,
    checkError: null,
  },
  release: {
    tagName: 'v0.2.0',
    name: 'v0.2.0',
    // 与线上一致的长文本，用于验证面板不再原样展示发布方术语。
    body: '本 Release 的统一镜像（面板 + DST 运行环境 + SteamCMD）与 Native systemd 部署包、离线 Docker 镜像包一同发布。\n\n统一镜像的不可变 digest 见附件 `release-images.json`；Native 包与离线镜像包使用同名 `.sha256` 校验。安装与升级请使用版本 tag 或附件中的 digest，不要依赖 `latest`。\n\n**Full Changelog**: https://github.com/PMAT77/bubble-shark-panel/compare/v0.2.1...v0.2.2',
    publishedAt: new Date().toISOString(),
    htmlUrl: 'https://github.com/PMAT77/bubble-shark-panel/releases/tag/v0.2.0',
  },
  lastCheckedAt: new Date().toISOString(),
  checking: false,
  updating: false,
  applySupported: true,
  imageApplySupported: false,
  nativeUpdateSupported: false,
  applyHint: '开发环境未配置 BSP_STACK_DIR',
  updateKind: 'same-version-changed' as const,
  manualUpdateCommand: 'cd /opt/bubblesharkpanel && docker compose --env-file panel.env -f docker-compose.yml -f docker-compose.bind.yml pull && docker compose --env-file panel.env -f docker-compose.yml -f docker-compose.bind.yml up -d',
  offlineImageCommand: 'wget https://github.com/PMAT77/bubble-shark-panel/releases/download/v0.2.0/bubblesharkpanel-v0.2.0-docker-image.tar.gz\ngunzip -c bubblesharkpanel-v0.2.0-docker-image.tar.gz | docker load',
  checkError: null,
  updatePhase: 'idle' as const,
  updateMessage: null,
  updateError: null,
  targetImage: null,
  targetImageReady: false,
  downloadBytes: null,
  downloadTotalBytes: null,
}

let networkTick = 0

export default defineFakeRoute([
  {
    url: '/fake/app/system/settings',
    method: 'get',
    response: () => ({
      error: '',
      status: 1,
      data: {
        ...panelSettings,
        apiPort: 8888,
        isProduction: false,
      },
    }),
  },
  {
    url: '/fake/app/system/settings',
    method: 'post',
    response: ({ body }) => {
      panelSettings = {
        panelPort: Number(body.panelPort) || 9527,
        theme: body.theme ?? 'system',
        autoUpdate: Boolean(body.autoUpdate),
        checkUpdateBeforeStart: Boolean(body.checkUpdateBeforeStart),
        updateCheckIntervalHours: Number(body.updateCheckIntervalHours) || 3,
        updateSource: body.updateSource ?? 'auto',
      }
      return {
        error: '',
        status: 1,
        data: {
          isSuccess: true,
          portSync: null,
        },
      }
    },
  },
  {
    url: '/fake/app/system/info',
    method: 'get',
    response: () => ({
      error: '',
      status: 1,
      data: {
        cpu: {
          cores: 8,
          model: 'Mock CPU',
          usageRate: 23.5,
        },
        load: {
          oneMinute: 1.2,
          fiveMinutes: 0.9,
          fifteenMinutes: 0.7,
          usageRate: 15,
          isSynthetic: false,
          cpuQueueLength: null,
          diskQueueLength: null,
        },
        memory: {
          totalGb: 16,
          usedGb: 6.2,
          freeGb: 9.8,
          usageRate: 38.75,
          availableGb: 9.5,
          swap: {
            totalGb: 2,
            usedGb: 0.4,
            freeGb: 1.6,
            usageRate: 20,
          },
        },
        memoryGuidance: {
          tier: 'large',
          tierLabelZh: '充足（8 GiB 及以上）',
          presetName: 'large',
          totalMb: 16384,
          availableMb: 9728,
          summaryZh: '总内存较充足：适合洞穴与较多 Mod；仍建议为 SteamCMD 安装预留空闲内存。',
          scenarios: {
            singleInstance: '单实例 + 洞穴 + 较多 Mod 较从容',
            caves: '洞穴与地上可同时运行',
            mods: '较多 Mod 仍建议观察 DST 容器内存',
            multiInstance: '同机多实例需自行规划总内存与上限',
          },
          cavesWarning: null,
          modsWarning: null,
          installWarning: null,
        },
        disk: {
          totalGb: 512,
          usedGb: 212,
          freeGb: 300,
        },
        os: {
          platform: 'linux',
          release: '6.8.0',
          arch: 'x64',
          hostname: 'mock-host',
        },
        panelVersion: '0.1.0',
        runtimeMode: 'docker',
        runtimeStatus: 'running',
        dockerStatus: 'running',
      },
    }),
  },
  {
    url: '/fake/app/system/network/realtime',
    method: 'get',
    response: () => {
      networkTick += 1
      const wave = Math.sin(networkTick / 3)
      return {
        error: '',
        status: 1,
        data: {
          timestamp: Date.now(),
          interfaces: [
            {
              name: 'eth0',
              upBps: Number((120_000 + wave * 40_000).toFixed(2)),
              downBps: Number((860_000 + wave * 120_000).toFixed(2)),
              totalSentBytes: 1_024_000_000 + networkTick * 50_000,
              totalReceivedBytes: 8_192_000_000 + networkTick * 200_000,
            },
            {
              name: 'docker0',
              upBps: Number((12_000 + wave * 5_000).toFixed(2)),
              downBps: Number((45_000 + wave * 8_000).toFixed(2)),
              totalSentBytes: 256_000_000 + networkTick * 10_000,
              totalReceivedBytes: 512_000_000 + networkTick * 20_000,
            },
          ],
        },
      }
    },
  },
  {
    url: '/fake/app/system/panel-update/status',
    method: 'get',
    response: () => ({
      error: '',
      status: 1,
      data: panelUpdateStatus,
    }),
  },
  {
    url: '/fake/app/system/panel-update/check',
    method: 'post',
    response: () => ({
      error: '',
      status: 1,
      data: {
        ...panelUpdateStatus,
        lastCheckedAt: new Date().toISOString(),
      },
    }),
  },
  {
    url: '/fake/app/system/panel-update/apply',
    method: 'post',
    response: ({ body }) => {
      const action = (body as { action?: string } | undefined)?.action
      return {
        error: '',
        status: 1,
        data: {
          // 开发环境不做真实下载：download 直接回报「已就绪」，install 进入进行中
          status: action === 'download' ? 'ready' : 'updating',
          message: action === 'download'
            ? '开发环境：镜像视为已在本地，点击「立即安装」即可重建面板。'
            : '开发环境：已开始处理，页面会自动显示进度。',
        },
      }
    },
  },
])
