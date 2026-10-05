#!/bin/sh
# 开发容器依赖守卫（docker-compose.dev.yml 的 panel / web 共用）。
#
# 背景：/app/node_modules 挂的是长期保留的命名卷（panel-node-modules / web-node-modules），
# 旧写法「只有 node_modules/.modules.yaml 不存在时才 pnpm install」会让卷里一直停留在
# 旧 lockfile 的安装结果：一旦拉取的新代码新增了依赖，启动时不会补装，Vite/tsx 直接
# 报 ERR_MODULE_NOT_FOUND（典型：vite/plugins.ts 静态 import 的 rollup-plugin-visualizer）。
# 现在改为按 pnpm-lock.yaml 的 sha256 指纹判断：lockfile 变了才重装，既不漏装也不每次白跑安装。
set -e

stamp_file="node_modules/.bsp-lock-stamp"
current="$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)"

if [ -f node_modules/.modules.yaml ] && [ -f "$stamp_file" ] && [ "$(cat "$stamp_file")" = "$current" ]; then
  exit 0
fi

if [ -f node_modules/.modules.yaml ]; then
  echo "[dev-deps] pnpm-lock.yaml 已变化，重新安装依赖…"
else
  echo "[dev-deps] 首次安装依赖…"
fi

pnpm install --frozen-lockfile
printf '%s\n' "$current" > "$stamp_file"
echo "[dev-deps] 依赖已就绪"
