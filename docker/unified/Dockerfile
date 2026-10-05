# 刻意不使用 `# syntax=docker/dockerfile:1`：该指令会强制 BuildKit 从 Docker Hub 拉取
# docker/dockerfile 前端镜像，国内网络下会让 `docker compose build` 直接失败
# （failed to resolve source metadata ... authorization failed）。
# 本文件只用标准 Dockerfile 语法，内置 frontend 即可解析。
# 若将来引入 `RUN --mount=` / heredoc 等特性，再按需加回并解决镜像源。
#
# BubbleShark Panel 统一镜像：面板（Node.js）+ DST 运行库 + SteamCMD。
#
# 镜像保持「中性」：不设 ENTRYPOINT / HEALTHCHECK / USER ——
# - 面板入口由 docker-compose.yml 的 command 提供（与镜像 CMD 一致）；
# - DST 实例容器由面板显式传入 Cmd（绝对路径二进制，见 runtime-spec.ts）；
# - SteamCMD 任务容器由面板显式传入 Cmd 与 User（1000:1000，见 steamcmd-job.ts），
#   且创建时显式 WorkingDir=/home/steam/steamcmd（该目录属主 uid/gid 1000）。
# 基础镜像 node:22-bookworm-slim 自带 uid 1000（node 用户），SteamCMD 目录直接
# 以数值 uid/gid 1000 授权，passwd 名称不影响容器运行。
#
# 层顺序：node 基础 → 系统库+SteamCMD（极少变化）→ node_modules（依赖变化才变）
# → 应用代码（每次发版）。面板小更新只需拉取最后一层。
FROM node:22-bookworm-slim AS base
# 容器无 TZ 默认 UTC；计划任务 daily「每日 HH:MM」按服务器本地时区计算，不设时区会被
# 换算成 UTC 相位。DST/SteamCMD 子容器继承镜像 ENV，此处一并修正。
# 运行时可用 environment TZ 覆盖；Node 用内置 ICU 解析时区名，无需安装 tzdata。
ARG TZ=Asia/Shanghai
ENV TZ=${TZ}
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
# 可选：npm 兼容源，留空走官方 registry。国内链路拉 @iconify/json（约 60MB）常被
# ECONNRESET 打断，docker-compose.yml 已透传该参数：
#   NPM_REGISTRY=https://registry.npmmirror.com docker compose build
# 用 RUN 内 export 而非顶层 ENV：registry 只在安装期生效，不写进生产镜像的环境。
ARG NPM_REGISTRY=
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
# pnpm-workspace.yaml 的 patchedDependencies 指向 patches/；缺这个目录会让
# `pnpm install --frozen-lockfile` 以 ENOENT 失败（exit 254）。
COPY patches ./patches
RUN if [ -n "$NPM_REGISTRY" ]; then export npm_config_registry="$NPM_REGISTRY"; fi; \
    export npm_config_fetch_retries=5 \
           npm_config_fetch_retry_maxtimeout=300000 \
           npm_config_fetch_timeout=300000; \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# 前端构建期变量：.env.production 被 .dockerignore 的 .env* 规则排除，
# 必须在构建阶段显式注入，否则 import.meta.env.VITE_APP_API_BASEURL 为 undefined，
# 控制台 SSE 的地址构造会抛异常、实时日志只剩轮询兜底。
ARG VITE_APP_API_BASEURL=/
ENV VITE_APP_API_BASEURL=${VITE_APP_API_BASEURL}
RUN pnpm run build && pnpm run build:server

# 运行时基础：Debian 12 + DST 32 位运行库 + SteamCMD（构建期 SHA256 强校验与自检）。
FROM base AS runtime
ARG BSP_RELEASE_VERSION=dev
ARG BSP_BUILD_SHA=unknown
ARG STEAMCMD_ARCHIVE_URL=https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz
ARG STEAMCMD_ARCHIVE_SHA256=
LABEL org.opencontainers.image.title="BubbleShark Panel unified runtime"
LABEL org.opencontainers.image.description="BubbleShark Panel panel, DST runtime libraries and SteamCMD in one image"
LABEL org.opencontainers.image.source="https://github.com/PMAT77/bubble-shark-panel"
LABEL org.opencontainers.image.version="${BSP_RELEASE_VERSION}"
LABEL org.opencontainers.image.revision="${BSP_BUILD_SHA}"

RUN dpkg --add-architecture i386 \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    lib32gcc-s1 \
    lib32stdc++6 \
    libc6-i386 \
    libcurl3-gnutls \
    libcurl4 \
    libcurl4:i386 \
    libgcc-s1 \
    libstdc++6 \
  && install -d -m 0755 -o 1000 -g 1000 /home/steam /home/steam/steamcmd \
  && curl --fail --location --retry 3 --retry-delay 2 --output /tmp/steamcmd.tar.gz "${STEAMCMD_ARCHIVE_URL}" \
  && if [ -n "${STEAMCMD_ARCHIVE_SHA256}" ]; then echo "${STEAMCMD_ARCHIVE_SHA256}  /tmp/steamcmd.tar.gz" | sha256sum --check --strict; fi \
  && tar --extract --gzip --file /tmp/steamcmd.tar.gz --directory /home/steam/steamcmd \
  && chown -R 1000:1000 /home/steam \
  && for attempt in 1 2 3; do \
    if setpriv --reuid 1000 --regid 1000 --clear-groups env HOME=/home/steam /home/steam/steamcmd/steamcmd.sh +quit; then break; fi; \
    if [ "${attempt}" = 3 ]; then exit 1; fi; \
    sleep 5; \
  done \
  && rm -rf /var/lib/apt/lists/* /tmp/steamcmd.tar.gz

# 面板内「一键更新」：updater 容器直接以本镜像运行 `docker compose up -d panel`，
# 不再依赖从 Docker Hub 拉取 docker:27-cli（国内/离线部署下必然拉不到）。
# 静态二进制地址可用构建参数指向镜像站或内网制品库；仅 x86_64（本镜像本就只支持 amd64）。
ARG DOCKER_CLI_VERSION=29.8.0
ARG COMPOSE_VERSION=v5.5.1
ARG DOCKER_CLI_URL=
ARG COMPOSE_PLUGIN_URL=
# 这两个静态二进制合计约 150MB，国内链路实测只有 60~100 KB/s：curl 的 --retry 对
# `HTTP/2 stream ... PROTOCOL_ERROR`（err 92）这类错误不重试，就算重试也是从 0 字节
# 重来（curl(1)：重试前会删掉已收到的数据），一条 82MB 的链接根本重试不起。
# 所以这里两层兜底：
#   1) 统一加 --http1.1：这类 PROTOCOL_ERROR 来自链路上的中间设备处理 HTTP/2 有误，
#      单流下载本来也用不到多路复用；--retry-all-errors 让协议错误能在连接层就地重试；
#   2) 外层 for 循环每轮都带 -C -：连接断了、这轮用尽重试后 sleep 再试，下一轮从已下载
#      的字节续传（两个源都是标准 CDN，支持 Range），重跑时不必再花十几分钟重下前半段。
# gzip -t / docker compose version 兼作完整性校验：拿到截断的文件就删掉重来。
# compose 插件必须是可执行的（0755）：docker CLI 判定子命令是否存在，靠的就是执行
# 这个二进制；少了可执行位它不报权限错误，而是报 `unknown command: docker compose`。
# 同款做法见 scripts/install.linux.sh 与 docs/install-docker.md 的手动补装步骤。
RUN set -eux; \
  docker_cli_url="${DOCKER_CLI_URL:-https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz}"; \
  compose_url="${COMPOSE_PLUGIN_URL:-https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64}"; \
  curl_flags="--fail --location --http1.1 --retry 3 --retry-delay 2 --retry-all-errors --connect-timeout 20"; \
  download() { \
    for attempt in 1 2 3 4 5; do \
      if curl ${curl_flags} -C - --output "$2" "$1"; then return 0; fi; \
      if [ "${attempt}" = 5 ]; then echo "download failed after 5 attempts: $1" >&2; return 1; fi; \
      sleep 5; \
    done; \
  }; \
  download "$docker_cli_url" /tmp/docker-cli.tgz; \
  for attempt in 1 2; do \
    if gzip -t /tmp/docker-cli.tgz; then break; fi; \
    if [ "${attempt}" = 2 ]; then echo "corrupt archive: $docker_cli_url" >&2; exit 1; fi; \
    rm -f /tmp/docker-cli.tgz; \
    download "$docker_cli_url" /tmp/docker-cli.tgz; \
  done; \
  mkdir -p /tmp/docker-cli; \
  tar --extract --gzip --file /tmp/docker-cli.tgz --directory /tmp/docker-cli --strip-components 1 docker/docker; \
  install -m 0755 /tmp/docker-cli/docker /usr/local/bin/docker; \
  mkdir -p /usr/local/lib/docker/cli-plugins; \
  compose_plugin=/usr/local/lib/docker/cli-plugins/docker-compose; \
  download "$compose_url" "$compose_plugin"; \
  chmod 0755 "$compose_plugin"; \
  docker --version; \
  docker compose version; \
  rm -rf /tmp/docker-cli /tmp/docker-cli.tgz

# DST 实例容器内默认游戏根目录（游戏二进制由 SteamCMD 安装到挂载卷）。
ENV GAME_ROOT=/game

FROM runtime AS production
ARG BSP_RELEASE_VERSION=dev
ARG BSP_BUILD_SHA=unknown
ENV NODE_ENV=production
ENV BSP_RELEASE_VERSION=${BSP_RELEASE_VERSION}
ENV BSP_BUILD_SHA=${BSP_BUILD_SHA}
WORKDIR /app
# 服务端已 esbuild 全量自包含打包（scripts/build-server.mjs：packages='bundle'，与
# build-native-release.mjs 的 native release 同款配置，已在生产验证），运行时零
# node_modules 依赖——不再从 deps 层拷贝 node_modules，镜像体积减少约 900MB。
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
# resolveRepoRoot() 需向上探测 package.json；同时保留版本信息
COPY package.json ./package.json
COPY server/drizzle ./server/drizzle
EXPOSE 8888
ENV SERVER_HOST=0.0.0.0
ENV SERVER_PORT=8888
ENV DB_PATH=/app/data/bubblesharkpanel.sqlite
ENV SERVER_LOG_DIR=/app/logs
# 面板入口即镜像默认命令；DST/SteamCMD 子容器会以面板显式 Cmd 覆盖。
CMD ["node", "dist-server/main.js"]
