# modules 目录说明

后端业务模块目录。每个模块对外只暴露注册入口（路由挂在 `app/...` 前缀下）。模块内部的目标分层是 `controller -> service/usecase -> domain -> repository`；现状是多数模块已把用例拆到同目录的独立文件（如 `instance/install-service.ts`、`backup/backup-service.ts`），而路由与部分状态机仍写在 `index.ts` 内（`instance/index.ts`、`mod/index.ts` 偏大）。新增代码请按目标分层放置，不要继续往注册文件里堆业务逻辑。

## 当前模块

| 模块 | 职责 |
| --- | --- |
| `auth` | 认证、登录态、权限点与密码管理 |
| `instance` | 实例生命周期、安装与更新检查、端口同步、异常退出处理 |
| `cluster` | 集群与房间配置（`cluster.ini`） |
| `player` | 玩家名单文件（`adminlist.txt` / `blocklist.txt` / `whitelist.txt`）的结构化读写、玩家档案（ID ↔ 游戏名）、在线玩家与踢出 / 封禁动作 |
| `files` | 实例目录内的文件浏览与文本编辑（沙箱、敏感文件保护、写审计） |
| `shard` | 分片配置（地上 / 洞穴） |
| `console` | 控制台日志流、命令下发与维护公告 |
| `mod` | 创意工坊 Mod 下载、文件落位与同步、版本检查（是否有新版本）与名称补全 |
| `backup` | 实例存档备份与恢复、外部存档导入、数据库快照 |
| `schedule` | 计划任务（定时备份 / 重启 / 更新检查 / 数据库快照） |
| `notify` | 通知渠道（钉钉 / 企业微信 / 飞书 / Server 酱 / PushPlus / 通用 Webhook / Telegram）与阈值检查 |
| `node` | 本地节点心跳与列表；远程节点管理属于规划中的能力，当前未实现 |
| `system` | 系统设置、面板更新、面板端口与健康检查；**成员与角色（RBAC）**：角色 CRUD、成员 CRUD、实例授权分配，见同目录 `rbac-service.ts` / `rbac-routes.ts` 与 `server/src/shared/db/rbac-repository.ts` |

新增模块时同步更新本表；模块划分与边界变更请同时更新内部文档 `docs_local/ARCHITECTURE.md`（不在公开仓库内）。

## 组织建议

- 每个模块独立目录，避免跨模块直接访问内部实现。
- 模块内建议分层：`controller -> service/usecase -> domain -> repository`。
- 模块对外仅暴露 `index.ts` 注册入口（路由、依赖注入）。
- 需要访问 Docker、systemd、SteamCMD 等外部系统时，走 `../infra/` 的适配器，不在模块内直接调用。
