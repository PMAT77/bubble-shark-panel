/**
 * 宿主机内存档位与运维提示（安装脚本、API、文档共用口径）。
 * 档位按 MemTotal 划分，与宝塔等面板显示的「已用%」无关。
 */

export type HostMemoryTier = 'small' | 'medium' | 'large'

/** 总内存上限（MiB，不含）：small < 5120，medium < 8192，其余 large */
export const HOST_MEMORY_TIER_SMALL_MAX_MB = 5120
export const HOST_MEMORY_TIER_MEDIUM_MAX_MB = 8192

/** 安装脚本：低于此值输出 WARN（约 4 GiB） */
export const HOST_MEMORY_INSTALL_WARN_MIN_MB = 3800

export interface HostMemoryTierScenario {
  singleInstance: string
  caves: string
  mods: string
  multiInstance: string
}

export interface HostMemoryGuidancePayload {
  tier: HostMemoryTier
  tierLabelZh: string
  presetName: HostMemoryTier
  totalMb: number | null
  availableMb: number | null
  summaryZh: string
  scenarios: HostMemoryTierScenario
  cavesWarning: string | null
  modsWarning: string | null
  installWarning: string | null
}

export function resolveHostMemoryTier(totalMb: number): HostMemoryTier {
  if (!Number.isFinite(totalMb) || totalMb <= 0) {
    return 'medium'
  }
  if (totalMb < HOST_MEMORY_TIER_SMALL_MAX_MB) {
    return 'small'
  }
  if (totalMb < HOST_MEMORY_TIER_MEDIUM_MAX_MB) {
    return 'medium'
  }
  return 'large'
}

const TIER_LABEL_ZH: Record<HostMemoryTier, string> = {
  small: '小内存（约 4 GiB）',
  medium: '中等（约 6 GiB）',
  large: '充足（8 GiB 及以上）',
}

const TIER_SCENARIOS: Record<HostMemoryTier, HostMemoryTierScenario> = {
  small: {
    singleInstance: '仅建议 1 个运行中的实例（地上世界）',
    caves: '开启洞穴前检查 swap、两个分片峰值与宿主机余量',
    mods: 'Mod 体量差异较大，请按资源设置中的实测峰值调整额度',
    multiInstance: '不建议同机多实例同时运行',
  },
  medium: {
    singleInstance: '优先 1 个实例；洞穴与多 Mod 需观察加载峰值',
    caves: '检查两个分片总占用；安装/大更新时建议先停止实例',
    mods: 'Mod 数量无法保证内存够用，请结合实测峰值与 swap 余量',
    multiInstance: '第二实例可用 seed 复制；避免与安装/更新并行',
  },
  large: {
    singleInstance: '可规划单实例与洞穴，仍需检查分片总占用',
    caves: '洞穴与地上可同时运行',
    mods: '较多 Mod 仍建议观察游戏分片实测峰值',
    multiInstance: '同机多实例需自行规划总内存与上限',
  },
}

const TIER_SUMMARY_ZH: Record<HostMemoryTier, string> = {
  small: '总内存偏小：优先单实例地上世界，检查 swap 与加载峰值，避免安装与运行叠加。',
  medium: '总内存适中：洞穴与多 Mod 需结合实测峰值规划；重操作前请先停止其它实例。',
  large: '总内存较充足：适合洞穴与较多 Mod；仍建议为 SteamCMD 安装预留空闲内存。',
}

function resolveCavesWarning(tier: HostMemoryTier): string | null {
  if (tier === 'small') {
    return '当前宿主机内存档位偏小：洞穴会额外运行一个游戏分片。请先配置 swap 并检查两个分片的实测峰值；频繁换页会拖慢加载，宿主机余量不足时仍可能 OOM。'
  }
  if (tier === 'medium') {
    return '开启洞穴会增加内存占用；请检查两个分片峰值与 swap 余量。若同时进行 Steam 安装/更新，请先停止正在运行的实例。'
  }
  return null
}

function resolveModsWarning(tier: HostMemoryTier): string | null {
  if (tier === 'small') {
    return 'Mod 会占用 DST 游戏进程内存：小内存机请控制订阅数量与体量，避免与 Steam 安装、洞穴同时加压。'
  }
  if (tier === 'medium') {
    return '订阅较多或大型 Mod 时请关注监控台内存；安装/更新服务端期间建议停止实例。'
  }
  return null
}

function resolveInstallWarning(
  tier: HostMemoryTier,
  availableMb: number | null,
): string | null {
  const lowAvailable = availableMb !== null && availableMb < 1792
  if (tier === 'small' || lowAvailable) {
    const availHint = availableMb !== null ? `当前可用约 ${availableMb} MiB。` : ''
    return `${availHint}Steam 安装会短时占用较多内存：请先停止其它运行中实例，避免与洞穴实例、大量 Mod 同时使用。同机第二实例请优先使用 seed 复制。`
  }
  if (tier === 'medium') {
    return '安装或更新服务端时占用会升高：若已有实例在运行，建议先停止再执行，以免与洞穴分片争抢内存。'
  }
  return null
}

export function buildHostMemoryGuidance(input: {
  totalMb: number | null
  availableMb?: number | null
}): HostMemoryGuidancePayload {
  const totalMb = input.totalMb
  const availableMb = input.availableMb ?? null
  const tier = totalMb !== null ? resolveHostMemoryTier(totalMb) : 'medium'

  return {
    tier,
    tierLabelZh: TIER_LABEL_ZH[tier],
    presetName: tier,
    totalMb,
    availableMb,
    summaryZh: TIER_SUMMARY_ZH[tier],
    scenarios: TIER_SCENARIOS[tier],
    cavesWarning: resolveCavesWarning(tier),
    modsWarning: resolveModsWarning(tier),
    installWarning: resolveInstallWarning(tier, availableMb),
  }
}

export function formatInstallMemoryWarnMessage(totalMb: number): string {
  const tier = resolveHostMemoryTier(totalMb)
  const scenarios = TIER_SCENARIOS[tier]
  return [
    `检测到宿主机总内存约 ${totalMb} MiB（档位：${TIER_LABEL_ZH[tier]}）。`,
    `建议：${scenarios.singleInstance}；${scenarios.caves}；${scenarios.mods}。`,
    '可在安装目录使用 config/panel.env.presets/ 下对应预设，详见 docs/MEMORY.md。',
  ].join(' ')
}
