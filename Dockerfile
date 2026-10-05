# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
# 容器无 TZ 默认 UTC；计划任务 daily「每日 HH:MM」按服务器本地时区计算，不设时区会被
# 换算成 UTC 相位（北京时间用户创建 08:40 实际执行/显示为 16:40）。
# 运行时可用 environment TZ 覆盖；Node 用内置 ICU 解析时区名，无需安装 tzdata。
ARG TZ=Asia/Shanghai
ENV TZ=${TZ}
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
# patches 必须先于 install 就位（pnpm-workspace.yaml patchedDependencies 指向此目录）
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages ./packages
# pnpm store 走 BuildKit cache mount：重复构建免重新下载，且不进入任何镜像层
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

FROM deps AS build
# 显式 COPY 构建所需源码与配置（不随 .dockerignore 演进而意外带入无关文件）；
# package.json/pnpm 元数据/packages/patches 已由 deps 层提供
COPY src ./src
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY vite ./vite
COPY public ./public
COPY index.html loading.html ./
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY vite.config.ts uno.config.ts postcss.config.js components.json ./
RUN pnpm run build && pnpm run build:server

# 运行层不再复用 deps：服务端由 esbuild 全量自包含打包（与 build-native-release.mjs
# 的 native release 同款配置，已在生产验证），零 node_modules 依赖，
# 最终镜像 = 基础镜像 + dist + dist-server + 迁移文件（~1.15GB → ~280MB）。
FROM node:22-bookworm-slim AS production
ARG TZ=Asia/Shanghai
ENV TZ=${TZ}
ARG BSP_RELEASE_VERSION=dev
ARG BSP_BUILD_SHA=unknown
ENV NODE_ENV=production
ENV BSP_RELEASE_VERSION=${BSP_RELEASE_VERSION}
ENV BSP_BUILD_SHA=${BSP_BUILD_SHA}
LABEL org.opencontainers.image.version="${BSP_RELEASE_VERSION}"
LABEL org.opencontainers.image.revision="${BSP_BUILD_SHA}"
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
# resolveRepoRoot() 需向上探测 package.json；同时保留版本信息
COPY --from=build /app/package.json ./package.json
COPY server/drizzle ./server/drizzle
EXPOSE 8888
ENV SERVER_HOST=0.0.0.0
ENV SERVER_PORT=8888
ENV DB_PATH=/app/data/bubblesharkpanel.sqlite
ENV SERVER_LOG_DIR=/app/logs
# 镜像内无 curl/wget，用 node 内置 fetch 探活 /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERVER_PORT||8888)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 注：暂不以 USER node 运行。docker.sock 的宿主 gid 因发行版而异（Debian 999 / 官方镜像 root），
# 非 root 需要 entrypoint 动态调组或 compose group_add，且 /app/data、/app/logs 绑定挂载
# 需要属主匹配；该部署模型变更需真实环境矩阵验证后再启用。
CMD ["node", "dist-server/main.js"]
