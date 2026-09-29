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
  // 「任一读权限点即可」：同样要求登录 + 权限，只是命中一项就算过
  /\brequireAnyReadPermission\(/,
  // 与上一条同义，只是要把鉴权上下文交回调用方（例如接着按授权范围过滤列表）
  /\bresolveAnyReadPermission\(/,
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
  // 这两条是游客（只读预览）免密登录：
  // - login-options 只回答"本面板是否开放只读预览"与一个展示用账号名，不含任何凭证；
  //   登录页必须在**渲染之前**知道有没有这个入口，否则只能给用户一个点了报错的按钮。
  // - guest-login 不含账号与密码字段（游客凭证根本不存在，见 shared/db/guest-account.ts）：
  //   它靠"服务端开关 + IP 维度限流 + 指针指向的固定游客账号"三件事把关。
  ['/app/account/login-options', '只回答"服务端是否开放游客（只读预览）入口"，不含凭证与账号信息'],
  ['/app/account/guest-login', '游客免密登录：服务端开关 + IP 限流 + 固定游客账号（无口令可泄露）'],
  ['/app/instance/console/stream', '票据制：鉴权在 stream-ticket 签发时完成'],
])

const ROUTE_RE = /app\.(get|post|put|delete)\(\s*'([^']+)'/
const FILE_SKIP_RE = /\.test\.ts$/
const FUNCTION_RE = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g

/**
 * 找函数体的左花括号。
 *
 * 不能直接取签名后的第一个 `{`：返回类型里可能有对象字面量
 * （`): Promise<{ error?: X }> {`），那会把类型本身当成函数体——于是函数里的鉴权调用
 * 一个都看不见，路由被误判成"没鉴权"。类型上下文里的左花括号前面是
 * `<`、`:`、`,`、`|`、`&`、`(`、`[`，据此跳过。
 */
function findFunctionBodyStart(text, fromIndex) {
  for (let i = fromIndex; i < text.length; i++) {
    if (text[i] !== '{') {
      continue
    }
    let j = i - 1
    while (j >= 0 && /\s/.test(text[j])) {
      j -= 1
    }
    const previous = text[j]
    if (previous === '<' || previous === ':' || previous === ',' || previous === '|'
      || previous === '&' || previous === '(' || previous === '[') {
      continue
    }
    return i
  }
  return -1
}

/**
 * 收集本文件里每个函数的函数体（含函数名）。
 *
 * 用大括号配平取函数体：这些文件的缩进风格不统一，按缩进切不可靠。
 */
function collectFunctionBodies(text) {
  const bodies = new Map()
  FUNCTION_RE.lastIndex = 0
  let match
  while ((match = FUNCTION_RE.exec(text)) !== null) {
    const bodyStart = findFunctionBodyStart(text, match.index + match[0].length)
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
    bodies.set(match[1], text.slice(bodyStart, bodyEnd + 1))
  }
  return bodies
}

/**
 * 收集本文件里「函数体内含鉴权调用」的函数名。
 *
 * 有了它才能认出**委托型 handler**：`/app/instance/list` 的鉴权写在 `handleListInstances` 里、
 * `/app/instance/metrics` 写在 `handleInstanceMetrics` 里，只看 handler 本身会误判成「没鉴权」——
 * 而误判的代价是让人去给已经安全的接口再加一道，真正漏掉的反而淹没在噪音里。
 *
 * 委托可以是**两层**：`/app/instance/list` → `handleListInstances` → `resolveVisibleInstances`
 * → 鉴权调用。只认一层会把这种短链委托判成"没鉴权"，逼作者把鉴权重复写两遍；
 * 所以这里求一次闭包（某函数调用了已判定为有鉴权的函数，它自己也算有鉴权）。
 */
function collectGuardedFunctions(text) {
  const bodies = collectFunctionBodies(text)
  const guarded = new Set()
  for (const [name, body] of bodies) {
    if (AUTH_CALL_PATTERNS.some(re => re.test(body))) {
      guarded.add(name)
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const [name, body] of bodies) {
      if (guarded.has(name)) {
        continue
      }
      for (const guardedName of guarded) {
        if (new RegExp(`\\b${guardedName}\\(`).test(body)) {
          guarded.add(name)
          changed = true
          break
        }
      }
    }
  }
  return guarded
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
