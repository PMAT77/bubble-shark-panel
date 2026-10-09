import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { getServerContainerConfig } from '../../shared/config/container'

interface ProcessIdentity { pid: number, started: string }
function recordPath(id: string) {
  return path.join(getServerContainerConfig().nativeRuntimeDir, 'steamcmd-jobs', encodeURIComponent(id) + '.json')
}
function processInfo(pid: number) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { state: fields[0], group: Number(fields[2]), started: fields[19], uid: fs.statSync(`/proc/${pid}`).uid }
  }
  catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
    throw error
  }
}

/** 记录 Linux 进程出生时间，重启清理时避免 PID 复用误杀。 */
export function registerNativeSteamcmdProcess(id: string, pid: number) {
  if (process.platform !== 'linux') return () => {}
  const info = processInfo(pid)
  if (!info) return () => {}
  const file = recordPath(id)
  const identity: ProcessIdentity = { pid, started: info.started }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(identity), { mode: 0o600 })
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as ProcessIdentity
      if (current.pid === pid && current.started === identity.started) fs.rmSync(file)
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}

/** 面板重启后也须确认整个进程组结束，才允许相同目录再次安装。 */
export async function cancelRecordedNativeSteamcmdProcess(id: string) {
  if (process.platform !== 'linux') return
  const file = recordPath(id)
  let identity: ProcessIdentity
  try { identity = JSON.parse(fs.readFileSync(file, 'utf8')) as ProcessIdentity }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 1 || !/^\d+$/.test(identity.started)) throw new Error('Native 安装进程记录无效，无法确认任务已停止')
  const parent = processInfo(identity.pid)
  if (parent && parent.started !== identity.started) { fs.rmSync(file); return }
  const liveMembers = () => fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    const info = processInfo(Number(name))
    if (!info || info.group !== identity.pid || info.state === 'Z') return []
    if (info.uid !== process.getuid!()) throw new Error('Native 安装进程所有者不匹配，无法确认任务已停止')
    return [info]
  })
  if (liveMembers().length) {
    try { process.kill(-identity.pid, 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    const deadline = Date.now() + 5000
    while (liveMembers().length && Date.now() < deadline) await delay(100)
    if (liveMembers().length) {
      try { process.kill(-identity.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      const killDeadline = Date.now() + 5000
      while (liveMembers().length && Date.now() < killDeadline) await delay(100)
    }
    if (liveMembers().length) throw new Error('无法确认 Native 安装进程组已停止，请再次停止实例')
  }
  fs.rmSync(file, { force: true })
}
