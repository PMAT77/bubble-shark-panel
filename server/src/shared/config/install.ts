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

/**
 * 安装完成时不拉取 DST 运行镜像，推迟到首次启动。
 * 默认 true；设 BSP_INSTALL_DEFER_DST_IMAGE_PULL=0 可在安装结束时仍 pull。
 */
export function shouldDeferDstImagePullOnInstall(): boolean {
  const raw = readBrandEnv('BSP_INSTALL_DEFER_DST_IMAGE_PULL')?.trim()
  if (raw === undefined || raw === '') {
    return true
  }
  if (isFalsyEnv(raw)) {
    return false
  }
  return isTruthyEnv(raw) || true
}
