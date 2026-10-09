import { pullSteamcmdImage } from './steamcmd-runner'
import type { ImagePreparationOptions } from './image-candidates'

export type SteamcmdImageEnsureResult = { ok: true } | { ok: false, error: string }

/** 确保 SteamCMD 镜像本地可用（幂等，可并发复用进行中的拉取） */
export async function ensureSteamcmdImage(options: ImagePreparationOptions = {}): Promise<SteamcmdImageEnsureResult> {
  return pullSteamcmdImage(options)
}
