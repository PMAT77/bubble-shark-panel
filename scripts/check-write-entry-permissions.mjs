#!/usr/bin/env node
/**
 * 前端写入口权限门禁：**调用了写接口的界面文件必须做权限判断**。
 *
 * 为什么需要它：后端的逐路由鉴权只保证"点了也不会成功"，不保证"看不到入口"。
 * 一个只读账号（游客角色）点进任何页面都会看到一堆按钮，点了才被告知无权限——
 * 那是误导，也让"能看不能改"这件事看起来像坏了。所以界面上的写入口必须自己
 * 按权限点隐藏，而这类判断是逐处手写的，**漏一处不会有任何报错**，只会安静地
 * 多出一个点了必然失败的按钮。
 *
 * 判定方式：
 * 1. 从服务端路由反推出「要求了 write 权限点的接口」——这是"写接口"的定义，
 *    比按 HTTP 方法猜准（本项目不少只读接口是 POST：列表、状态、票据、校验）；
 * 2. 从 `src/api/modules/*.ts` 反推出这些接口对应的前端方法名；
 * 3. 扫 `src/{views,components,layouts}` 里对这些方法的调用点：文件内必须出现
 *    `hasPermission(` / `authAll(` / `<AppAuth` 之一，否则报错。
 *
 * 有意的宽松处（漏判优于误报）：
 * - 服务端鉴权写在委托函数里、且权限点没能被反查出来的接口，会被当成读接口跳过——
 *   最坏结果是漏掉一个入口，而不是让一堆正确代码无谓地进白名单；
 * - 判断按**文件**级别：同一文件里某个按钮有判断，就认为该文件的写入口已处理。
 *   调用点分散在 composable 里、判断在调用方的地方（如 useInstanceLifecycleActions）
 *   只能靠白名单说明。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const repoRoot = path.resolve(import.meta.dirname, '..')

/**
 * 免检的界面文件。每一条都必须写清理由，否则下一个人不知道该不该照抄。
 */
const ALLOWED_FILES = new Map([
  ['src/views/node/instance/composables/useInstanceLifecycleActions.ts', '委托型：启停/更新的调用封装，入口按钮在 InstanceManagement.vue，那里已用 <AppAuth> 逐个过滤'],
  ['src/views/games/dst/player/manage.vue', '委托型：踢人/封禁/加入名单的调用封装，按钮在 OnlinePlayersPanel.vue，那里已按 player:kick / player:ban / player:write 过滤'],
  ['src/views/node/instance/composables/useInstanceRuntimeObservability.ts', '只读：只调 metrics 这类查询接口'],
  ['src/composables/useScheduleRunNotifier.ts', '只读：轮询计划任务与实例列表，不含任何写操作'],
  ['src/components/AppAccountButton/index.vue', '账号自身操作（登出），与权限点无关'],
  ['src/components/AppAccountForm/login.vue', '登录接口必须匿名可调'],
  ['src/components/AppAccountForm/reset-password.vue', '密码找回必须匿名可调'],
  ['src/components/AppAccountForm/edit-password.vue', '改自己的密码只需要登录，任何账号都该能做'],
  ['src/views/system/MembersSection.vue', '成员管理页自身：需要 member:write 才能改，本次只读范围不含该模块'],
  ['src/views/system/RolesSection.vue', '角色管理页自身：需要 role:write 才能改，本次只读范围不含该模块'],
])

/** 权限点 → read/write，来自唯一真源 shared/constants/permissions.ts */
function readPermissionActions() {
  const text = fs.readFileSync(path.join(repoRoot, 'shared/constants/permissions.ts'), 'utf8')
  const actions = new Map()
  const re = /key:\s*'([^']+)'[\s\S]{0,220}?action:\s*'(read|write)'/g
  let match
  while ((match = re.exec(text)) !== null) {
    actions.set(match[1], match[2])
  }
  return actions
}

function walk(dir, acc = [], filter = () => true) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, acc, filter)
    }
    else if (filter(entry.name)) {
      acc.push(full)
    }
  }
  return acc
}

const ROUTE_RE = /app\.(get|post|put|delete)\(\s*'([^']+)'/
const PERMISSION_RE = /'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*:(?:read|write))'/g
const FUNCTION_RE = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g

/** 一个文件里「函数名 → 该函数用到的权限点」，用于认出手写鉴权的委托 handler */
function collectFunctionPermissions(text) {
  const result = new Map()
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
    const permissions = new Set()
    let permissionMatch
    PERMISSION_RE.lastIndex = 0
    while ((permissionMatch = PERMISSION_RE.exec(body)) !== null) {
      permissions.add(permissionMatch[1])
    }
    result.set(match[1], permissions)
  }
  return result
}

/** 服务端：反推哪些接口要求了 write 权限点 */
function collectWriteEndpoints(permissionActions) {
  const endpoints = new Map()
  const files = walk(path.join(repoRoot, 'server/src/modules'), [], name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    const lines = text.split('\n')
    const functionPermissions = collectFunctionPermissions(text)
    const routeIndexes = []
    lines.forEach((line, index) => {
      if (ROUTE_RE.test(line)) {
        routeIndexes.push(index)
      }
    })
    routeIndexes.forEach((startIndex, order) => {
      const routeMatch = lines[startIndex].match(ROUTE_RE)
      const endIndex = routeIndexes[order + 1] ?? lines.length
      const segment = lines.slice(startIndex, endIndex).join('\n')
      const permissions = new Set()
      let match
      PERMISSION_RE.lastIndex = 0
      while ((match = PERMISSION_RE.exec(segment)) !== null) {
        permissions.add(match[1])
      }
      // 委托型 handler：路由段里调用的函数，把它自己用到的权限点也算进来
      for (const [name, functionPermissionSet] of functionPermissions) {
        if (new RegExp(`\\b${name}\\(`).test(segment)) {
          for (const permission of functionPermissionSet) {
            permissions.add(permission)
          }
        }
      }
      const isWrite = [...permissions].some(permission => permissionActions.get(permission) === 'write')
      if (isWrite) {
        endpoints.set(`${routeMatch[1]} ${routeMatch[2]}`, path.relative(repoRoot, file).replace(/\\/g, '/'))
      }
    })
  }
  return endpoints
}

/** 前端 api 层：方法名 → 它请求的接口 */
function collectApiMethods() {
  const methods = []
  const dir = path.join(repoRoot, 'src/api/modules')
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.ts') && !name.endsWith('.fake.ts'))
  for (const file of files) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/api\.(get|post|put|delete)\(\s*'([^']+)'/)
      if (!match) {
        continue
      }
      let name = ''
      for (let j = i; j >= 0 && j > i - 8; j--) {
        const nameMatch = lines[j].match(/^\s{2}([A-Za-z0-9_]+):/)
        if (nameMatch) {
          name = nameMatch[1]
          break
        }
      }
      if (name) {
        methods.push({ name, method: match[1], endpoint: `${match[1]} /${match[2].replace(/^\//, '')}` })
      }
    }
  }
  return methods
}

const permissionActions = readPermissionActions()
const writeEndpoints = collectWriteEndpoints(permissionActions)
const writeMethods = collectApiMethods().filter(item => writeEndpoints.has(item.endpoint))

const problems = []
let checked = 0
const uiFiles = [
  ...walk(path.join(repoRoot, 'src/views'), [], name => /\.(ts|vue)$/.test(name) && !name.includes('.test.')),
  ...walk(path.join(repoRoot, 'src/components'), [], name => /\.(ts|vue)$/.test(name) && !name.includes('.test.')),
  ...walk(path.join(repoRoot, 'src/layouts'), [], name => /\.(ts|vue)$/.test(name) && !name.includes('.test.')),
]

for (const file of uiFiles) {
  const relative = path.relative(repoRoot, file).replace(/\\/g, '/')
  const text = fs.readFileSync(file, 'utf8')
  const called = writeMethods.filter(item => new RegExp(`\\.${item.name}\\s*\\(`).test(text))
  if (called.length === 0) {
    continue
  }
  checked += 1
  if (/hasPermission\(|authAll\(|<AppAuth/.test(text) || ALLOWED_FILES.has(relative)) {
    continue
  }
  const unique = [...new Set(called.map(item => `${item.name} → ${item.endpoint}`))]
  problems.push(`${relative}\n    ${unique.join('\n    ')}`)
}

if (problems.length > 0) {
  console.error('[write-entries] 下列界面文件调用了写接口，但文件内没有任何权限判断：')
  for (const problem of problems) {
    console.error(`  - ${problem}`)
  }
  console.error('\n请给这些入口加上权限判断（`hasPermission(\'权限点\')` / `<AppAuth value="权限点">`），')
  console.error(`或在 scripts/check-write-entry-permissions.mjs 的 ALLOWED_FILES 里写明理由。`)
  process.exit(1)
}

console.log(`[write-entries] 检查了 ${checked} 个调用写接口的界面文件，均已做权限判断（${ALLOWED_FILES.size} 个白名单）`)
