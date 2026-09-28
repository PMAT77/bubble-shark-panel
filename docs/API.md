# 接口参考

面向二次开发与集成。面板是前后端分离应用：前端在 `src/`，后端在 `server/`，**接口契约集中在 `shared/contracts/`**，前后端共用同一份类型定义。

## 约定

- 业务接口统一挂在 `/app/...` 前缀下，例如 `GET /app/system/panel-update/status`、`POST /app/instance/shards`、`POST /app/schedule/list`。
- 类型定义按模块放在 `shared/contracts/`：`system.ts`、`instance.ts`、`cluster.ts`、`player.ts`、`shard.ts`、`map.ts`、`console.ts`、`mod.ts`、`backup.ts`、`schedule.ts`、`notify.ts`、`node.ts`、`auth.ts`、`maintenance.ts`、`dst-summary.ts` 等；前端 `src/api/` 直接复用这些契约，改接口时两边同步。
- 响应统一为成功 `{ code: 'OK', data }` 或失败 `{ code: <错误码>, message }`（`ApiSuccessResponse` / `ApiErrorResponse`）。
- 除登录相关接口外都需要登录态，未登录返回 `AUTH_UNAUTHORIZED`，权限不足返回 `AUTH_FORBIDDEN`。
- 路由枚举与前端路径常量见 `shared/constants/frontend-routes.ts`。

## 错误码

完整常量见 `shared/constants/error-code.ts`，常用项：

| 错误码 | 含义 | 处理方式 |
| --- | --- | --- |
| `COMMON_INVALID_PARAMS` | 参数校验失败 | 对照 `shared/contracts` 中的 schema 检查请求体 |
| `AUTH_UNAUTHORIZED` / `AUTH_FORBIDDEN` | 未登录 / 无权限 | 重新登录，或确认账号权限点 |
| `AUTH_FORCE_PASSWORD_CHANGE` | 强制改密未完成 | 跳转 `/force-change-password` 完成改密 |
| `AUTH_CAPTCHA_REQUIRED` / `AUTH_LOGIN_RATE_LIMITED` | 需要验证码 / 登录被限流 | 稍后重试 |
| `HOST_MEMORY_PRESSURE` | 宿主机可用内存不足 | 调整内存档位或先停掉其它实例，见 [内存建议](MEMORY.md) |
| `INSTANCE_PORT_CONFLICT` | 实例端口与已有实例冲突 | 手动修改端口或使用自动分配 |
| `BACKUP_NOT_FOUND` / `BACKUP_REQUIRES_STOPPED` / `BACKUP_FILE_MISSING` | 备份不存在 / 实例未停止 / 备份文件丢失 | 见 [DST 开服教程 · 备份与恢复](DST_TUTORIAL.md#17-备份与恢复) |
| `BACKUP_CREATE_FAILED` / `BACKUP_RESTORE_FAILED` | 备份或恢复执行失败 | 查看面板日志与实例状态 |
| `BACKUP_IMPORT_SOURCE_INVALID` / `BACKUP_IMPORT_UPLOAD_INVALID` | 导入的存档结构无效 / 上传包无效 | 确认存档目录结构与压缩包大小限制 |

## 地形图接口

把当前世界的地形导出并渲染成一张 PNG。**只在实例运行时可用**：面板让正在运行的专用服把地块数据以 RLE 压缩后分块打到控制台日志，读回后自己画图，因此图里含当前启用的 Mod 影响，但不含玩家位置。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/app/instance/map?instanceId=&shard=` | 查状态与元信息（尺寸、渲染倍率、导出时间、种子、已探索占比、地标数、图例）；命中缓存不打扰游戏 |
| `POST` | `/app/instance/map/refresh` | 触发一次导出与渲染，body：`{ instanceId, shard, force? }`；`force` 跳过新鲜窗口 |
| `GET` | `/app/instance/map/image?instanceId=&shard=&token=` | 返回 `image/png`。**这是唯一允许把令牌放在查询参数里的接口**：图片由 `<img src>` 加载，浏览器不会给图片请求带自定义请求头 |

生成是异步的：`refresh` 立即返回，前端轮询第一个接口看 `status`（`idle` / `generating` / `ready` / `failed`）。失败原因写在 `message` 里，直接展示即可。

响应里几个容易看错的字段：

| 字段 | 含义 |
| --- | --- |
| `width` / `height` | **地形网格**尺寸（格）。地上默认约 425 × 425 |
| `renderScale` | 每格渲染成的像素数（默认 3）。图片实际像素 = `width × renderScale`。出图分辨率高于显示尺寸，是为了让浏览器缩小显示时不糊 |
| `landmarkCount` | 图上标出的关键地标点数（猪王、洞穴入口、海象营地等 19 类） |
| `legend` | 图上真实出现过的类别：`kind` 为 `terrain` 或 `landmark`，带中文名 `label`、与图片同源的 `color`、`count`；地形的 `ratio` 是占比（0–1），地标为 `null`；地标另有 `shape`（`circle` / `square` / `diamond`，与图上形状一致） |

图例只列**这张图上真实出现过**的项，颜色由服务端给出（与画在 PNG 上的完全同源）。**没收录配色的地块**（游戏新版本或 Mod 引入的地块）会被排在最前面、`known` 为 `false`：它的 `label` 优先用**游戏自己报回来的官方名**（形如 `Ice Floe（未收录）`），拿不到名字时回落到 `未收录地块 #N`；颜色按 ID 派生，保证多块未收录地形彼此分得开、且比一律涂洋红可读。要补配色，改 `server/src/modules/map/terrain-catalog.ts` 即可。

地标是增值层：游戏侧读不到实体表时，地形照常出图，只在 `message` 里说明这次导出不含地标。

## 商业支持接口

面板自身如何被支持、以及 Pro 能力的真实状态，集成方不必去翻仓库文档：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/app/system/commercial` | 返回版本形态（`edition`）、核心是否免费、Pro 状态与能力清单、可选的付费人工服务（名称、交付内容、参考价区间）、不含项、联系方式与仓库地址。需 `license:read` 权限 |

契约见 `shared/contracts/commercial.ts`。两点口径需要注意：

- 这是**只读**接口，面板没有任何下单或支付能力，付款与合同都在面板之外完成；
- `proLicensed` 恒为 `false`：Pro 插件尚未开发，本字段是为将来的授权机制预留的，任何界面与集成都不应据此显示「可升级」。

## 迁移包导出接口

把某个实例的存档整理成「另一台机器可以直接导入」的包。等价于仓库里的 `scripts/export-cluster-archive.ts`（那个用于从**别的机器**上整理），两者共用同一套集群识别、体检与报告实现，报告与包不会互相打架。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/app/instance/migration/report` | 只出报告，不打包。body：`{ instanceId, reportOnly? }`，返回 `fileName`、`reportText`、`warnings` |
| `POST` | `/app/instance/migration/export` | 打包并**直接返回文件流**（`application/gzip`）。body：`{ instanceId }`。打包耗时随存档大小增长，客户端需要关掉请求超时 |
| `POST` | `/app/instance/migration/download` | 重新下载已生成的包：body `{ instanceId, fileName }`。包只保留 24 小时，过期返回 `BACKUP_FILE_MISSING` |

约定与边界：

- 三个接口都要求实例级授权：报告用 `instance.migration:read`，导出与重下用 `instance.migration:export`，且调用者必须被授权该实例；
- **包内顶层就是集群目录**（含 `cluster.ini`），这是面板「导入存档」的识别口径；包内**不含游戏本体与 Mod 文件**，导入后由目标机器自行下载；
- 导出目录默认在面板数据目录下的 `migration-exports/`（可用 `GSH_MIGRATION_EXPORT_ROOT` 覆盖），按实例保留 24 小时；
- 实例**没开过服**（缺 `cluster.ini`）时明确拒绝，不会创建空集群目录；
- 响应头按 RFC 5987 给出文件名（ASCII 回退 + `filename*=UTF-8''`），文件名本身是纯 ASCII 的 `migration-<实例后缀>-<集群目录>.tar.gz`；
- 报告里**不含集群令牌与房间密码**，可以贴进群里或交给接手的人。

## 插件接口

插件是独立进程，宿主负责「装载校验 + 启用状态 + 按声明授予能力 + 进程生命周期」。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/app/system/plugins` | 返回宿主接口版本、插件根目录、**商店货架说明**与插件列表（状态、进程状态、来源、申请的权限）。列表里既有本机已装的插件（`installed: true`），也有官方目录里尚未安装的条目（`installed: false`，版本为 `-`、目录为空串）。需 `plugin:read` |
| `POST` | `/app/system/plugins/toggle` | 启用或停用：body `{ pluginId, enabled, acknowledgeDangerous? }`；启用/停用会同步拉起或终止插件进程。需 `plugin:manage` |
| `GET` | `/app/system/plugins/audit` | 插件调用审计（最近的在前）：query `{ pluginId?, limit? }`（limit ≤ 500）。需 `plugin:read` |
| `POST` | `/app/system/plugins/import/inspect` | **导入第一步**：以专属内容类型 `application/x-gsh-plugin-package` 直接上传包体，服务端解压到临时目录并做装载校验（清单 / 入口 / 接口版本 / 签名），返回 `{ uploadId, analysis }`。**此步不写插件目录**。体积上限 64 MB。需 `plugin:manage` |
| `POST` | `/app/system/plugins/import` | **导入第二步**：body `{ uploadId }`，凭第一步的记录落位。写入前会**重跑一次校验**，导入后插件默认停用。需 `plugin:manage` |
| `GET` | `/app/system/audit/operations` | **用户操作审计**（谁在什么时候对面板做了什么，含被拒的写操作）：query `{ account?, limit? }`。需 `audit:read` |

### 商店字段怎么读

`GET /app/system/plugins` 的每一项都带 `installed`，以及 `store`（可能为 `null`）：

| 字段 | 含义 |
| --- | --- |
| `store.summary` / `store.detail` | 官方目录给的产品说明。已安装的插件也以目录文案为准，因为清单里的 `description` 由插件自己写、不受发布方控制 |
| `store.access.state` | `bundled`（随面板分发）/ `obtainable`（人工渠道获取）/ `planned`（**尚未开发，没有获取方式**） |
| `store.requiredLicense` | 这项能力要哪一份商业授权；`null` 表示不需要 |
| `store.licenseSatisfied` | 仅未安装的条目有值：当前许可是否已覆盖它需要的授权。为 `false` 时界面显示「未获取」并给出订阅入口；为 `true` 时显示「已订阅 · 待导入」，因为**许可与插件包是两件分开交付的东西**，这个中间态很常见 |

三条边界：

- **本页不下单、不支付、不自动下载**：插件包由用户从面板之外拿到，面板只负责校验并放对位置；
- **尚未开发的能力不给入口**：`access.state` 为 `planned` 的条目在任何界面都不得出现订阅或获取按钮；
- **许可与插件包是两道独立校验**：导入只校验插件包签名，授权只影响**启用**。所以「有包没许可」与「有许可没包」都是合法中间态，界面分别用「缺少授权」与「已订阅 · 待导入」表示。

### 插件侧的能力 API（插件调用宿主）

宿主在 `127.0.0.1` 上以随机端口提供一个能力服务，插件必须用它自己的令牌访问：

| 方法 | 路径 | 需要的能力 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/capabilities/ping` | 无需 | 探活，用于排障 |
| `POST` | `/capabilities/instances` | `instances:read` | 实例列表（id、名称、状态、端口） |
| `POST` | `/capabilities/metrics` | `metrics:read` | 主机 CPU / 内存 / 磁盘快照 |
| `POST` | `/capabilities/console` | `console:read` | 某实例最近的控制台日志（body：`{ instanceId, lines? }`，上限 500 行） |
| `POST` | `/capabilities/lifecycle` | `instances:lifecycle` | 启停重启实例（body：`{ instanceId, operation: start\|stop\|restart }`）。**写能力**：会让线上玩家掉线，启用插件时管理员必须确认过危险能力 |
| `POST` | `/capabilities/backups` | `backups:read` | 备份记录列表（含备份包绝对路径与文件是否存在）；body：`{ instanceId? }`。**只给路径不给内容**：插件与面板同机，几百 MB 的包由插件自己流式读取 |
| `POST` | `/capabilities/backups/create` | `backups:write` | 触发一次实例备份；body：`{ instanceId, note? }` |
| `POST` | `/capabilities/backups/delete` | `backups:delete` | 删除一条备份记录及其文件；body：`{ backupId }`。**危险能力**，用于插件的保留策略 |
| `POST` | `/capabilities/operations` | `operations:read` | **用户操作审计**（谁在什么时候改了什么，含被拒的写操作）；body：`{ account?, limit? }`。对应商业能力 `audit-log` |
| `POST` | `/capabilities/audit` | `instances:read` | 插件查看自己的调用记录（body：`{ limit? }`，上限 200 条） |

所有请求都需带请求头 `x-gsh-plugin-token`，body 里带 `pluginId`。失败时返回 `{ ok: false, error, outcome }`，HTTP 状态码为 401（令牌无效）/ 403（能力未授予）/ 400（参数或执行错误）。**每一次调用（含被拒的越权尝试）都会写入宿主侧审计**：`<数据目录>/plugin-audit/<插件>.ndjson`。

插件从这几个环境变量拿到约定：

| 环境变量 | 含义 |
| --- | --- |
| `GSH_PLUGIN_ID` | 插件标识（与清单一致） |
| `GSH_PLUGIN_DIR` | 插件所在目录 |
| `GSH_PLUGIN_API_VERSION` | 宿主实现的插件接口版本 |
| `GSH_CAPABILITY_URL` | 能力服务地址（`http://127.0.0.1:<随机端口>`） |
| `GSH_PLUGIN_TOKEN` | 一次性令牌，**只在环境变量里传递**，不落盘、不进命令行 |

### 写一个插件

仓库里有一个可直接运行的示例：`examples/plugins/audit-reporter`（复制到面板数据目录的 `plugins/` 后启用即可）。它演示了清单字段、环境变量约定、能力调用、退出语义与日志去向，并附了一节常见坑。最小骨架长这样：

```js
const pluginId = process.env.GSH_PLUGIN_ID
const baseUrl = process.env.GSH_CAPABILITY_URL
const token = process.env.GSH_PLUGIN_TOKEN

const response = await fetch(`${baseUrl}/capabilities/instances`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-gsh-plugin-token': token },
  body: JSON.stringify({ pluginId }),
})
const { ok, data, error } = await response.json()
```

### 约定与边界

- 插件目录默认 `<面板数据目录>/plugins`，可用 `GSH_PLUGINS_ROOT` 覆盖；每个插件一个子目录，内含 `plugin.json` 清单，商业插件还必须带 `plugin.signature.json`；
- 清单契约见 `shared/contracts/plugin.ts`：`id`（小写字母、数字、连字符）、`version`（语义化）、`apiVersion`、`kind`（`community` / `commercial`）、`entry`（目录内相对路径）、`capabilities`；
- **启用声明了危险能力**（`instances:lifecycle`、`console:write`、`backups:write`、`network:outbound`）的插件，必须带 `acknowledgeDangerous: true`，否则接口返回业务错误；
- 插件状态：`ready` / `disabled` / `invalid`（清单、签名或版本不通过，`message` 说明原因）/ `missing_license`（商业插件但当前授权不含对应能力）；
- 进程状态单独给出（`stopped` / `starting` / `running` / `finished` / `crashed`）：**退出码 0 记为 `finished` 且不重启**，非零退出按退避重启、连续 5 次后停在 `crashed`；插件输出见其目录下的 `plugin.log`；
- 插件装载失败**不会**让接口报错，坏插件会以 `invalid` 出现在列表里并给出原因——否则一个坏插件会让管理员连"停用"都点不到。

## 成员与角色接口

管理面板自己的账号与权限。**能力与范围是两层**：角色的权限点决定账号能做什么，实例授权决定它能在哪些实例上做，两者同时满足才生效。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/app/system/roles` | 角色列表（含每个角色的权限点与成员数）。需 `role:read` |
| `POST` | `/app/system/roles/create` | 新建角色：body `{ name, description?, permissions[] }`。权限点必须是清单里有的（唯一真源：`shared/constants/permissions.ts`）。需 `role:write` |
| `POST` | `/app/system/roles/update` | 修改角色：body `{ roleId, name, description?, permissions[] }`。改动会**立即物化**到该角色全部成员的生效权限。需 `role:write` |
| `POST` | `/app/system/roles/delete` | 删除角色：body `{ roleId }`。内置游客角色、以及仍有成员在用的角色会被拒绝。需 `role:write` |
| `GET` | `/app/system/members` | 成员列表（含角色与实例授权）。需 `member:read` |
| `POST` | `/app/system/members/create` | 建子账号：body `{ account, password, roleId, instanceIds?, mustChangePassword? }`。密码须过强度校验（与改密同一套规则）；`mustChangePassword` 默认 `true`。需 `member:write` |
| `POST` | `/app/system/members/update` | 改角色或启停：body `{ userId, roleId?, status? }`。需 `member:write` |
| `POST` | `/app/system/members/password` | 重置密码：body `{ userId, password, mustChangePassword? }`。会吊销该账号现有会话。需 `member:write` |
| `POST` | `/app/system/members/instances` | 设置可见实例：body `{ userId, instanceIds[] }`，**整表替换**。需 `member:write` |
| `POST` | `/app/system/members/delete` | 删除成员：body `{ userId }`，连带清掉它的角色关联与实例授权。需 `member:write` |

**三条防锁死约束**（违反时返回业务错误，消息里写明原因）：

1. 不能停用、删除或降权**当前登录的账号**；不能把自己的角色换成没有「管理角色」权限的；
2. 不能让**最后一个能管理角色或面板设置的启用账号**消失——停用、降权、删角色三条路径都拦。判定依据是**生效权限点**而不是角色（鉴权读的就是它）；
3. 内置**游客角色**不可改权限点、不可删除。

权限点清单**不通过接口下发**：前端直接引用 `shared/constants/permissions.ts` 的 `PERMISSION_SPECS`，少一份传输就少一个漂移点。

## 新增或修改接口

1. 在 `shared/contracts/<模块>.ts` 定义请求与响应类型；
2. 在 `server/src/modules/<模块>/` 实现并注册路由（`app/<前缀>/...`），复用 `server/src/shared/http` 的响应包装与错误码；
3. 前端在 `src/api/` 增加对应封装；
4. 破坏性变更写入 [CHANGELOG.md](../CHANGELOG.md) 并在 Release Notes 标注迁移方式（参考 0.4.0 中 `effectiveHints` 的弃用写法）。

## 反向代理与客户端 IP

面板部署在 Nginx / Caddy 等反向代理后面时，必须在 `panel.env` 设置 `GSH_TRUST_PROXY`（可信代理地址），否则服务端取到的是代理地址，影响登录限流与日志中的来源 IP。字段定义见 `server/src/shared/config/index.ts`。

## 相关文档

- 表结构与迁移：[DATABASE.md](DATABASE.md)
- 分层与端口 / 适配器边界：[ARCHITECTURE.md](ARCHITECTURE.md)
- 后端目录与模块职责：[server/src/README.md](../server/src/README.md)
