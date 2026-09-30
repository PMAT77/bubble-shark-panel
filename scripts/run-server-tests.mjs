process.env.GSH_UNIT_TEST = '1'

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/**
 * 不要加 `--test-force-exit`：与 `run-unit-tests.mjs` 同一原因（见 CHANGELOG 0.10.1），
 * 它会在插件子进程、套接字仍在关闭时强杀进程，Windows 上 libuv 会在 `src/win/async.c`
 * 断言失败，表现是某个文件级用例被判失败且没有任何断言信息（`fail 1`）。
 * 插件相关的用例（`server/src/plugins/audit-log-plugin.test.ts`）就是被它误判的。
 */
const args = [
  path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  '--test',
  '--test-concurrency=1',
  'server/src/**/*.test.ts',
]

const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  env: process.env,
  cwd: repoRoot,
})

process.exit(result.status ?? 1)
