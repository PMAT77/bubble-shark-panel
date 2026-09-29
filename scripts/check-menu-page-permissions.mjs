#!/usr/bin/env node
/**
 * 菜单页首屏读请求的权限门禁：**菜单能进，页面首屏的每个读请求就必须能通过**。
 *
 * 为什么需要它：服务端菜单按读权限点过滤（`server/src/shared/menu-routes.ts`），而页面
 * 首屏可能会牵动别的模块的数据。这类请求的正确修法是**让接口按页面自己的读权限放行、
 * 只回本页要用的字段**（`/app/instance/room-summaries`、`/app/instance/options` 就是这么来的），
 * 而不是给菜单加别的模块的权限——后者会让「取消查看实例」连带收走一串菜单。
 * 漏掉一处，表现是"菜单在、点进去全是 403"，而**不会有任何报错**。
 *
 * 判定方式：
 * 1. 从 `server/src/modules/**` 反推「接口 → 需要的读权限」（复用 `check-write-entry-permissions.mjs`
 *    的解析思路：路由段 + 委托函数里的权限点；`requireAnyReadPermission(...)` 是"任一"语义）；
 * 2. 从 `src/api/modules/*.ts` 反推「前端方法名 → 接口」；
 * 3. 按 `menu-routes.ts` 的模块与页面组件，扫该页面文件与其**相对导入**（`./`、`../`，
 *    停留在 `src/views/` 内）里的方法调用，得到这个页面首屏需要的读权限集合；
 * 4. 每个权限点必须满足其一：
 *    - 出现在该模块的 `auth` 里（菜单声明覆盖）；
 *    - 在该页面子树里被显式判断过（`hasPermission('key')` / `<AppAuth value="key"`）——
 *      说明"这一块自己会按权限收起"，是刻意为之；
 *    - 或写进下面的白名单并说明理由。
 *
 * 有意的宽松处（漏判优于误报）：
 * - 通过 `@/` 别名导入的 composable 不再深挖（避免把整张图表拉进来），只统计页面目录内的相对导入；
 * - 一个模块里任何一处声明过的权限点都算"该模块声明过"，不做逐页面归属。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const repoRoot = path.resolve(import.meta.dirname, '..')

/**
 * 免检页面。每一条都必须写清理由——**当前为空**：真正需要豁免时的写法是
 * `['src/views/xxx.vue', '为什么这一页首屏必然会请求自己无权读的接口']`。
 *
 * 宁可留空也不要预置"反正先放进来"的条目：这个门禁的价值全在"发现漏声明的依赖"，
 * 白名单每多一条，就多一处永远不会再报警的地方。
 */
const ALLOWED_PAGES = new Map([])

const ROUTE_RE = /app\.(get|post|put|delete)\(\s*'([^']+)'/
const PERMISSION_RE = /'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*:(?:read|write))'/g
const FUNCTION_RE = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g
const COMPONENT_RE = /component:\s*'([^']+)'/g

/** 权限点 → read/write，来自唯一真源 shared/constants/permissions.ts */
function readPermissionActions() {
  const text = fs.readFileSync(path.join(repoRoot, 'shared/constants/permissions.ts'), 'utf8')
  const actions = new Map()
  const re = /key:\s*'([^']+)'[\s\S]{0,320}?action:\s*'(read|write)'/g
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

/** 服务端：反推「接口 → { all, any }」——`requireAnyReadPermission` 是任一语义 */
function collectEndpointPermissions() {
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
      for (const [name, functionPermissionSet] of functionPermissions) {
        if (new RegExp(`\\b${name}\\(`).test(segment)) {
          for (const permission of functionPermissionSet) {
            permissions.add(permission)
          }
        }
      }
      const isAny = /(require|resolve)AnyReadPermission\(/.test(segment)
      endpoints.set(`${routeMatch[1]} ${routeMatch[2]}`, {
        all: isAny ? [] : [...permissions],
        any: isAny ? [...permissions] : [],
      })
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
        methods.push({ name, endpoint: `${match[1]} /${match[2].replace(/^\//, '')}` })
      }
    }
  }
  return methods
}

/** 菜单里的模块：标题、声明过的权限点、页面组件 */
function collectMenuModules() {
  const text = fs.readFileSync(path.join(repoRoot, 'server/src/shared/menu-routes.ts'), 'utf8').replace(/\r\n/g, '\n')
  const arrayStart = text.indexOf('menuRouteList: MenuRouteItem[] = [')
  if (arrayStart < 0) {
    throw new Error('menu-routes.ts 里找不到 menuRouteList 定义，门禁的解析方式需要跟着改')
  }
  // 模块级条目以「两空格缩进的 `},`」结束；块内部至少四空格缩进
  const chunks = text.slice(arrayStart).split(/\n {2}\},\n/)
  const modules = []
  for (const chunk of chunks) {
    const title = chunk.match(/\n {6}title: '([^']+)'/)?.[1]
    if (!title) {
      continue
    }
    const declared = new Set()
    PERMISSION_RE.lastIndex = 0
    let match
    while ((match = PERMISSION_RE.exec(chunk)) !== null) {
      declared.add(match[1])
    }
    const components = []
    COMPONENT_RE.lastIndex = 0
    while ((match = COMPONENT_RE.exec(chunk)) !== null) {
      if (match[1] !== 'Layout') {
        components.push(match[1])
      }
    }
    modules.push({ title, declared, components })
  }
  return modules
}

/** 页面文件 + 它的相对导入（停在 src/views 内），用于收集首屏调用 */
function collectPageFiles(relativeComponent) {
  const entry = path.join(repoRoot, 'src/views', relativeComponent)
  const files = new Set()
  const queue = [entry]
  while (queue.length > 0) {
    const current = queue.shift()
    if (files.has(current) || !fs.existsSync(current) || !fs.statSync(current).isFile()) {
      continue
    }
    if (!current.endsWith('.vue') && !current.endsWith('.ts')) {
      continue
    }
    files.add(current)
    const text = fs.readFileSync(current, 'utf8')
    const importRe = /from\s+'(\.[^']+)'|import\s+\w+\s+from\s+'(\.[^']+)'/g
    let match
    while ((match = importRe.exec(text)) !== null) {
      const specifier = match[1] ?? match[2]
      const base = path.resolve(path.dirname(current), specifier)
      const candidates = [base, `${base}.ts`, `${base}.vue`, path.join(base, 'index.ts'), path.join(base, 'index.vue')]
      for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          if (candidate.startsWith(path.join(repoRoot, 'src'))) {
            queue.push(candidate)
          }
          break
        }
      }
    }
  }
  return [...files]
}

const permissionActions = readPermissionActions()
const endpoints = collectEndpointPermissions()
const apiMethods = collectApiMethods()
const modules = collectMenuModules()
const problems = []
let checkedPages = 0

for (const module of modules) {
  for (const component of module.components) {
    const relative = `src/views/${component}`
    const files = collectPageFiles(component)
    const texts = files.map(file => fs.readFileSync(file, 'utf8')).join('\n')

    /** 页面子树里显式判断过的权限点：`hasPermission('key')` / `<AppAuth value="key">` */
    const guarded = new Set()
    const guardRe = /hasPermission\('([^']+)'\)|<AppAuth\s[^>]*value="([^"]+)"|authAll\(\[([^\]]*)\]/g
    let guardMatch
    while ((guardMatch = guardRe.exec(texts)) !== null) {
      if (guardMatch[1]) {
        guarded.add(guardMatch[1])
      }
      if (guardMatch[2]) {
        guarded.add(guardMatch[2])
      }
      for (const key of (guardMatch[3] ?? '').match(/[a-z][a-zA-Z0-9.]*:[a-z]+/g) ?? []) {
        guarded.add(key)
      }
    }

    const needed = new Map()
    for (const method of apiMethods) {
      if (!new RegExp(`\\.${method.name}\\s*\\(`).test(texts)) {
        continue
      }
      const requirement = endpoints.get(method.endpoint)
      if (!requirement) {
        continue
      }
      const readKeys = [...requirement.all, ...requirement.any]
        .filter(key => permissionActions.get(key) === 'read')
      if (readKeys.length === 0) {
        continue
      }
      needed.set(method.endpoint, requirement)
    }

    checkedPages += 1
    const missing = []
    for (const [endpoint, requirement] of needed) {
      const satisfiedByModule = (key) => module.declared.has(key) || guarded.has(key)
      const allOk = requirement.all
        .filter(key => permissionActions.get(key) === 'read')
        .every(satisfiedByModule)
      const anyOk = requirement.any.length === 0
        || requirement.any.some(key => module.declared.has(key) || guarded.has(key))
      if (!allOk || !anyOk) {
        missing.push(`${endpoint}（需要 ${[...requirement.all, ...requirement.any].join(' / ')}）`)
      }
    }

    if (missing.length > 0 && !ALLOWED_PAGES.has(relative)) {
      problems.push(`${module.title} → ${relative}\n    ${[...new Set(missing)].join('\n    ')}`)
    }
  }
}

if (problems.length > 0) {
  console.error('[menu-pages] 下列菜单页面首屏会请求它没有权限的接口（菜单进得去、请求必然 403）：')
  for (const problem of problems) {
    console.error(`  - ${problem}`)
  }
  console.error('\n改为让接口按页面自己的读权限放行（只回本页字段），或让页面按权限收起（hasPermission / <AppAuth>），')
  console.error('确实要豁免时写进 scripts/check-menu-page-permissions.mjs 的 ALLOWED_PAGES 并说明理由。')
  process.exit(1)
}

console.log(`[menu-pages] 检查了 ${checkedPages} 个菜单页面，首屏读请求的权限都被菜单声明或页面内的权限判断覆盖（${ALLOWED_PAGES.size} 个白名单）`)
