# 安装指南

按「部署模式 × 网络位置」分成四条路线。选好模式后直接跳到对应路线，四条路线的面板功能完全一致。

| 模式 | 网络 | 路线 | 这条路线做什么 |
| --- | --- | --- | --- |
| Docker | 海外，或可直达 GitHub 与 GHCR | [路线 A](#路线-a海外机器一个命令装完) | 一条命令装完，安装器自装 Docker 并拉取统一镜像 |
| Docker | 国内 | [路线 B](#路线-b国内服务器debian-12-离线镜像包全程) | 先导入离线镜像包，再跑同一条命令（GHCR 层域名国内不可达） |
| Native systemd | 海外，或可直达 GitHub | [路线 C](#路线-cnative-海外机器一个命令装完) | 一条命令装完，安装器下载 Native Release 与 SteamCMD 并注册服务 |
| Native systemd | 国内 | [路线 D](#路线-dnative-国内服务器加速代理与国内档位) | 用 jsDelivr 或加速代理取脚本与 Release 包，`--network cn` 走国内软件源 |

Native 路线不安装、也不调用 Docker，与 Docker 路线不互相迁移，只支持 x86_64。

**环境要求**：Debian 12 或 Ubuntu 22.04 / 24.04（只支持 apt 系列）；内存最低约 4 GiB，洞穴与中等 Mod 建议 6 GiB+（档位与预设见 [MEMORY.md](MEMORY.md)，安装器默认自动选档）；根分区至少 4 GiB 空闲，另外要为离线镜像包（约 227 MB）与导入后的本地镜像（约 560 MB，导入完成后包可删除）、游戏本体（数 GB）与存档备份预留空间；root 或 sudo。

> **4 GiB 机器请先执行 `sudo gsh setup-swap`**：分片加载整套 Mod 时内存会短时冲高，物理内存不足会让内核在加载途中直接杀掉分片，表现为「实例显示运行中但大厅搜不到」。启动前的内存守卫按「分片数 ×（512 MiB + 每个启用中的 Mod 32 MiB）」估算，并把可用 swap 计入可回收余量；不够时会直接拒绝启动并给出建议，而不是启动到一半失败。详见 [MEMORY.md](MEMORY.md)。

> Windows 不受支持；本地开发见 [DEVELOPMENT.md](DEVELOPMENT.md)。

### 两种模式怎么选

| 模式 | 适合谁 | 面板运行方式 | 游戏进程 | 进程管理 |
| --- | --- | --- | --- | --- |
| Docker | 小型游戏社区、游戏托管商 | Docker Compose | Docker 容器 | Docker Engine |
| Native systemd | 个人服主 | 系统级 systemd 服务 | `gsh` 用户的 systemd 服务 | systemd（不使用 tmux / screen / PM2） |

两种模式的面板功能一致，都属于首期正式支持；Native 完全不依赖 Docker，但作为首期能力，仍建议先在非关键服务器验证。**选型与差异以本节为准**，其他文档只做引用。

---

## 路线 A：海外机器（一个命令装完）

**模式：Docker。** 安装器自行安装 Docker 与 Compose 插件，再拉取统一镜像启动面板栈。

```bash
curl -fsSL "https://raw.githubusercontent.com/PMAT77/game-serve-hub/v0.10.0/scripts/install.linux.sh" \
  | sudo bash -s -- --mode docker
```

> 管道方式锁定的是当次下载内容，不会误用磁盘上的旧脚本。若想先确认拿到的是目标版本：
> `curl -fsSL "<上面的 URL>" | sed -n '9p'`，第 9 行应输出 `...:-v0.10.0}}` —— 这一行的默认 tag 决定安装器要装的镜像版本。

```bash
# 初始密码：安装器默认不打印，从 panel.env 读取（管理员名 superadmin，首登强制改密）
sudo sed -n 's/^ADMIN_PASSWORD=//p' /opt/game-server-hub/panel.env
# 若登录提示密码错误（容器没收到该变量）：docker exec game-server-hub-panel cat /app/data/admin-credentials.txt

# 健康检查：runtime.status 应为 running；或 gsh doctor 全面体检
curl -fsS http://127.0.0.1:9527/health
gsh doctor
```

浏览器访问 `http://<服务器IP>:9527`（默认端口，安装器结尾输出实际地址；安全组放行 TCP）。碰到任何报错 → [问题清单](#问题清单按报错关键词对照)。

---

## 路线 B：国内服务器（Debian 12 离线镜像包全程）

**模式：Docker。** 四个阶段按顺序执行：先装 Docker 与 Compose 插件，再导入离线镜像包，最后重跑安装器完成部署。Native 模式的国内安装见[路线 D](#路线-dnative-国内服务器加速代理与国内档位)。

> 安装器要从 GHCR 拉统一镜像，其镜像层域名国内基本不可达（症状：能见镜像清单、层下载 `TLS handshake timeout`，重试无用）。正确顺序：先导入离线镜像包，再跑安装器 —— 检测到本地镜像即跳过拉取。

### 阶段一：Docker 引擎与 Compose 插件

```bash
# 下载安装器（gh-proxy 加速；不可用时换 https://ghfast.top/ 前缀）
# 用 curl -o 指定带版本号的文件名：wget 遇到同名文件不会覆盖而是另存为 .1，容易继续跑上一次的旧脚本
tag=v0.10.0
curl -fL --retry 3 -o "install-${tag}.sh" \
  "https://gh-proxy.com/https://raw.githubusercontent.com/PMAT77/game-serve-hub/${tag}/scripts/install.linux.sh"

# 自证版本：必须输出 ...:-v0.10.0}}，对不上就停下排查（这行的默认 tag 决定安装器要装的镜像版本）
sed -n '9p' "install-${tag}.sh"

# 第一次运行：自动装好 Docker 与 Compose 插件。
# 结尾报「Cannot reach GHCR / Image pull failed」属正常（镜像包未导入）→ 进入阶段二；阶段三原样重跑本命令
sudo GSH_PANEL_ENV_PRESET=small GSH_RELEASE_TAG="${tag}" bash "install-${tag}.sh" --mode docker --network cn

# 验证插件（期望输出：Docker Compose version v2.39.2）
docker compose version

# 仅当安装器提示自动补装失败时，手动装好插件，再重新执行上面的安装命令：
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -fL --retry 3 "https://gh-proxy.com/https://github.com/docker/compose/releases/download/v2.39.2/docker-compose-linux-x86_64" -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
```

> 兜底用的是二进制而不是 `apt install docker-compose`：源里那个是 1.x 旧版（命令叫 `docker-compose`），没有安装器所需的 v2 `docker compose` 子命令，装了也过不了安装器检查。

### 阶段二：导入离线镜像包

```bash
tag=v0.10.0
base="https://gh-proxy.com/https://github.com/PMAT77/game-serve-hub/releases/download/${tag}"

# 下载镜像包与校验文件（约 227 MB，以 Release 页面显示为准；差得离谱说明下错了版本）
curl -fL --retry 3 -o "game-server-hub-${tag}-docker-image.tar.gz"        "${base}/game-server-hub-${tag}-docker-image.tar.gz"
curl -fL --retry 3 -o "game-server-hub-${tag}-docker-image.tar.gz.sha256" "${base}/game-server-hub-${tag}-docker-image.tar.gz.sha256"

# 校验完整性（期望输出末尾 OK）。.sha256 记录原始文件名，改过名需先改回
sha256sum -c "game-server-hub-${tag}-docker-image.tar.gz.sha256"

# 核对包内镜像 tag 与目标版本一致（RepoTags 应为 ghcr.io/pmat77/game-server-hub:v0.10.0）
tar -xOzf "game-server-hub-${tag}-docker-image.tar.gz" manifest.json | head -c 200; echo

# 导入镜像（v0.10.0 下载包约 227 MB，导入后本地镜像约 560 MB，预留 4 GB 磁盘；-i 带进度条，不要用 gunzip 管道；
# 输出 Loaded image: ghcr.io/pmat77/game-server-hub:v0.10.0 即成功）
docker load -i "game-server-hub-${tag}-docker-image.tar.gz"

# 断言本地 tag 与目标版本一致：安装器只认完整引用字符串，tag 对不上即使内容相同也会重新拉取
docker images --format '{{.Repository}}:{{.Tag}}' | grep "^ghcr.io/pmat77/game-server-hub:${tag}$"
```

### 阶段三：重跑安装器完成部署

原样重跑[阶段一](#阶段一docker-引擎与-compose-插件)那条安装命令 —— 这次镜像已在本地，日志出现 `Runtime image already present locally, skipping pull` 后一路走完，结尾输出面板地址。

> 没出现 `skipping pull` 却又开始下载，就是脚本默认 tag 与本地镜像 tag 不一致：`sed -n '9p' "install-${tag}.sh"` 与 `docker images | grep game-server-hub` 两边都必须等于 `${tag}`；也可以显式覆盖重跑 `sudo GSH_RELEASE_TAG="${tag}" bash "install-${tag}.sh" --mode docker --network cn`。

```bash
docker ps   # game-server-hub-panel 应为 Up；起不来或反复重启 → 问题清单
```

### 阶段四：访问面板

安装器结尾会打印一个边框摘要块。`面板地址`按「`PANEL_PUBLIC_URL`/`PANEL_HOST` 显式指定 → 网卡公网地址 → 云平台元数据 → 出站 IP 探测 → 本机地址」解析，并在括号里标注来源；NAT 机器上探测不到公网地址时，那里显示的是本机内网地址并注明「仅同一局域网可访问」，同时给出公网访问该做的事。标为「出站 IP 探测」的地址是出口地址，只在该公网 IP 已映射到本机端口时可用（运营商 CGNAT 场景见 [DST 教程 5.4](DST_TUTORIAL.md#54-宿主服务器在-nat-转发后面)）。初始密码的读取命令也写在同一块里。初始密码获取见[登录与安全](#登录与安全)。

> 自动探测会请求云平台元数据端点与出站回显服务，总耗时上限由 `GSH_PANEL_PUBLIC_IP_BUDGET_SECONDS` 控制（默认 3 秒）；不想要这些请求就设 `GSH_PANEL_AUTO_PUBLIC_IP=0`，或直接用 `PANEL_PUBLIC_URL=https://your.domain` 指定，后者同时跳过探测。

浏览器 `http://<服务器公网IP>:<PANEL_PORT>` 登录，首登强制改密。若之后「检查更新」超时，panel.env 追加 `GSH_GITHUB_API_BASE` 指向兼容反代后 `docker compose up -d panel` 重建即可。

模组管理里的 Mod 市场列表走的是 Steam 创意工坊接口（`https://api.steampowered.com` 与 `https://steamcommunity.com`），在连不上 Steam 的网络里会一直取不到列表。面板的这类请求与 SteamCMD 用的是**两套代理配置**：前者由面板进程自己发起，后者是 SteamCMD 子容器的环境变量。给面板配代理（推荐）：

```bash
# panel.env
GSH_STEAM_HTTPS_PROXY=http://host.docker.internal:7890
```

容器里的 `127.0.0.1` 指的是容器自己，代理跑在宿主机上时必须写 `host.docker.internal`（compose 已配好 `extra_hosts` 映射）；Native 部署直接写 `127.0.0.1`。改完 `docker compose up -d panel` 重建面板生效。

也可以把接口反代到自己的域名：`GSH_STEAM_WEBAPI_BASE_URL=https://your-proxy.example/steam/`（**带路径前缀时结尾必须加 `/`**），以及 `GSH_STEAM_COMMUNITY_BASE_URL` 用于创意工坊页面。`GSH_STEAM_WEBAPI_KEY` 可让列表改走官方 Web API（稳定性高于页面抓取）。

不配任何代理时面板也不会一片空白：列表会退回最近一次成功拉取的内容（默认 7 天内，`GSH_STEAM_WORKSHOP_OFFLINE_TTL_MS` 可调），界面上标注「离线数据 · 最后更新于 X」；单个请求最多等 10 秒就会返回结果。要确认当前实际生效的链路与代理状态，看 **系统设置 → 环境自检** 里的「Mod 市场上游」一项。

---

## 路线 C：Native 海外机器（一个命令装完）

面板由系统级 `game-server-hub.service` 管理，游戏分片由 `gsh` 用户的 systemd 服务管理（面板自身的日志用 `journalctl -u game-server-hub.service` 查看，分片日志直接写入实例目录下的控制台日志文件，可在面板里查看与下载）。不安装 Docker，也不使用 tmux、screen 与 PM2。

```bash
curl -fsSL "https://raw.githubusercontent.com/PMAT77/game-serve-hub/v0.10.0/scripts/install.linux.sh" \
  | sudo bash -s -- --mode native
```

> 管道安装的默认模式是 Docker，Native 必须显式写 `--mode native`。脚本默认 tag 决定安装版本，确认方式与[路线 A](#路线-a海外机器一个命令装完)相同。

安装器按顺序做这些事：装基础依赖与 32 位运行库（`libcurl4:i386` 等，DST 与 SteamCMD 需要）→ 创建 `gsh` 系统用户并开启 linger → 下载校验 Native Release（`game-server-hub-native-v0.10.0-linux-x64.tar.gz`，自带 Node 运行时）→ 解压到 `/opt/game-server-hub/releases/v0.10.0` 并原子切换 `current` 符号链接 → 装 SteamCMD → 写 `panel.env` → 启动面板并等待健康检查。

```bash
# 初始密码：与 Docker 模式同一个文件（管理员名 superadmin，首登强制改密）
sudo sed -n 's/^ADMIN_PASSWORD=//p' /opt/game-server-hub/panel.env

# 健康检查：服务应为 active，runtime.status 应为 running
systemctl is-active game-server-hub.service
curl -fsS http://127.0.0.1:9527/health
gsh doctor
```

浏览器访问 `http://<服务器IP>:9527`（安装器结尾输出实际地址）。面板日志用 `sudo journalctl -u game-server-hub.service -f` 跟踪。端口、安全组与防火墙要求与 Docker 模式相同，见[端口与防火墙](#端口与防火墙)。

---

## 路线 D：Native 国内服务器（加速代理与国内档位）

Native 模式不拉取容器镜像，境外依赖只有两处：GitHub Raw（安装器组件）与 GitHub Release（Native 包）。安装器自带加速代理池，顺序为 `gh-proxy.com`、`ghfast.top`、`ghproxy.com`，全部失败才走直连，因此国内一般可以直接安装。先把脚本下载到本地更稳妥。

```bash
tag=v0.10.0
# 下载安装器（gh-proxy 加速；不可用时换 https://ghfast.top/ 前缀）
curl -fL --retry 3 -o "install-${tag}.sh" \
  "https://gh-proxy.com/https://raw.githubusercontent.com/PMAT77/game-serve-hub/${tag}/scripts/install.linux.sh"

# 自证版本：必须输出 ...:-v0.10.0}}，对不上就停下排查
sed -n '9p' "install-${tag}.sh"

# 安装：--network cn 把 apt 源临时切到国内镜像，SteamCMD 走 cn 区域并重试 8 次
sudo env GSH_RELEASE_TAG="${tag}" bash "install-${tag}.sh" --mode native --network cn
```

- 安装器从 jsDelivr 与加速代理取 `scripts/gsh.sh`、`scripts/gsh-native-update.sh`，并从加速代理或直连取 Native 包与同名 `.sha256`。
- 想固定单一代理，加 `GSH_GITHUB_PROXY=https://gh-proxy.com/`；想自己列镜像源，用 `GSH_NATIVE_RELEASE_MIRRORS=源1,源2`，每项是目录前缀，安装器会接上文件名。
- apt 国内镜像连不上时，安装器自动还原系统默认源后重试，不需要手工改回。

加速代理全部不可用时，改为手动下载 Native 包再安装。包旁必须放同名 `.sha256`，也可以用 `GSH_NATIVE_RELEASE_SHA256` 直接给出摘要。

```bash
tag=v0.10.0
base="https://gh-proxy.com/https://github.com/PMAT77/game-serve-hub/releases/download/${tag}"
curl -fL --retry 3 -o "game-server-hub-native-${tag}-linux-x64.tar.gz"        "${base}/game-server-hub-native-${tag}-linux-x64.tar.gz"
curl -fL --retry 3 -o "game-server-hub-native-${tag}-linux-x64.tar.gz.sha256" "${base}/game-server-hub-native-${tag}-linux-x64.tar.gz.sha256"
sha256sum -c "game-server-hub-native-${tag}-linux-x64.tar.gz.sha256"

sudo env GSH_RELEASE_TAG="${tag}" \
  GSH_NATIVE_RELEASE_ARCHIVE="$(pwd)/game-server-hub-native-${tag}-linux-x64.tar.gz" \
  bash "install-${tag}.sh" --mode native --network cn
```

SteamCMD 从 `steamcdn-a.akamaihd.net` 下载，不通时用 `GSH_NATIVE_STEAMCMD_URL` 指向镜像。面板内的「下载更新」在 Native 下复用同一套代理池，网络受限时在 `panel.env` 写 `GSH_GITHUB_PROXY` 后执行 `gsh restart`。安装后的验证命令与[路线 C](#路线-cnative-海外机器一个命令装完)相同。

---

## 装好之后

### 配置入口

面板的环境变量集中在 `/opt/game-server-hub/panel.env`，全部键名与注释见仓库根目录的 [panel.env.example](../panel.env.example)；安装器会按检测到的内存档位自动追加预设片段（见 [MEMORY.md](MEMORY.md)）。改完执行 `gsh restart` 生效。

### 端口与防火墙

| 用途 | 协议 | 默认端口 |
| --- | --- | --- |
| 面板 | TCP | `9527` |
| 主世界 · 游戏端口 | UDP | `10999` |
| 主世界 · Steam 认证端口 | UDP | `8766` |
| 主世界 · Steam 主服端口 | UDP | `12346` |
| 洞穴 · 游戏端口 | UDP | `11000` |
| 洞穴 · Steam 认证端口 | UDP | `8768` |
| 洞穴 · Steam 主服端口 | UDP | `12348` |

开启洞穴后，洞穴的 3 个 UDP 端口同样必须放行，否则玩家一进洞穴就会崩线。

安装器默认不改防火墙；需要时加 `--open-panel-port` / `--open-dst-ports`（后者放行主世界与洞穴共 6 个 UDP 端口），云服务器安全组单独放行。宿主服务器本身在 NAT 转发（云平台端口映射 / 路由器映射）后面时，还要在那边按**与内部相同的端口**逐条添加转发规则，见 [DST 开服教程](DST_TUTORIAL.md) 5.4 节。

面板端口也可以在面板里改：**系统设置 → 面板端口**保存后会把新端口写进 `/opt/game-server-hub/panel.env` 的 `PANEL_PORT`，执行 `gsh restart` 后生效——**请先在云安全组与本机防火墙放行新端口**，否则重启后面板就连不上了（保存时界面也会提醒）。无法自动写入时会给出可直接复制的命令。

### 常用命令（宿主机 `gsh` CLI）

安装器会在宿主机装好 `gsh`。它只管理面板栈，不碰游戏实例——实例的启停与安装始终在面板里操作。

| 命令 | 作用 |
| --- | --- |
| `gsh status` | 面板栈状态与健康检查 |
| `gsh logs` | 跟随面板日志（从最近 200 行起） |
| `gsh restart` / `gsh stop` / `gsh start` | 重启 / 停止 / 启动面板栈，不影响游戏容器 |
| `gsh update` | 拉取统一镜像并重建面板栈（只对 Docker 模式有效；Native 模式请用面板内更新或重跑安装脚本） |
| `gsh doctor` | 体检：健康、运行时、资源、脱敏配置、日志与版本 |
| `gsh setup-swap` | 小内存机器创建 2 GB swap，并设置 OOM 相关内核参数 |

不带参数运行 `gsh` 会进入交互菜单，`gsh --help` 查看完整用法。面板栈配置文件路径可用 `GSH_PANEL_ENV_FILE` 覆盖（默认 `/opt/game-server-hub/panel.env`）。

```bash
# 健康检查（runtime.status 应为 running）
curl -fsS http://127.0.0.1:9527/health
```

> 直接操作 Docker 的等价命令（需在 `/opt/game-server-hub` 目录下执行）：
> `sudo docker compose --env-file panel.env -f docker-compose.yml -f docker-compose.bind.yml ps`

### 镜像运行层说明

统一镜像的运行层只包含面板产物（前端 dist + 服务端 bundle + 数据库迁移），**不带 node_modules**：服务端依赖已在构建期全部打进 bundle。镜像基于官方 `node:22-bookworm-slim`（`node`、`npm` 自带，`pnpm` 由 corepack 提供），但容器内没有依赖与构建工具链，因此不要 `docker exec` 进容器执行包管理或构建命令。排障走 `docker logs`、面板 API 与宿主机 `gsh` CLI。

### 登录与安全

管理员名默认 `superadmin`，初始密码默认不打印，从 panel.env 读取：

```bash
sudo sed -n 's/^ADMIN_PASSWORD=//p' /opt/game-server-hub/panel.env
```

面板首次启动时按 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 创建管理员：Docker 模式由 `docker-compose.yml` 的 `environment` 注入容器，Native 模式由 systemd `EnvironmentFile` 注入进程 —— 两条路径读的都是同一个 `panel.env`，改值后重启面板即生效。

未设置 `ADMIN_PASSWORD`、或容器没收到该变量（旧版 compose、手动 `docker run` 漏了 `-e`）时，面板会随机生成密码，并把凭据写到数据库同目录：

```bash
# Docker 模式：凭据在容器内的数据目录
docker exec game-server-hub-panel cat /app/data/admin-credentials.txt
# Native 模式：凭据在数据目录，文件权限 0600，属 gsh 用户
sudo cat /var/lib/game-server-hub/admin-credentials.txt
```

该文件只在「生成的密码确实写入了数据库」时才会生成（或重写）：管理员已存在且未开启 `GSH_SYNC_ADMIN_PASSWORD_FROM_ENV` 时不会生成新密码，避免给出一个登录不上的值。

`FORCE_PASSWORD_CHANGE=1`（安装器默认写入）时首次登录会拦截至 `/force-change-password`，改密成功后凭据文件自动删除。

也可安装时显式指定：`sudo env ADMIN_USERNAME=admin ADMIN_PASSWORD='强密码' bash install.linux.sh --mode docker`。不要把 `panel.env` 或授权文件发到公开 Issue。

#### 游客登录（只读预览）

想让别人（例如 GitHub 上的访客）只看不给改，在 `panel.env` 加上下面两行并重启面板：

```bash
GSH_GUEST_LOGIN_ENABLED=1
# 游客账号名，默认 guest；不允许与 ADMIN_USERNAME 相同
GSH_GUEST_LOGIN_ACCOUNT=guest
```

登录页的登录按钮下方会出现「以 guest 身份预览」按钮，点一下即以只读身份进入。面板启动时自动预置这个只读账号，**它的口令是随机值，不落盘、不返回、不写进日志**——所以面板不提供也不需要任何游客口令，也就没有"把口令交给前端自动填充"这回事。用普通登录页输入 `guest` 是登不上的，这是刻意的。

三条必须同时满足的前提（以及为什么默认关闭）：

1. **只有 Native 模式会生效**。Docker 模式下面板挂着 `docker.sock`，一次有效登录等价于宿主机 root，把只读账号交给匿名访客等于把宿主机交出去 —— 因此 Docker 部署即使设成 `1` 也不会开放，启动日志里会打印原因；
2. **必须在反向代理层再加一层访问控制**（IP 白名单、Basic Auth 或 VPN），别把面板直接裸在公网；
3. **只读不等于看不到东西**：实例目录与文本文件内容、房间与世界配置、玩家名单（含管理员名单）、在线玩家、备份列表与游戏控制台日志都对访客可见。相应地，游客看不到成员与角色管理、操作记录、插件页，也没有控制台读权限（`world-state` 会向游戏下发指令），`/app/system/info` 也不再返回主机名、内核版本与 CPU 型号。

另建议把 `ADMIN_USERNAME` 从默认的 `superadmin` 改掉：公开预览站会吸引对默认管理员名的撞库。完整说明见 [SECURITY.md](../SECURITY.md) 的「游客角色（只读预览）的硬前提」。

### 升级

升级入口都在「系统设置 → 面板与游戏版本」。两种部署方式都能在面板里更新，但机制不同：

| 部署方式 | 面板内更新 | 更新内容 |
| --- | --- | --- |
| Docker | 「下载更新」→「立即安装」（重建面板容器） | 统一镜像 |
| Native（systemd） | 「下载更新」→「立即安装」（后台安装并重启面板） | Native Release 包 |

#### Docker 模式

「系统设置 → 面板与游戏版本」分两步走。先点「下载更新」把新镜像拉到本地：版本行下方会实时显示 `已下载 512 MB / 1.2 GB`，本地已有镜像时直接就绪。下载完成后按钮变为「立即安装」，点击后会写入 panel.env 并重建面板容器。

下载段默认优先下载 Release 离线镜像包（`game-server-hub-<tag>-docker-image.tar.gz`，经 GitHub 加速代理 + 同名 `.sha256` 校验后 `docker load` 导入），失败才回退 GHCR 拉取；可用 `GSH_GITHUB_PROXY` 更换加速代理。

下载源在「系统设置 → 面板与游戏版本 → 更新下载源」里切换（自动 / 仅离线镜像包 / 仅镜像仓库），也可用 `GSH_PANEL_UPDATE_SOURCE=offline|pull` 设默认值，面板里的选择优先。下载中断会保留分片、下次从断点续传，开始前也会检查目标目录的剩余空间。

下载不中断面板，可以提前挑个空闲时段下载、之后再安装。也可以按[阶段二](#阶段二导入离线镜像包)先手动 `docker load`，回到本页点「下载更新」会跳过下载直接进入「立即安装」。按钮置灰时用面板给出的 `sudo gsh update`。

> **安装完成后请刷新浏览器页面**（Ctrl/Cmd+Shift+R）。面板已经在跑的标签页里仍是升级前的界面脚本，不刷新会继续看到旧界面；管理端也会在检测到版本不一致时提示「页面还是旧版本」，点提示里的「刷新页面」即可。

重建动作由一个临时的 updater 容器完成，它需要镜像里有 `docker` CLI 与 compose 插件。v0.3.10 起统一镜像自带这两样，面板会优先用**本地已有的目标镜像 / 当前面板镜像**当 updater 运行时，因此离线环境也能完成更新，不再去 Docker Hub 拉 `docker:27-cli`。若你所在网络要求固定某个 updater 镜像（例如内网制品库里的同等镜像），在 `panel.env` 里设置 `GSH_PANEL_UPDATER_IMAGE` 即可。

> 从 v0.3.9 及更早版本升到 v0.3.10：旧镜像不含 docker CLI，且本机也没有 `docker:27-cli` 时，面板内更新会失败并提示；按路线 B 用离线镜像包升到 v0.3.10 一次，之后面板内更新即可离线完成。

#### Native 模式（systemd）

面板进程本身拿不到 root，也写不了安装目录，所以面板内更新由两段配合完成：**面板负责下载并显示进度，后台更新程序以 root 执行官方安装器**完成安装、切换版本与重启。面板只写一个「目标版本号」的请求文件，不会把任何内容交给 root 执行。

- 前置条件：本版本的安装器会安装这套更新组件（`game-server-hub-update.path` / `game-server-hub-update.service`）。从更早版本升上来的实例需要**重跑一次安装脚本**（命令见[路线 C](#路线-cnative-海外机器一个命令装完)与[路线 D](#路线-dnative-国内服务器加速代理与国内档位)）才会出现更新组件；没有组件时面板会明说，并给出可直接复制的安装命令。
- 两步操作：先点「下载更新」把 Native Release 包（约几十 MB）下到服务器（断点续传、官方 `.sha256` 校验、本地已有则直接就绪），再点「立即安装」。
- 安装阶段做的事：校验官方安装脚本与更新包的 `.sha256` → 解压到 `/opt/game-server-hub/releases/<版本>` → 原子切换 `current` 符号链接 → 更新 `panel.env` 的 `GSH_RELEASE_VERSION` → 重启面板服务 → 健康检查确认**新版本真的在运行**。
- 只允许升级：目标版本必须高于当前版本，同版本重装与降级都会被拒绝（因此「同一个版本号重新发布了内容」这种情况在 Native 下请用安装脚本重装）。
- 失败会自动回滚：`current` 切回上一个 release、`panel.env` 恢复更新前的副本、面板以旧版本重新提供服务，并在界面上给出失败原因；执行器被中断（重启、超时）也会留下明确的失败状态，不会让界面一直停在「更新中」。
- 更新期间面板会短暂无法访问（通常 1-3 分钟，取决于服务器到 GitHub 的网速与系统包状态），游戏实例不受影响。
- **安装完成后请刷新浏览器页面**（Ctrl/Cmd+Shift+R）：还在跑的标签页里是升级前的界面脚本。管理端检测到版本不一致时会提示「页面还是旧版本」，点提示里的「刷新页面」即可。
- 排障：`sudo journalctl -u game-server-hub-update.service -n 100` 看后台程序日志；每次更新的完整安装日志在 `/var/lib/game-server-hub/panel-update/.root/update.log`（root 私有），更新状态在 `/var/lib/game-server-hub/panel-update/state.json`。

不想走面板时，随时可以用目标版本重跑安装器，效果与面板内更新一致（安装器同样会校验、切换并回滚）：

```bash
curl -fsSL "https://gh-proxy.com/https://raw.githubusercontent.com/PMAT77/game-serve-hub/v0.10.0/scripts/install.linux.sh" \
  | sudo env GSH_RELEASE_TAG=v0.10.0 bash -s -- --mode native
```

> `GSH_RELEASE_TAG` 必须填写**目标**版本号；填成当前版本只是原地重装，不会升级。国内直连 GitHub Raw 不通时，先把 `install-v0.10.0.sh` 下载到服务器，再执行 `sudo env GSH_RELEASE_TAG=v0.10.0 bash install-v0.10.0.sh --mode native`。

### 备份与恢复（v0.2.0 起）

面板「备份与恢复」页：实例存档备份/恢复（运行中自动 `c_save()`，恢复要求实例停止），更新与删实例前自动备份；每实例保留 10 份、SQLite 快照 5 份；备份包可直接下载，落在 `/var/lib/game-server-hub/backups/`。重要服自行异地留存。

---

## 卸载与清理

卸载不会删除存档，除非你显式删除数据目录。**动手前先下载备份**（面板「备份与恢复」页可直接下载，重要存档请异地留存）。安装器没有 `--uninstall` 参数，按下面的命令路径执行即可。

### Docker 模式

```bash
cd /opt/game-server-hub
# 停止并移除面板栈（游戏实例容器不受影响）
sudo docker compose --env-file panel.env -f docker-compose.yml -f docker-compose.bind.yml down

# 游戏实例：建议先在面板里逐个删除实例，再确认没有遗留容器
sudo docker ps -a | grep -i gsh
sudo docker ps -a --filter "name=gsh-" -q | xargs -r sudo docker rm -f

# 确认已备份后再删除数据目录（存档、备份与数据库都在这里）
sudo ls /var/lib/game-server-hub        # game-server-hub.sqlite、instances/、backups/
sudo rm -rf /var/lib/game-server-hub /opt/game-server-hub

sudo docker image prune -f              # 可选：清理统一镜像
```

### Native 模式

```bash
sudo systemctl stop game-server-hub.service
sudo systemctl disable game-server-hub.service
GSH_UID="$(id -u gsh)"
# 停止全部分片服务（与附录 A 的用法一致）
sudo -u gsh XDG_RUNTIME_DIR="/run/user/${GSH_UID}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${GSH_UID}/bus" \
  systemctl --user stop 'gsh-*.service'   # 分片单元名为 gsh-<实例UUID>-<master|caves>.service
sudo loginctl disable-linger gsh        # 关闭无人登录时的常驻
sudo rm -f /etc/systemd/system/game-server-hub.service && sudo systemctl daemon-reload

# 面板内更新的触发单元与后台更新程序（没装过可跳过）
sudo systemctl disable --now game-server-hub-update.path 2>/dev/null || true
sudo rm -f /etc/systemd/system/game-server-hub-update.path \
  /etc/systemd/system/game-server-hub-update.service \
  /usr/local/lib/game-server-hub/gsh-native-update
sudo systemctl daemon-reload

# 确认已备份后再删除数据目录
sudo ls /var/lib/game-server-hub
sudo rm -rf /opt/game-server-hub /var/lib/game-server-hub /var/log/game-server-hub
sudo userdel -r gsh                     # 确认不再需要 gsh 用户时执行
```

### 回滚到旧版本

- **Docker 模式**：面板栈可以换回任意已发布 tag —— 用旧 tag 重跑安装器（`GSH_RELEASE_TAG=v0.4.0`），或把 `panel.env` 的 `PANEL_IMAGE` 指向旧 tag 后执行 `gsh update`。
- **Native 模式**：按[附录 A](#附录-a-native-systemd-常用命令与回滚) 的 `current` 符号链接步骤切回旧 Release。面板内更新失败时会自动回滚到上一个 Release 并恢复 `panel.env`，不需要手动干预；上面的步骤用于你主动降级。

> 回滚面板本身不会改动游戏存档，但**旧版本可能不认识新版本迁移过的数据库**。跨版本回滚前先做一次数据库快照（面板「备份与恢复」页），并确认目标 tag 是正式发布版本。

---

## 问题清单（按报错关键词对照）

按安装时序排列，Ctrl+F 搜报错关键词。

### `download.docker.com` 不可达（装 Docker 时）

安装器会回退发行版自带的 `docker.io`，并在发行版源不含 Compose v2 时（Debian 12）自动从 GitHub Release 补装插件（gh-proxy 加速）。自动补装失败时按报错里的手动命令操作后重跑。apt 下载慢可加 `--network cn` 切国内源；其余排查 apt 源签名、系统时间和 HTTPS 出站。

### `Docker Compose v2 plugin is required but unavailable`（装 Docker 时）

仅当自动补装也失败时出现（加速节点全不可达或校验不过）：按报错信息里的手动命令安装插件后重跑安装器（命令见[路线 B 阶段一](#阶段一docker-引擎与-compose-插件)兜底小节）。正常情况下无需手动操作：Debian 12 由安装器从 GitHub Release 自动补装；Debian 13+ 与 Ubuntu 22.04（jammy-updates）起官方源已含 Compose v2（包名 `docker-compose` / `docker-compose-v2`），安装器直接装发行版包。

### `Cannot reach GHCR` / `Image pull failed`（拉镜像时）

国内服务器直接用[路线 B](#路线-b国内服务器debian-12-离线镜像包全程)。定位：`curl -I https://ghcr.io/v2/`（HTTP 401 属正常）；「清单能取到、层下载超时」是网络不可达而非鉴权失败，换代理或重试都不会成功。

### `checksum mismatch`（校验离线包时）

下载内容与 Release 不一致。清理代理/CDN 缓存，确认 `GSH_RELEASE_TAG` 与资源 URL 是同一版本，或改用本地 Release 包和官方 `.sha256`。

### 面板服务不断重启（部署后）

`docker logs --tail 100 game-server-hub-panel` 定位；常见为端口占用、panel.env 缺键或数据库权限，修正后 `docker compose up -d panel`。

### 忘记初始密码（登录时）

按[登录与安全](#登录与安全)提取 `ADMIN_PASSWORD`；已改密遗忘则用 `GSH_PASSWORD_RECOVERY_TOKEN`（在 panel.env 设置至少 16 位后重启面板）走登录页「忘记密码」，或重跑安装器并显式传 `ADMIN_PASSWORD`。两条路都要求变量真正进入面板进程，Docker 模式可先确认：`docker exec game-server-hub-panel sh -lc 'echo $ADMIN_PASSWORD'` 有值。

### SteamCMD 下载慢或失败（装游戏时）

`panel.env` 设 `GSH_STEAMCMD_DOWNLOAD_REGION=cn` 与 `GSH_STEAMCMD_INSTALL_MAX_ATTEMPTS=8` 后重启面板重试；安装前停掉运行中的实例（4 GiB 机器 SteamCMD 峰值 +1–1.5 GiB）。

安装进度停在同一百分比后失败、资源快照里 `timedOut: true`：这是单次 app_update 超时（默认 60 分钟），与内存无关。设 `GSH_STEAMCMD_APP_UPDATE_TIMEOUT_MS=7200000`（2 小时）后重启面板重试，已下载内容会断点续传。

### DST 启动后立即退出（开服时）

看实例日志；常见为 token 失效、Mod 下载不全、内存不足（exit 137 多为 OOM）。详见 [DST_TUTORIAL.md](DST_TUTORIAL.md)。

**若怀疑是内存**：DST 的内存占用是尖峰型的，世界跑起来后单分片约 1 GiB，但**启动加载整套 Mod 时峰值可达 2 GiB 上下**——4 GiB 机器装得下稳态却装不下尖峰，内核会在加载途中直接杀掉分片。**先执行一次 `sudo gsh setup-swap` 加 2 GiB swap**，绝大多数小内存机的启动失败都能解决：

```bash
swapon --show                                   # 没有输出说明还没配 swap
sudo gsh setup-swap                             # 创建 2 GiB swapfile，重启后仍有效
sudo dmesg -T | grep -iE 'killed process|oom'   # 有输出即确实被内核 OOM 杀掉
```

面板的实例详情会直接写明原因（如「内存不足被系统终止（该分片上限 N MiB）」），一般无需登录服务器判断。原理与容量建议见 [MEMORY.md](MEMORY.md)。

### 玩家看不到或连不上服务器（开服时）

放行 UDP `10999`/`8766`/`12346`；确认房间未勾选「离线」模式；集群配置见 [DST_TUTORIAL.md](DST_TUTORIAL.md)。

### `Native Release ... missing`（Native 安装时）

Release 未发布 `game-server-hub-native-<tag>-linux-x64.tar.gz` 及 `.sha256`。换已发布版本，或用 `GSH_NATIVE_RELEASE_ARCHIVE` 指定本地包（见[路线 D](#路线-dnative-国内服务器加速代理与国内档位)）；加速代理不通时同样走这条路。

### `systemd user manager` / `Failed to connect to bus`（Native 运行时）

```bash
sudo loginctl enable-linger gsh
GSH_UID="$(id -u gsh)"
sudo systemctl restart "user@${GSH_UID}.service"
sudo systemctl restart game-server-hub.service
sudo loginctl show-user gsh -p Linger
```

不要用 tmux、screen 或 PM2 绕过；会破坏日志、自恢复和资源限制语义。

### `has a bad unit file setting`（Native 启动实例时）

systemd 只会回这一句，不说是哪一行。分片 unit 落在数据目录下，直接看原文，并让 systemd 按**用户实例**解析它：

```bash
INSTANCE_ID=<报错信息里那个实例 ID>
UNIT_DIR=/var/lib/game-server-hub/home/.config/systemd/user
cat "${UNIT_DIR}/gsh-${INSTANCE_ID}-master.service"
sudo -u gsh env XDG_RUNTIME_DIR=/run/user/$(id -u gsh) \
  systemd-analyze --user verify "${UNIT_DIR}/gsh-${INSTANCE_ID}-master.service"
```

注意启动失败后面板会删掉这份 unit（避免宿主重启时被 systemd 自动拉起），所以要尽快看；新版面板会把 unit 原文、`systemd-analyze --user verify` 与 `systemctl --user status` 的输出直接放进「启动失败」提示里。

已知原因有两类，都属于面板生成 unit 的写法问题，新版已修：

- `WorkingDirectory=` 被加了双引号。systemd 对这一行**不做去引号处理**，会把 `"/srv/..."` 整串当路径，判定「非绝对路径」后直接判整个 unit 非法——表现为这台机器上**所有实例都起不来**，与是否导入存档无关。`ExecStart=` 走 shell 风格分词，引号是合法的，两行不能共用同一种写法。
- 值里出现裸 `%`：systemd 会按 specifier 展开，路径含 `%` 时 unit 同样会被判非法；新版统一转义为 `%%`。

### `cross-mode migration is not supported`（重装时）

Docker 与 Native 之间不自动迁移。保留数据目录后按目标模式重装，再手工迁移 `/var/lib/game-server-hub` 下的数据。

---

## 附录 A Native systemd 常用命令与回滚

安装命令见[路线 C](#路线-cnative-海外机器一个命令装完)（海外）与[路线 D](#路线-dnative-国内服务器加速代理与国内档位)（国内）。从早于本版本的安装升上来时，重跑一次对应路线的命令即可获得面板内更新能力。

```bash
# 常用命令与回滚
sudo systemctl status game-server-hub.service --no-pager
sudo journalctl -u game-server-hub.service -f
# 面板内更新的后台程序日志（每次从面板发起更新时才有内容）
sudo journalctl -u game-server-hub-update.service -n 100 --no-pager
GSH_UID="$(id -u gsh)"
sudo -u gsh XDG_RUNTIME_DIR="/run/user/${GSH_UID}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${GSH_UID}/bus" \
  systemctl --user list-units 'gsh-*.service'

# 回滚到旧版本（current 是指向 /opt/game-server-hub/releases/<版本> 的符号链接）
sudo systemctl stop game-server-hub.service
sudo ln -sfn /opt/game-server-hub/releases/v0.2.0 /opt/game-server-hub/current.rollback
sudo mv -Tf /opt/game-server-hub/current.rollback /opt/game-server-hub/current
sudo systemctl start game-server-hub.service
```

## 附录 B 安装器参数与自建仓库

```text
--mode auto|docker|native      交互终端 auto 在未装 Docker 时询问；非交互管道默认 Docker。
                               任何 Docker 失败都不会静默改为 Native，生产建议显式写模式
--network auto|cn|global       网络档位：cn 临时切换国内软件源并把 SteamCMD 重试提到 8 次，失败自动还原
--open-panel-port              自动放行面板端口
--open-dst-ports               自动放行 DST 端口

PANEL_PORT=9527                面板对外端口
PANEL_PUBLIC_URL=URL           显式对外访问地址（域名/反向代理/公网 IP）；设置后跳过一切地址探测
PANEL_HOST=IP                  显式面板主机地址；同样跳过地址探测
GSH_PANEL_AUTO_PUBLIC_IP=0     关闭对外 IP 自动探测（默认开启：云元数据 → 出站 IP 回显）
GSH_PANEL_PUBLIC_IP_BUDGET_SECONDS=3  对外 IP 探测的总耗时预算（秒）
PANEL_IMAGE=REF                统一镜像完整引用（tag 或 digest），自建仓库时使用
GSH_RELEASE_TAG=vX.Y.Z         安装的版本，默认取脚本内置 tag
GSH_INSTALL_MODE / GSH_NETWORK_PROFILE   非交互安装时的模式与网络档位
GSH_FORCE_IMAGE_PULL=1         强制重新拉取镜像（默认本地已有即跳过）
GSH_PANEL_ENV_PRESET=auto      内存预设档位：auto|small|medium|large|none
EXPOSE_ADMIN_PASSWORD=1        在安装摘要中明文打印初始密码（默认不打印）
STRICT_INSTALLER_ASSET_CHECKSUM=0   关闭安装资源校验和强校验（默认 1，失配即中止）
DST_GAME_PORT / DST_AUTH_PORT / DST_MASTER_PORT / DST_CAVES_*   覆盖默认 DST 端口
GSH_GITHUB_PROXY=URL           固定单一 GitHub 加速代理（如 https://gh-proxy.com/），安装与面板内更新共用
GSH_NATIVE_RELEASE_ARCHIVE=…   Native 离线安装包路径
GSH_NATIVE_RELEASE_MIRRORS=…   Native Release 下载源（逗号分隔的目录前缀）
GSH_NATIVE_RELEASE_SHA256=…    本地包旁没有同名 .sha256 时，手工给出摘要
GSH_NATIVE_STEAMCMD_URL=URL    Native 模式 SteamCMD 下载地址（默认 steamcdn-a.akamaihd.net）
GSH_NATIVE_UPDATE_DIR=PATH     Native 面板内更新的请求/状态交换目录（默认 <数据目录>/panel-update）
```

完整参数与当前默认值以 `sudo bash ./scripts/install.linux.sh --help` 的输出为准。

自建仓库（先 `docker load` 离线包，再 `docker tag`/`push` 到内网）：

```bash
sudo docker login registry.example.com
# 版本三方必须一致：脚本默认 tag（sed -n '9p' 可查）= 本地镜像 tag = 这里 PANEL_IMAGE 的 tag
curl -fsSL https://raw.githubusercontent.com/PMAT77/game-serve-hub/v0.10.0/scripts/install.linux.sh \
  | sudo env PANEL_IMAGE=registry.example.com/gsh/game-server-hub:v0.10.0 bash -s -- --mode docker --network cn
```

镜像引用与 Release tag 一致，按 Release 的 `release-images.json` 核对 digest。

SteamCMD 可在 `panel.env` 设置（改后重启面板）：`GSH_STEAMCMD_DOWNLOAD_REGION=cn`、`GSH_STEAMCMD_INSTALL_MAX_ATTEMPTS=8`、`GSH_STEAMCMD_HTTP_PROXY` / `GSH_STEAMCMD_HTTPS_PROXY`。
