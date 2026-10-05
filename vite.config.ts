import { readBrandEnv } from './shared/brand-env'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import dayjs from 'dayjs'
import { defineConfig, loadEnv } from 'vite'
import { parseLoadedEnv } from 'vite-plugin-env-parse'
import pkg from './package.json'
import createVitePlugins from './vite/plugins'

function resolveDevPort(defaultPort: number): number {
  const raw = process.env.VITE_DEV_WEB_PORT?.trim()
  if (!raw) {
    return defaultPort
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return defaultPort
  }
  return parsed
}

// https://vitejs.dev/config/
export default defineConfig(({ mode, command }) => {
  const env = parseLoadedEnv(loadEnv(mode, process.cwd()))
  // 全局 scss 资源
  const scssResources: string[] = []
  fs.readdirSync('src/assets/styles/resources').forEach((dirname) => {
    if (fs.statSync(`src/assets/styles/resources/${dirname}`).isFile()) {
      scssResources.push(`@use "/src/assets/styles/resources/${dirname}" as *;`)
    }
  })
  return {
    // 开发服务器选项 https://cn.vitejs.dev/config/server-options
    server: {
      open: false,
      host: true,
      // 前端默认 9527；后端默认 8888（server/src/shared/config），互不冲突。
      // 显式设置 VITE_DEV_WEB_PORT 时优先生效（dev:compose 栈同样为 9527）
      port: resolveDevPort(9527),
      strictPort: true,
      clearScreen: false,
      ...(readBrandEnv('BSP_DEV_COMPOSE_QUIET') === '1' ? { logLevel: 'warn' as const } : {}),
      // 根目录下的 pnpm 包缓存与内置 Node 发行版共 5 万+ 文件，不在 Vite 默认忽略列表内
      // （默认只忽略 .git / node_modules / test-results / 缓存与输出目录），
      // 会让文件监听器过载并导致 HMR 静默失效，这里显式排除。
      watch: {
        ignored: [
          '**/.pnpm-store/**',
          '**/.ci-node22/**',
        ],
      },
      proxy: {
        '/proxy': {
          target: env.VITE_APP_API_BASEURL,
          changeOrigin: command === 'serve' && env.VITE_ENABLE_PROXY,
          rewrite: path => path.replace(/\/proxy/, ''),
        },
      },
    },
    // 构建选项 https://cn.vitejs.dev/config/build-options
    build: {
      outDir: mode === 'production' ? 'dist' : `dist-${mode}`,
      sourcemap: env.VITE_BUILD_SOURCEMAP,
    },
    define: {
      __SYSTEM_INFO__: JSON.stringify({
        pkg: {
          // 页面自身的构建版本：与后端 /health 的 release.version 比对，识别「标签页还跑着旧界面」
          version: pkg.version,
          dependencies: pkg.dependencies,
          devDependencies: pkg.devDependencies,
        },
        lastBuildTime: dayjs().format('YYYY-MM-DD HH:mm:ss'),
      }),
    },
    plugins: createVitePlugins(mode, command === 'build'),
    optimizeDeps: {
      exclude: ['@fantastic-admin/components'],
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
        '#': path.resolve(__dirname, 'src/types'),
      },
    },
    css: {
      preprocessorOptions: {
        scss: {
          additionalData: scssResources.join(''),
        },
      },
    },
  }
})
