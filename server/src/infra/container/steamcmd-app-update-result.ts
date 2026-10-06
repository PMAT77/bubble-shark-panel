import fs from 'node:fs'
import path from 'node:path'
import { parseKeyValuesRoot, readKeyValues } from '../../shared/steam-update/app-info'
import { diagnoseDstInstallReadiness } from '../game-adapter/dst/install-readiness'

/** SteamCMD 有时在中止更新后仍输出 Success 并以 0 退出。 */
export function validateSteamcmdAppUpdateResult<T extends { ok: boolean, output: string }>(
  result: T, installPath: string, appId: string,
): T {
  if (!result.ok) return result
  if (/Timed out waiting for update to start|Waiting for user info.*ERROR|ERROR!|Update state.*(?:timed? out|bailing|failed)/i.test(result.output)) {
    return { ...result, ok: false }
  }
  let error: string | undefined
  try {
    const candidates = [path.join(installPath, 'steamapps', `appmanifest_${appId}.acf`), path.join(installPath, `appmanifest_${appId}.acf`)]
    const manifest = candidates.find(file => fs.existsSync(file))
    const local = manifest ? parseKeyValuesRoot(fs.readFileSync(manifest, 'utf8'), 'AppState', true) : null
    const depots = readKeyValues(local, 'InstalledDepots')
    const build = readKeyValues(local, 'buildid')
    if (readKeyValues(local, 'appid') !== appId || readKeyValues(local, 'StateFlags') !== '4'
      || typeof build !== 'string' || !/^[1-9]\d*$/.test(build)
      || !depots || typeof depots === 'string' || !Object.keys(depots).length
      || Object.values(depots).some(depot => {
        const gid = typeof depot === 'string' ? null : readKeyValues(depot, 'manifest')
        return typeof gid !== 'string' || !/^[1-9]\d*$/.test(gid)
      })) error = '本地安装清单缺失或不完整'
    else if (appId === '343050' && !diagnoseDstInstallReadiness(installPath).ready) error = '游戏文件尚未就绪'
  }
  catch { error = '无法读取本地安装清单' }
  return error ? { ...result, ok: false, output: `${result.output}\nMissing configuration: ${error}` } : result
}
