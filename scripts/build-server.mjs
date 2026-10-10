/**
 * 服务端打包：把 server/src 打成 dist-server/ 下的 ESM bundle（自包含）。
 *
 * - 依赖全部打进 bundle（packages='bundle'），与 build-native-release.mjs 的
 *   native release 配置一致（该模式已在生产验证）。运行时零 node_modules 依赖，
 *   Docker production 层不再携带 node_modules（镜像 ~1.15GB → ~280MB）；
 * - 仅 external 原生模块 cpu-features（esbuild 无法打包的 gyp addon，运行时
 *   由 createRequire banner 兜底解析）；
 * - splitting + format=esm 处理 bundle 内的动态 import；
 * - 运行时不再有需要随包拷贝的静态资源（世界配置改由 worldgenoverride.lua 单一真源生成）。
 *
 * 用法：node scripts/build-server.mjs（或 pnpm run build:server）
 */
import path from 'node:path'
import { build } from 'esbuild'

const repoRoot = path.resolve(import.meta.dirname, '..')

await build({
  entryPoints: {
    main: path.join(repoRoot, 'server/src/main.ts'),
    'modinfo-reader-worker': path.join(repoRoot, 'server/src/infra/game-adapter/dst/modinfo-reader-worker.mjs'),
  },
  outdir: path.join(repoRoot, 'dist-server'),
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'bundle',
  external: ['cpu-features'],
  banner: {
    js: [
      'import { createRequire as __gshCreateRequire } from "node:module";',
      'import { fileURLToPath as __gshFileURLToPath } from "node:url";',
      'import { dirname as __gshDirname } from "node:path";',
      'const require = __gshCreateRequire(import.meta.url);',
      'const __filename = __gshFileURLToPath(import.meta.url);',
      'const __dirname = __gshDirname(__filename);',
    ].join(' '),
  },
  sourcemap: false,
  logLevel: 'info',
})

