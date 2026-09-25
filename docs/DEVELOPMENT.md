# 开发指南

面向参与 Game Server Hub 代码贡献的开发者。生产安装见 [INSTALL.md](INSTALL.md)。

> 模块级 FDS、TODO、验收标准等内部文档位于本地 **`docs_local/`**（已 `.gitignore`，不入库）。克隆后若无该目录，请向维护者索取或自行按团队规范维护副本。

---

## 环境要求

| 项 | 要求 |
|----|------|
| Node.js | `^22.13` / `>=24`（后端使用内置 `node:sqlite`，Node 20 无法启动） |
| 包管理 | pnpm `10.33+`（见 `packageManager` 字段） |
| Docker | 实例安装/启停依赖 Docker Engine（开发 Compose 模式亦需要） |
| 数据库 | SQLite（后端首次启动时自动创建并执行迁移） |

---

## 平台定位

**Windows 仅用于本机开发调试，不是部署目标。** 本项目不提供 Windows 安装脚本，也不为"让他人联机"做兼容——生产环境是 Linux 服务器，见 [INSTALL.md](INSTALL.md)。

开发时只需保证一件事：**游戏客户端（与面板同一台电脑）能用「本机」档进服**：

```lua
c_connect("127.0.0.1", 10999, "<房间密码>")
```

- Rancher Desktop / Docker Desktop 的宿主侧端口转发（含 UDP）已覆盖这一点，无需额外配置。
- 面板控制台默认会选到「本机」档；若显示的是「公网」档且地址不是 `127.0.0.1`，点命令框右侧按钮切换即可。
- 不需要为了局域网或异地联机去打通 Windows 侧网络——那属于生产场景，且容器运行时会额外引入一层网络边界，让端口暴露成倍复杂（详见 [DST 开服教程 5.2](DST_TUTORIAL.md#52-windows-开发环境只保证本机进服)）。

---

## 克隆与依赖

```bash
# 仓库名是 game-serve-hub，而镜像名与服务和目录名是 game-server-hub，克隆后的目录名取自仓库名
git clone https://github.com/PMAT77/game-serve-hub.git
cd game-serve-hub
corepack enable
pnpm install
```

---

## 环境变量

```bash
cp .env.development.example .env.development
cp server/.env.development.example server/.env.development
```

按需修改 `VITE_APP_API_BASEURL`（默认 `http://127.0.0.1:8888`）与后端 `SERVER_PORT`（默认 `8888`）。前端开发端口默认 `9527`，可用 `VITE_DEV_WEB_PORT` 覆盖。

Docker Compose 开发模式使用 `panel.env.example`：

```bash
cp panel.env.example panel.env
```

---

## 准备运行目录

```bash
pnpm run dev:prepare
```

它只创建运行所需目录（数据目录、日志目录、实例与备份根目录）并打印解析到的配置，**不建库、也不执行迁移**：SQLite 文件与 Drizzle 迁移由后端首次启动时的 `initDatabase()` 完成（见 `server/src/shared/db/connection.ts`）。所以直接执行 `pnpm run dev` 就够了——它内部会先跑一次 `dev:prepare`。

---

## 启动（宿主机 Node，推荐日常改代码）

```bash
pnpm run dev
```

| 服务 | 地址 | 说明 |
|------|------|------|
| 前端 | `http://127.0.0.1:9527` | Vite 开发服务器 |
| 后端 | `http://127.0.0.1:8888` | Fastify API |
| 健康检查 | `GET http://127.0.0.1:8888/health` | 含 Docker 状态 |

默认管理员（`panel.env` / 开发预填）：账号 `superadmin`，密码 `123456`（亦可在 `panel.env` 或 `.env.development` 中覆盖）。

---

## 启动（Docker Compose 开发栈，贴近生产）

需已安装 Docker。`dev:compose` 与 `dev:server` **不要同时运行**（实例卷 bind 会冲突）。

```bash
pnpm run dev:compose:prepare   # 可选：预拉 SteamCMD 镜像
pnpm run dev:compose             # 启动 panel + web 容器
```

停止：

```bash
pnpm run dev:compose:down
```

Compose 开发栈下面板端口见 `panel.env` 中 `PANEL_PORT`（示例默认 `8888`）。

端口说明（避免与安装文档混淆）：

- **源码开发（`pnpm run dev`）**：前端 `9527`（`VITE_DEV_WEB_PORT` 可覆盖），后端 `8888`（`SERVER_PORT` 默认值）。
- **Compose 开发栈（`pnpm run dev:compose`）**：容器内服务监听 `8888`，宿主机映射由 `PANEL_PORT` 控制（示例默认 `8888`）。
- **安装脚本（生产安装）**：默认对外端口为 `9527`（见 `INSTALL.md` 与 `scripts/install.linux.sh`）。

---

## 已知问题（Windows 开发环境）

### `pnpm run dev` 下后端日志中文乱码

pino 输出是 UTF-8，PowerShell 默认按系统区域（GBK）解码显示。任选其一修复：

- **仅当前终端**（每次开 shell 先执行）：

  ```powershell
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
  chcp 65001 > $null
  ```

- **所有新终端**：把上面两行写进 PowerShell 配置文件（`notepad $PROFILE`；文件不存在先 `New-Item -Force $PROFILE`）。
- **系统级一劳永逸**：设置 → 时间和语言 → 语言和区域 → 管理语言设置 → 更改系统区域设置 → 勾选 **“Beta: 使用 Unicode UTF-8 提供全球语言支持”** 后重启。副作用：极少数依赖 GBK 的旧程序可能反向乱码。

### `dev:compose` 启动时刷出大量 `WARN GET … ECONNRESET`

这些警告来自**容器内**的依赖安装，不是面板或启动脚本报错：panel 与 web 容器启动时都会执行 `scripts/dev-deps-guard.sh`，它在 `pnpm-lock.yaml` 指纹变化（或卷里还没有依赖）时跑一次 `pnpm install --frozen-lockfile`（见 `docker-compose.dev.yml`）。警告里的包全是 Linux 平台二进制（`@esbuild/linux-x64`、`@img/sharp-linux-x64`、`sass-embedded-linux-x64` 等），宿主机装的 `node_modules` 与之无关。

pnpm 会自己重试，所以这类警告通常只是变慢：期间 `[dev:compose] 等待 前端…` 会一直停在同一行——前端容器还在装依赖，Vite 尚未 ready。网络不稳时换一个 npm 源：

```bash
GSH_DEV_NPM_REGISTRY=https://registry.npmmirror.com pnpm run dev:compose
```

也可以写进 `panel.env`（`dev:compose` 用 `--env-file panel.env` 读取）：

```bash
GSH_DEV_NPM_REGISTRY=https://registry.npmmirror.com
```

该变量只影响容器内的依赖安装，不改变面板运行时行为；**不设置时仍用官方源 `https://registry.npmjs.org/`**，仓库不默认写入任何第三方镜像。想确认容器实际用的源：

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec panel pnpm config get registry
```

换源后若某个包取不到，`pnpm install --frozen-lockfile` 会失败并卡住启动，去掉该变量重跑即可。安装确实失败时用 `docker compose -f docker-compose.yml -f docker-compose.dev.yml logs panel web` 看 `[dev-deps]` 段落。

### `dev:compose` 下前端容器冷启动慢

Rancher Desktop（WSL2 后端）把 Windows 源码目录 bind mount 进容器，文件 IO 走跨 VM 通道（实测同目录遍历慢约 35 倍）。vite 冷启动 ready 需要 70~80 秒，期间浏览器打开 `localhost:9527` 无响应**属正常现象**，等日志出现 `VITE ready in ...` 再访问。日常改前端代码建议直接用 `pnpm run dev`（原生 NTFS，约 13 秒 ready，HMR 也更可靠）。

---

## 本地构建统一镜像

```bash
docker compose build
```

构建是多阶段的，会依次访问 Docker Hub（基础镜像）、Debian apt 源、npm registry 与 Steam CDN。国内网络下最后一项常常失败：

```text
curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to steamcdn-a.akamaihd.net:443
```

换用 Steam 的另一条官方 CDN 即可绕过（`docker-compose.yml` 已透传该参数，默认值不变）：

```bash
STEAMCMD_ARCHIVE_URL=https://media.steampowered.com/client/installer/steamcmd_linux.tar.gz \
  docker compose build
```

### 构建在下载 docker CLI 时中断

面板内「一键更新」需要镜像自带 docker CLI 与 compose 插件，这两个静态二进制合计约 150MB，国内链路实测只有 60~100 KB/s，慢到会撞上链路上的 HTTP/2 故障：

```text
curl: (92) HTTP/2 stream 1 was not closed cleanly: PROTOCOL_ERROR (err 1)
```

构建已内置两件事：统一按 HTTP/1.1 下载（这类错误来自中间设备处理 HTTP/2 有误，单流下载用不到多路复用），以及下载中断后**断点续传**——重跑构建时日志里的百分比会从上次的位置接着涨，不是从 0 重来。仍然下不动就把地址指向可达的镜像站或内网制品库（`docker-compose.yml` 用的是构建参数默认值，需在构建时显式传入）：

```bash
docker compose build \
  --build-arg DOCKER_CLI_URL=https://mirror.example.com/docker-29.8.0.tgz \
  --build-arg COMPOSE_PLUGIN_URL=https://mirror.example.com/docker-compose-linux-x86_64
```

### 构建时刷出 `WARN GET … ECONNRESET`

这是 `deps` 层在装依赖，不是代码问题。`@iconify/json`（约 60MB 的图标数据，`uno.config.ts` 的 `presetIcons` 必需）最容易被打断；构建已把 pnpm 的重试次数与超时调高，网络不稳时可再换个 npm 源（默认仍是官方源，仓库不写入任何第三方镜像）：

```bash
NPM_REGISTRY=https://registry.npmmirror.com docker compose build
```

构建失败不必从头再来：docker CLI 段位于 `runtime` 层最后一步，前面成功的层都在缓存里，重跑只重下这一小段。

> 改过 `docker-compose.yml` 后要跑一次 `pnpm run release:verify`：安装器内置了该文件的校验和，不同步就会让门禁失败（新值会打印在报错里）。

> 仅仅开发功能并不需要构建镜像：`pnpm run dev`（宿主机 Node）与 `pnpm run dev:compose`（容器开发栈）都跳过了这一步。发布用的镜像由 CI 构建，见 [RELEASE.md](RELEASE.md)。

---

## 测试与代码检查

提 PR 前先跑一条命令，它覆盖 CI 的大部分步骤（版本一致性、文档校验、类型检查、lint、UI 文案、单测与前端构建）：

```bash
pnpm run release:check
```

CI 另有两步不在 `release:check` 里，本地补跑即可完全对齐：

```bash
pnpm run build:server            # 服务端 esbuild 打包到 dist-server/
pnpm exec drizzle-kit generate --config server/drizzle.config.ts
git diff --exit-code -- server/drizzle      # 迁移漂移检查：无输出即通过
```

按需单独执行：

| 命令 | 作用 |
| --- | --- |
| `pnpm run release:verify` | 版本引用一致性（tag、compose、安装器默认 tag、CHANGELOG） |
| `pnpm run docs:check` | 文档链接、锚点、版本 tag 与索引校验 |
| `pnpm run lint` | vue-tsc 类型检查 |
| `pnpm run lint:ox` | oxlint 静态检查（`--deny-warnings`） |
| `pnpm run lint:copy` | UI 文案检查 |
| `pnpm test:unit` | 全部测试：后端 `server/src/**` 与前端 `src/**`、脚本用例（发布门禁跑的就是它） |
| `pnpm test:server` | 只跑后端 `server/src/**/*.test.ts`，是 `test:unit` 的真子集，用于改后端时快速迭代 |
| `pnpm run build` | 生产构建（仅前端 `dist/`；服务端 bundle 用 `pnpm run build:server`） |

**`test:unit` 与 `test:server` 的关系容易记反**：`scripts/run-unit-tests.mjs` 的第一个 glob 就是 `server/src/**/*.test.ts`，所以**后端的全部用例本来就在 `test:unit` 里**，`test:server` 是它的真子集（139 个文件 / 1231 个用例），只用来在改后端时少跑一会儿。也因此 `release:check` 与 CI 的 `Quality Gate` 跑 `test:unit` 一条就等于跑全量（当前共 164 个文件 / 1458 个用例），后端并没有落在门禁之外。

**`pnpm run lint` 走增量构建（`vue-tsc -b`），会吃掉构建缓存。** 改动涉及类型边界（菜单数据、跨目录 import、`RouteMetaRaw` 这类 `string | (() => string)` 的联合类型）后，务必强制全量重跑一次：

```bash
pnpm exec vue-tsc -b --force     # 或先删掉 node_modules/.tmp 下的 *.tsbuildinfo
```

否则会出现「本地 exit 0、CI 的 Type check 步骤却报错」的假绿——v0.8.2 的第一次推送就是这样变红的：`item.meta.title` 可能是 `undefined` 或函数，本地增量检查没重新验那个文件，推上去才暴露。

`pnpm` 不可用（或不想让它访问系统级 store）时，可以用同一套检查的替代入口：`node scripts/run-local-checks.mjs [步骤名...]`。它用仓库内的 Node 直接调起 `vue-tsc`、`vite`、各检查脚本与测试运行器，日志写到 `logs/verify/`，终端只打印每步的通过情况；不带参数即跑全部。改动脚本与门禁命令时应保持两者一致。

测试不需要 Docker：本机没有 Docker 或没有本地 SteamCMD 镜像时，`container-lifecycle` 里依赖真实容器运行时的那一条会**跳过并说明原因**（结果里的 `skipped 1`），其余用例照常执行。早先它会在「Docker 可用但镜像不在本地」时真的去拉镜像，镜像拉不动的网络下整轮测试会长时间无输出地挂住。

### 迁移导出工具

`scripts/export-cluster-archive.ts` 把一台机器上的饥荒集群存档整理成可直接导入的包（`tar.gz` + `.sha256` + 迁移报告）：

```bash
pnpm exec tsx scripts/export-cluster-archive.ts --source <源目录> --out <输出目录>
```

`--source` 可以指向实例安装目录、`klei-storage`、其上层目录或玩家客户端的存档目录；工具会自行找出含 `cluster.ini` 的集群。它只读源目录，报告里不打印集群令牌与房间密码，可用于迁移服务交付与故障复现。

面板里的「实例详情 → 迁移到其他机器」做的是同一件事（报告 + 直接下载包），用于从**本面板管理的实例**导出。两者共用 `server/src/infra/game-adapter/dst/cluster-migration.ts` 的识别、体检与报告实现——**改动这个模块时两个入口一起受影响**，改完请同时跑脚本与 `migration-export-routes.test.ts`。

### 面板后端环境变量（`server/.env.*`）

| 变量 | 用途 |
|------|------|
| `CORS_ORIGIN` | 跨域：`true`/`false` 或逗号分隔白名单；开发默认可跨域，生产默认同源 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 初始化管理员；未设密码且管理员尚不存在时自动生成强随机密码并写入 `data/admin-credentials.txt`（0600，不写日志）；管理员已存在时不覆盖，除非 `GSH_SYNC_ADMIN_PASSWORD_FROM_ENV=1` |
| `FORCE_PASSWORD_CHANGE` | `1` 时首次登录进入强制改密页 |
| `GSH_TRUST_PROXY` | 部署在 Nginx / Caddy 等反向代理后面时填可信代理地址；不设则按 TCP 对端取来源 IP，登录限流与日志记到的都是代理地址 |
| `GSH_INSTALL_PATH_POLICY` | 实例安装路径策略；默认要求位于 `GSH_INSTANCES_ROOT` 之下，设 `any` 允许任意绝对路径（自行承担隔离风险） |
| `GSH_SAVE_IMPORT_ROOT` | 存档导入上传包的临时根目录，默认系统临时目录 |

### Steam / Mod 相关环境变量（开发排查）

面板访问 Steam 的请求（Mod 市场列表、评分、版本、工坊页面）与 SteamCMD 的下载是两条独立链路，
代理要分别配置：`GSH_STEAM_*_PROXY` 管面板自己，`GSH_STEAMCMD_*` 管 SteamCMD 子容器。

| 变量 | 用途 |
|------|------|
| `GSH_STEAM_HTTPS_PROXY` / `GSH_STEAM_HTTP_PROXY` | 面板访问 Steam 的代理；留空时回退读进程的 `HTTPS_PROXY` / `HTTP_PROXY`。Docker 部署指向宿主机时写 `host.docker.internal` |
| `GSH_STEAM_NO_PROXY` | 不走代理的主机后缀（逗号分隔）；环回地址与 `host.docker.internal` 始终绕过 |
| `GSH_STEAM_WEBAPI_BASE_URL` | `api.steampowered.com` 的反代基址，**带路径前缀时结尾必须加 `/`** |
| `GSH_STEAM_COMMUNITY_BASE_URL` | `steamcommunity.com` 的反代基址，供 HTML 源使用 |
| `GSH_STEAM_WEBAPI_KEY` | Mod 市场走 Steam 官方 Web API（推荐，比 HTML 抓取稳定） |
| `GSH_STEAM_RELAY_URL` / `GSH_STEAM_RELAY_TOKEN` | 无法直连 Steam 时的中继 |
| `GSH_STEAMCMD_DOWNLOAD_REGION` | SteamCMD 下载区域（如 `cn`），影响实例安装与 Mod 订阅下载 |
| `GSH_STEAM_WORKSHOP_FETCH_TIMEOUT_MS` | 工坊页面（HTML 源）单次超时，默认 12s |
| `GSH_STEAM_WORKSHOP_OFFICIAL_TIMEOUT_MS` / `_RELAY_TIMEOUT_MS` | 官方 API 与中继的单次超时，默认各 5s |
| `GSH_STEAM_WORKSHOP_FAST_FAIL_TIMEOUT_MS` | 一个源失败后，其余源改用的短超时且只试一次，默认 3.5s |
| `GSH_STEAM_WORKSHOP_TOTAL_BUDGET_MS` | 单次列表拉取总预算，用满即退回缓存/离线数据，默认 10s |
| `GSH_STEAM_WORKSHOP_OFFLINE_TTL_MS` | 上游不可达时列表可退回的缓存窗口，默认 7 天（界面标注「离线数据」） |
| `GSH_STEAM_WORKSHOP_STALE_TTL_MS` | 过期但立即返回并后台刷新的窗口，默认 30 分钟 |
| `GSH_STEAM_WORKSHOP_CACHE_TTL_MS` | fresh 缓存窗口，默认 2 分钟 |
| `GSH_STEAM_WORKSHOP_METADATA_CACHE_TTL_MS` | Mod 名称/缩略图/版本时间的内存缓存时长，默认 10 分钟 |
| `GSH_STEAM_WORKSHOP_METADATA_BATCH_SIZE` | 单次批量查询工坊元数据的 ID 数，默认 100（超出分批串行） |
| `GSH_MOD_DOWNLOAD_COALESCE_LIMIT` | 单次 SteamCMD 调用顺带补齐的缺失 Mod 上限，默认 50 |
| `GSH_STEAM_WORKSHOP_WARM_CACHE=0` | 关闭面板启动时 Mod 市场列表后台预热 |

排查「列表加载不出来」时先看 **系统设置 → 环境自检 → Mod 市场上游**：它会给出实际生效的源顺序、
代理是否生效（只显示来源变量与主机，不回显凭据）、哪些源在熔断、以及最近一次成功的时间。

完整示例见 [`panel.env.example`](../panel.env.example)。

---

## 从源码构建生产镜像

适用于自托管构建或 CI 调试。

### 构建前端

```bash
cp .env.production.example .env.production
cp server/.env.production.example server/.env.production
pnpm install
pnpm run build          # 输出 dist/
```

### 构建 Docker 镜像

```bash
# 统一镜像（面板 + DST 运行库 + SteamCMD）
# 构建上下文必须是仓库根目录：Dockerfile 内要 COPY package.json、packages/、patches/ 与源码
docker build -f docker/unified/Dockerfile -t ghcr.io/pmat77/game-server-hub:local .
```

### 本地 Compose 启动（非安装脚本路径）

```bash
cp panel.env.example panel.env
# 编辑 panel.env，将 PANEL_IMAGE 改为本地 tag
docker compose --env-file panel.env -f docker-compose.yml -f docker-compose.bind.yml up -d
```

官方镜像由 GitHub Actions 在推送 `v*` tag 时发布至 GHCR（推送 `main` 只运行质量门禁，不发布镜像）：

- `ghcr.io/pmat77/game-server-hub:<tag>`（统一镜像，v0.2.0 起三合一）

---

## 仓库结构

```text
game-server-hub/
├── docs/                   # 公开文档（本目录）
├── src/                    # Vue 3 前端
├── server/                 # Fastify 后端、Drizzle、SQLite 迁移
├── shared/                 # 前后端共享契约与错误码
├── scripts/                # 安装脚本、开发工具
├── packages/               # 工作区 UI 组件
├── docker/                 # DST 运行镜像等
├── docker-compose.yml      # 生产编排
├── docker-compose.dev.yml  # 开发 overlay
├── panel.env.example       # Compose / 安装脚本环境变量模板
├── .env.*.example          # 前端 Vite 环境变量模板
└── server/.env.*.example   # 后端环境变量模板
```

### 模块与目录导航

仓库里已有若干模块级 README，改代码前先读对应的一份：

| 路径 | 内容 | 说明文档 |
| --- | --- | --- |
| `src/views/` | 前端页面：`console/monitor`（监控台）、`node/instance`（实例列表 / 详情 / 控制台）、`games/dst`（房间 / 世界 / Mod）、`ops`（备份 / 计划任务）、`system`（系统设置，含面板设置 / 通知渠道 / 操作记录三个页内 tab；单页模块靠图标栏那一项进入，没有二级导航，单栏布局下由 `src/store/modules/app/menu-flatten.ts` 平铺成可见项——不要为了"让它可见"去改页面的 `meta.menu`）、`system/plugins.vue` 与 `system/commercial.vue`（插件与商业支持，各自是一级菜单） | — |
| `src/api/` | 前端请求层与接口封装 | — |
| `shared/contracts/` | 前后端共享契约与校验规则 | [shared/README.md](../shared/README.md) |
| `shared/constants/` | 共享常量与错误码 | 同上 |
| `server/src/modules/` | 后端业务模块（auth、instance、cluster、shard、console、mod、backup、schedule、notify、node、system） | [server/src/modules/README.md](../server/src/modules/README.md) |
| `server/src/infra/` | 容器 / 运行时 / 游戏适配器 / 备份等外部系统适配层 | [server/src/infra/README.md](../server/src/infra/README.md) |
| `server/src/shared/` | config、db（schema 与连接）、dst、http 等后端共享能力 | [server/src/shared/README.md](../server/src/shared/README.md) |
| `server/drizzle/` | Drizzle 迁移文件 | [DATABASE.md](DATABASE.md) |
| `packages/` | 工作区内的 UI 组件与框架包（含各组件 README） | — |

后端整体目录与分层约定见 [server/src/README.md](../server/src/README.md)。

Standalone 副本与上游 fantastic-admin 母仓的同步说明见根目录 [MIGRATION.md](../MIGRATION.md)。

---

## 参与贡献

详见 **[CONTRIBUTING.md](../CONTRIBUTING.md)**（PR 流程、CHANGELOG、行为准则）。

CI 与本地检查保持一致：

```bash
pnpm run lint
pnpm test:unit
```

发布与版本号约定见 **[RELEASE.md](RELEASE.md)**。

**请勿提交**：`panel.env`、本地 SQLite、`docs_local/`、`.env` 凭据或任何密钥文件。
