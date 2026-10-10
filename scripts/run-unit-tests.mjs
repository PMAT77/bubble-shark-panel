process.env.BSP_UNIT_TEST = '1'

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/**
 * 不要加 `--test-force-exit`。
 *
 * 它会在测试跑完后强制结束进程，而这时插件子进程、套接字等句柄可能仍在关闭过程中；
 * Windows 上 libuv 会直接在 `src/win/async.c` 断言失败（`UV_HANDLE_CLOSING`），
 * 表现是**某个文件级用例被判失败**（`tests` 比实际多一项、`fail 1`，且没有任何断言信息）。
 * 既然测试能自己干净退出（全套 118 秒内跑完），就不需要这最后一脚；
 * 万一将来某个用例真的不退，那是句柄泄漏，应该去修它，而不是把整个进程强杀掉。
 */
const args = [
  path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  '--test',
  '--test-concurrency=1',
  'server/src/**/*.test.ts',
  'scripts/**/*.test.ts',
  'src/api/**/*.test.ts',
  'src/router/**/*.test.ts',
  'src/composables/**/*.test.ts',
  'src/store/**/*.test.ts',
  'src/utils/**/*.test.ts',
  'src/views/**/*.test.ts',
]

const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  env: process.env,
  cwd: repoRoot,
})

process.exit(result.status ?? 1)
