# Game Server Hub 架构与产品边界

本文记录 Game Server Hub 从 Docker-only 面板演进为双部署、Open-Core 产品的稳定边界。实现和评审若与本文冲突，应先更新本文并说明迁移策略。

## 产品定位

| 部署模式 | 主要用户 | 面板运行方式 | SteamCMD / 游戏运行方式 |
| --- | --- | --- | --- |
| Docker | 小型游戏社区、游戏托管商 | Docker Compose | Docker 容器 |
| Native | 个人服主 | systemd 系统服务 | systemd 用户服务 |

Native 模式必须完全不依赖 Docker。它不是“面板运行在宿主机、游戏仍运行在容器”的混合模式。

首期正式支持 Ubuntu 22.04 / 24.04、Debian 12 和 x86_64。ARM64 仅作为实验性平台展示；具体游戏是否可运行取决于 SteamCMD 与游戏服务端本身。

## Open-Core 边界

许可与依赖纪律（商业插件开工前必须满足）：

- **Community 核心永久 MIT**，不做「先 MIT 后改许可」的动作；核心不因商业插件缺失而失去单节点完整生命周期能力。
- **Pro 插件单独授权**，自身可不开源；插件不得让核心产生「未授权即不可用」的核心能力下降。
- **核心与插件都不引入 AGPL / GPL 类依赖**：面板以网络服务形态分发，AGPL 的传染性会直接与商业发行冲突。引入新依赖前先核对 LICENSE，构建期工具链的 LGPL（如 `rollup-plugin-dts`）不进产物、可接受。

Community 核心永久开源，至少包含：

- 单节点管理
- Docker / Native 双部署
- 游戏安装、更新、启动、停止和控制台
- 基础主机与实例监控
- DST 房间、世界、Mod 管理
- 玩家管理页：在线玩家（含地上与洞穴分片）、踢出与封禁，以及管理员 / 白名单 / 黑名单
- **成员与角色**：角色（53 个权限点按模块勾选）、成员、实例授权分配；能力与范围两层生效；三条防锁死约束；内置只读的游客角色
- 玩家名字档案：把 Klei 用户 ID 与游戏名对上号，名单按游戏名显示与搜索，支持手工备注
- 实例目录的文件浏览、文本编辑、上传与下载
- 世界维护：存档点回档与重置世界，两者执行前自动创建安全备份
- 控制台日志落盘、历史查看与下载
- 环境自检（运行环境 / 磁盘 / 内存 / 数据目录 / 实例 / 通知）
- 本地备份与恢复
- 公开的插件 SDK、插件清单格式和兼容性检查（**规划中**，尚未实现，见下方“实现状态”）

商业插件可以包含：

- 多节点与集群管理
- 跨节点编排计划任务
- 异地或云备份
- 告警平台集成（Prometheus / PagerDuty 等）
- 审计日志和高级 RBAC
- SSO、托管商和白标能力

首个商业插件是多节点管理。Community 核心不能因为商业插件缺失而失去单机服务器的完整生命周期管理能力。

### 运维能力的 Community / Pro 细分

为避免“计划任务、告警”等词在两侧含糊，边界按能力层级划分：

| 能力 | Community（核心内） | Pro（商业插件） |
| --- | --- | --- |
| 备份与恢复 | 本地实例存档备份/恢复、保留策略、数据库快照、更新与删除前自动备份 | 异地/云备份、跨实例批量策略 |
| 计划任务 | 单机实例定时动作（定时重启/备份/更新检查/数据库备份） | 跨节点编排、批量任务 |
| 告警通知 | 本地阈值与实例事件 → 通用 Webhook / Telegram | 告警平台集成、升级策略 |
| 用户与权限 | 基础用户管理与既有权限点分配（成员的增删改、启用停用、权限点指派；界面待补，归属是核心） | 角色模板与组织、高级 RBAC、房间级隔离、SSO |
| 审计 | 结构化操作日志（pino + requestId） | 完整审计日志与查询 |

依据：Community 核心承诺“单节点完整生命周期”与“本地备份与恢复”；单机定时动作与本地阈值告警是其自然延伸，不涉及跨节点能力。

商业插件使用签名插件包和设备授权文件。授权文件允许离线使用；授权服务不可达时，不得立即停止正在运行的游戏实例。

> 实现状态：双运行时、安装器与 Release 基础设施已交付；**授权机制（Ed25519 离线验签）已实现**——许可文件是一个带签名的 JSON，核心内置公钥，不联网、无授权服务器，`GSH_LICENSE_FILE` 指定位置，缺省读取面板数据目录下的 `license.json`；签发工具在 `scripts/license/`（见该目录的 README）。**插件宿主已实现**——插件目录（默认 `<数据目录>/plugins`，可用 `GSH_PLUGINS_ROOT` 指定）下的清单与签名会被校验，管理员在左侧菜单「插件」里能看到每个插件的状态（含进程状态、来源、申请的权限）、启用或停用，并查看插件调用记录；插件以独立进程运行，通过回环能力服务访问面板数据（详见下方「插件与宿主的通信方式」）。**插件页面已改为商店形态**——页面分「已安装 / 可获取 / 尚未开发 / 调用记录」，未安装的官方插件也会以卡片出现（数据来自 `server/src/plugins/store-catalog.ts` 这份手工维护的目录），卡片说明它需要的能力与哪一项授权、当前是否已具备；**插件包导入已实现**（`POST /app/system/plugins/import/inspect` 上传校验 + `POST /app/system/plugins/import` 落位）：包先解压到临时目录并走一遍与宿主启动完全相同的装载校验，通过后才写入插件目录，导入后默认停用。**插件页面注册协议尚未实现**（插件还不能往面板里添加自己的界面），`gsh plugin` 子命令与**插件包的自动分发渠道（在线索引与自动下载）同样未做**——插件包仍由发布方人工交付、客户在面板内导入，付款与合同都在面板之外。当前 Community 版本没有随包发布的付费插件，也没有任何付费入口。**成员与角色已交付**：角色（53 个权限点按模块勾选）、成员、实例授权分配；能力与范围两层生效（角色定"能做什么"、实例授权定"能在哪些实例上做"），三条防锁死约束，内置只读的游客角色（为将来的公开只读预览预留，本次不开放入口）。
>
> 授权的两条硬约束（改动相关代码前先确认仍成立）：**许可只影响 Pro 插件的可用性，Community 核心能力不因许可缺失、过期或无效而减少**；**正在运行的游戏实例永远不会因为许可问题被停止**。
>
> 插件的三条硬约束（同样在实现里）：**插件进程外运行**，崩溃或停用不影响核心与运行中的实例；**能力必须显式声明**，未声明即拒绝；**商业插件必须带签名**（`plugin.signature.json`，签的是清单的规范化 JSON）。
>
> 信任根：授权许可用 `GSH_LICENSE_PUBLIC_KEY` 验签、插件包用 `GSH_PLUGIN_PUBLIC_KEY`（未配置时回落到前者）。**建议各用一把密钥**——许可按客户签发、插件按发布流程签发，混用会让插件流程的失误波及所有客户授权。两者都支持配多把公钥以支持轮换。签发工具见 `scripts/license/README.md`。
>
> 插件与宿主的通信方式：宿主在 `127.0.0.1` 上以随机端口起一个**能力服务**，插件进程从环境变量拿到地址与一次性令牌（每次面板启动重新生成，不落盘、不进命令行），用 `POST /capabilities/<能力>` 调用。当前能力：只读的 `/capabilities/instances`、`/capabilities/metrics`、`/capabilities/console`、`/capabilities/backups`；写类的 `/capabilities/lifecycle`（启停重启实例）、`/capabilities/backups/create`、`/capabilities/backups/delete`；以及插件查看自己调用记录的 `/capabilities/audit`。插件必须先在清单里声明对应权限，宿主再按声明授予，能力服务对未授予的请求返回 403 并记日志。插件输出写入自己目录下的 `plugin.log`。
>
> 仓库里有三个可运行插件示例：`examples/plugins/audit-reporter`（社区插件，演示基本约定）、`examples/plugins/remote-backup`（**商业插件**，异地与云备份）与 `examples/plugins/audit-log`（**商业插件**，操作审计归档）。三者都由测试真实装载并启动过。
>
> **双重审计**：面板同时维护两条证据链——**用户操作审计**（谁在什么时候改了什么，含被拒的写操作，`<数据目录>/audit/operations.ndjson`）与**插件调用审计**（哪个插件调用了什么，`<数据目录>/plugin-audit/<插件>.ndjson`）。都用追加写的 NDJSON：审计要比被审计的对象更耐久，数据库损坏或回滚时它还在。两条审计共用同一套参数脱敏规则（`shared/http/audit-params.ts`）。
>
> **插件调用审计**：每次能力调用都由宿主记一条 NDJSON（`<数据目录>/plugin-audit/<插件>.ndjson`），含时间、插件、能力、操作、参数摘要、结果与耗时；参数里的敏感键（token / password / secret / key 等）一律写成「已隐去」。这件事必须由宿主做：插件自己的日志它可以选择不写、写错或事后修改，宿主侧的记录才是对第三方代码唯一客观的依据。
>
> 崩溃语义：**退出码 0 = 正常结束**（记为 `finished`，不重启）；**非零退出或被信号终止 = 崩溃**（按 1s→2s→4s… 退避重启，连续 5 次后停在 `crashed` 并写明原因）。这条区分是必要的：不分的话，一次性任务型插件会被无限重启。
>
> 对外口径：核心功能免费且不做功能阉割；Pro 插件**未开发、无时间表**，不得在任何界面或文档里暗示其可用；付费服务（代搭建、迁移、私有化部署、定制开发）与核心使用互不影响，见根 `README.md` 的「赞助与商业合作」。

## 分层架构

```mermaid
flowchart TB
  UI["Vue 管理界面"] --> API["Fastify API"]
  API --> UseCases["应用服务 / 用例"]
  UseCases --> RuntimePort["GameRuntime Port"]
  UseCases --> InstallerPort["GameInstaller Port"]
  UseCases --> UpdatePort["PanelUpdate Port"]
  RuntimePort --> DockerRuntime["Docker Runtime Adapter"]
  RuntimePort --> NativeRuntime["systemd Runtime Adapter"]
  InstallerPort --> DockerSteamCMD["SteamCMD Container Adapter"]
  InstallerPort --> NativeSteamCMD["Native SteamCMD Adapter"]
  UpdatePort --> ComposeUpdate["Compose Update Adapter"]
  UpdatePort --> NativeUpdate["Native Release Update Adapter"]
  API --> PluginHost["Plugin Host"]
  PluginHost --> CommunityPlugins["Community Plugins"]
  PluginHost --> CommercialPlugins["Signed Commercial Plugins"]
```

业务模块不得直接导入 `dockerode`、执行 `docker` 命令或拼接 systemd 单元。基础设施细节只能存在于对应 Adapter 内。

> 可交互的可视化架构图：[game-server-hub-architecture.html](archify/game-server-hub-architecture.html)（单文件 HTML，下载后可直接在浏览器打开）。

### 运行时能力

通用运行时使用“服务/进程”语义，而不是“容器”语义：

- 运行时可用性检查
- 创建或更新实例服务
- 启动、停止和删除
- 查询状态、PID、CPU、内存和启动时间
- 读取和持续跟随日志
- 向游戏控制台写入命令
- 为多分片实例准备和清理互联配置

Docker Adapter 可以继续用容器 ID 作为运行时引用；Native Adapter 使用 systemd unit 名称。数据库迁移期间保留现有 `containerId` 字段读取能力，但新代码应逐步使用通用 `runtimeRef` 和 `runtimeKind`。

## Native 模式

### 服务模型

- `game-server-hub.service`：系统级面板服务，以专用 `gsh` 用户运行。
- `gsh-<实例 ID>-master.service`：DST 地上世界用户服务。
- `gsh-<实例 ID>-caves.service`：DST 洞穴世界用户服务。

  实例 ID 是创建实例时生成的 UUID，因此单元名形如 `gsh-3f2a8c1e-…-master.service`；
  运维命令请用 `gsh-*.service` 通配，不要写成 `gsh-instance-*`——那样匹配不到任何单元。
- 使用 `loginctl enable-linger gsh` 保证用户服务在无人登录时仍可运行。
- 用户服务文件存放在 `~gsh/.config/systemd/user/`，实例配置和 FIFO 存放在受控的数据目录。

禁止使用 tmux、screen 或 PM2。日志分两处：面板服务本身进 journald（`journalctl -u game-server-hub.service`），分片日志由 systemd 用 `StandardOutput=append:` 直接追加到实例目录下的控制台日志文件——不用 `journalctl --user-unit` 采集，是因为面板以 `gsh` 用户跑在系统服务里、不在 `systemd-journal` 组内，那条路在线上必然报权限错误。资源限制使用 systemd 的 `MemoryHigh`、`MemorySwapMax`、`CPUQuota` 与 `StartLimit*` 等能力。

游戏控制台通过权限受控的命名管道写入进程标准输入，不依赖交互式终端。

### 文件布局

```text
/opt/game-server-hub/
  current/               # 当前原生 Release
  releases/<version>/    # 可回滚 Release
  panel.env              # 面板配置
  runtime/steamcmd/       # Native SteamCMD
/var/lib/game-server-hub/
  game-server-hub.sqlite
  instances/
  backups/
  runtime/
/var/log/game-server-hub/
  install.status
  install.diagnostics.log
```

原生升级采用“解压到新版本目录 → 数据库备份/迁移 → 原子切换 `current` → 重启健康检查”的方式。健康检查失败时切回旧版本；任何升级都不得删除现有实例目录。

## 安装器策略

安装入口支持：

```text
--mode auto|docker|native
--network auto|cn|global
```

- 交互终端下，`auto` 可以根据预检结果建议部署模式并请求确认。
- 非交互安装不得从 Docker 静默降级为 Native；失败时输出可直接复制的 Native 安装命令。
- `cn` 网络档位可自动启用发行版软件源镜像、增加重试，并设置 SteamCMD 国内下载区域。
- 在没有官方国内容器仓库前，不把来源不明的第三方容器代理设为默认值。
- Compose 等仓库内安装资源使用脚本内置摘要，不能为了校验再次强制访问 GitHub Raw。
- Native 包当前使用 GitHub Release 同名 `.sha256` 做传输完整性校验；商业正式版前须升级为安装器内置信任根的签名清单。
- 所有源都失败时输出尝试过的 URL、失败阶段和脱敏诊断文件位置。

## v0.1.4 兼容性

升级必须保留：

- SQLite 数据库
- `/var/lib/game-server-hub/instances`
- `/var/lib/game-server-hub/backups`
- 已运行的 `gsh-*` Docker 游戏容器
- 现有 `panel.env` 中用户自定义值

Docker 部署的升级不能因为引入 Native Adapter 而重建或停止现有游戏容器。Docker 与 Native 之间的迁移首期采用显式迁移命令，不自动转换正在运行的实例。

## 首期验收标准

1. Docker 模式从 v0.1.4 原地升级后，数据库、实例和游戏容器保持可用。
2. Native 模式在干净的 Ubuntu 22.04 / 24.04、Debian 12 x86_64 上无需 Docker 完成安装。
3. Native 模式可安装 DST、启动地上/洞穴、查看日志、发送控制台命令、停止并在宿主机重启后恢复。
4. `--network auto` 能识别常见的 GitHub/Docker 仓库不可达情形，并给出确定性回退。
5. 安装资源镜像不可篡改 Compose、原生 Release 或校验清单而不被发现。
6. 安装失败会回滚本次创建的面板服务和 Release 链接，不删除用户已有数据。
7. README 提供 Docker 与 Native 两条从零开始的中文教程，以及可按错误关键词检索的 FAQ。
