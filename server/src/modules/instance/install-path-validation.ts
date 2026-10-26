import path from 'node:path'
import process from 'node:process'

const DANGEROUS_WINDOWS_PATHS = [
  'Windows',
  'Program Files',
  'Program Files (x86)',
  'ProgramData',
  'Users',
]
/** Linux 系统目录黑名单：实例目录不得落入（对 POSIX 绝对路径生效） */
const DANGEROUS_POSIX_PREFIXES = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/boot',
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/root',
]

export interface InstallPathValidationOptions {
  /** 实例根目录（BSP_INSTANCES_ROOT） */
  instancesRoot?: string
  /** instances-root=必须位于实例根目录之下；缺省时仅做危险目录过滤（兼容既有实例的启动/删除） */
  policy?: 'instances-root' | 'any'
}

export function validateInstallPath(rawPath: string, options: InstallPathValidationOptions = {}): string | undefined {
  if (!rawPath) {
    return '安装路径不能为空'
  }
  if (!path.isAbsolute(rawPath)) {
    return '安装路径必须为绝对路径'
  }
  if (/[\0`$;&|]/.test(rawPath)) {
    return '安装路径包含危险字符'
  }
  const normalized = path.normalize(rawPath)
  const segments = normalized.split(/[\\/]/).filter(Boolean)
  if (segments.includes('..')) {
    return '安装路径不能包含上级目录跳转'
  }
  const resolved = path.resolve(normalized)
  const root = path.parse(resolved).root
  if (resolved === root) {
    return '安装路径不能为磁盘根目录'
  }
  if (process.platform === 'win32') {
    const blocked = DANGEROUS_WINDOWS_PATHS.map((item) => {
      return path.resolve(root, item).toLowerCase()
    })
    const resolvedLower = resolved.toLowerCase()
    if (blocked.some(item => resolvedLower === item || resolvedLower.startsWith(`${item}\\`))) {
      return '安装路径命中过滤规则，请使用业务目录'
    }
  }
  // Linux 系统目录黑名单：防止实例目录（以及删除时的 rmSync -rf）触达 /etc、/usr 等。
  if (resolved.startsWith('/')) {
    const resolvedLower = resolved.toLowerCase()
    if (DANGEROUS_POSIX_PREFIXES.some(item => resolvedLower === item || resolvedLower.startsWith(`${item}/`))) {
      return '安装路径命中系统目录过滤规则，请使用实例数据目录'
    }
  }
  // 创建实例时强制收敛到实例根目录，杜绝"实例管理员≈宿主 root"的挂载提权路径。
  if (options.policy === 'instances-root' && options.instancesRoot) {
    const instancesRoot = path.resolve(options.instancesRoot)
    const relative = path.relative(instancesRoot, resolved)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return '安装路径必须位于实例数据目录（BSP_INSTANCES_ROOT）之下；如确需自定义目录，请设置 BSP_INSTALL_PATH_POLICY=any 并自行承担隔离风险'
    }
  }
}
