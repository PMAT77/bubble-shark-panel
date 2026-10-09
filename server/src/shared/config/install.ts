import { readBrandEnv } from '../../../../shared/brand-env'

function isTruthyEnv(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase() ?? ''
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function isFalsyEnv(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase() ?? ''
  return normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off'
}

/** 同机从已有实例复制游戏 depot（bin64/steamapps），跳过 Steam 全量下载。默认开启 */
export function isInstallSeedEnabled(): boolean {
  const raw = readBrandEnv('BSP_INSTALL_SEED_ENABLED')?.trim()
  if (raw === undefined || raw === '') {
    return true
  }
  if (isFalsyEnv(raw)) {
    return false
  }
  return isTruthyEnv(raw) || true
}

/** @deprecated 安装必须准备运行镜像；原延迟拉取配置已忽略。 */
export function shouldDeferDstImagePullOnInstall(): boolean {
  return false
}
