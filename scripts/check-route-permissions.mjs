#!/usr/bin/env node
/**
 * 路由鉴权门禁：**每一条业务路由都必须显式声明鉴权**。
 *
 * 为什么需要它：本项目的鉴权是逐路由手写的，没有任何全局兜底钩子——
 * 新增一条路由时忘了写 `requirePermission` / `authorizeInstance`，它就默认公开。
 * 这不是假想的风险：RBAC 改造时统计出的三条匿名接口（`/app/route/list`、
 * 密码找回、找回状态探测）就是这么来的，其中 `/app/route/list` 会把整张功能地图
 * （含每项需要的权限点）交给匿名请求。
 *
 * 判定方式：从路由定义行往后扫到下一个路由定义为止，看这段 handler 里有没有出现
 * 任意一种鉴权调用。**允许匿名**的路由必须写进下面的白名单，并在注释里说明理由。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const repoRoot = path.resolve(import.meta.dirname, '..')
const modulesDir = path.join(repoRoot, 'server/src/modules')

/** 鉴权调用的形态；模块内自己封装的辅助函数也在其中 */
const AUTH_CALL_PATTERNS = [
  /\brequirePermission\(/,
  /\bresolveAuthorizedContext\(/,
  /\bverifyAuthorized\(/,
  /\bverifyAuthorizedUser\(/,
  /\bauthorizeInstance\(/,
  /\bresolveInstanceScope\(/,
  /\bauthorizeBackupInstance\(/,
  /\bauthorizeTaskInstance\(/,
  /\bauthorizeModInstance\(/,
  /\bauthorize\(request/,
  /\bauthorizeTask\(/,
  // auth 模块自己实现登录校验：拿 token 反查用户，等价于 requirePermission 的登录部分
  /\bfindUserByToken\(/,
]

/**
 * 允许匿名访问的路由（必须写清理由，否则下一个人不知道该不该照抄）。
 *
 * 注意 `/app/instance/console/stream` 走的是**一次性票据**：鉴权发生在
 * `stream-ticket` 签发那一步，而签发接口本身是要权限的。
 */
const ANONYMOUS_ROUTES = new Map([
  ['/app/account/login', '登录本身必须匿名'],
  ['/app/account/logout', '只吊销传入的令牌；无效令牌是无操作，没有可泄露或可破坏的东西'],
  ['/app/account/token/refresh', 'refresh token 本身就是凭据：access token 过期后必须还能换新的'],
  ['/app/account/password/recover', '密码找回靠 GSH_PASSWORD_RECOVERY_TOKEN 与限流把关'],
  ['/app/account/password/recovery-status', '只回答"服务端是否配了在线找回口令"'],
  ['/app/instance/console/stream', '票据制：鉴权在 stream-ticket 签发时完成'],
])

const ROUTE_RE = /app\.(get|post|put|delete)\(\s*'([^']+)'/
const FILE_SKIP_RE = /\.test\.ts$/
const FUNCTION_RE = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g

/**
 * 收集本文件里「函数体内含鉴权调用」的函数名。
 *
 * 有了它才能认出**委托型 handler**：`/app/instance/list` 的鉴权写在
 * `handleListInstances` 里、`/app/instance/metrics` 写在 `handleInstanceMetrics` 里，
 * 只看 handler 本身会误判成「没鉴权」——而误判的代价是让人去给已经安全的接口
 * 再加一道，真正漏掉的反而淹没在噪音里。
 *
 * 用大括号配平取函数体：这些文件的缩进风格不统一，按缩进切不可靠。
 */
function collectGuardedFunctions(text) {
  const names = new Set()
  FUNCTION_RE.lastIndex = 0
  let match
  while ((match = FUNCTION_RE.exec(text)) !== null) {
    const bodyStart = text.indexOf('{', match.index + match[0].length)
    if (bodyStart < 0) {
      continue
    }
    let depth = 0
    let bodyEnd = text.length - 1
    for (let i = bodyStart; i < text.length; i++) {
      if (text[i] === '{') {
        depth += 1
      }
      else if (text[i] === '}') {
        depth -= 1
        if (depth === 0) {
          bodyEnd = i
          break
        }
      }
    }
    const body = text.slice(bodyStart, bodyEnd + 1)
    if (AUTH_CALL_PATTERNS.some(re => re.test(body))) {
      names.add(match[1])
    }
  }
  return names
}

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(p, acc)
    }
    else if (entry.name.endsWith('.ts') && !FILE_SKIP_RE.test(entry.name)) {
      acc.push(p)
    }
  }
  return acc
}

const problems = []
let checked = 0

for (const file of walk(modulesDir)) {
  const fileText = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const lines = fileText.split('\n')
  const guardedFunctions = collectGuardedFunctions(fileText)
  const routeIndexes = []
  lines.forEach((line, i) => {
    if (ROUTE_RE.test(line)) {
      routeIndexes.push(i)
    }
  })

  routeIndexes.forEach((startIndex, order) => {
    const routeMatch = lines[startIndex].match(ROUTE_RE)
    const routePath = routeMatch[2]
    const endIndex = routeIndexes[order + 1] ?? lines.length
    // 只看到下一个路由为止：避免把下一条路由的鉴权误算成本条的
    const handler = lines.slice(startIndex, endIndex).join('\n')
    const hasDirectAuth = AUTH_CALL_PATTERNS.some(re => re.test(handler))
    const hasDelegatedAuth = [...guardedFunctions]
      .some(name => new RegExp(`\\b${name}\\(`).test(handler))
    checked += 1

    if (hasDirectAuth || hasDelegatedAuth) {
      return
    }
    if (ANONYMOUS_ROUTES.has(routePath)) {
      return
    }
    const relative = path.relative(repoRoot, file).replace(/\\/g, '/')
    problems.push(`${relative}:${startIndex + 1}  ${routePath}`)
  })
}

if (problems.length > 0) {
  console.error('[route-permissions] 下列路由没有声明鉴权，等于对匿名请求开放：')
  for (const problem of problems) {
    console.error(`  - ${problem}`)
  }
  console.error('\n如果它确实应当匿名，请加入 scripts/check-route-permissions.mjs 的 ANONYMOUS_ROUTES 并写明理由。')
  process.exit(1)
}

console.log(`[route-permissions] ${checked} 条路由均已声明鉴权（其中 ${ANONYMOUS_ROUTES.size} 条在白名单里）`)
