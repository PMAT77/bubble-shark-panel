# Game Server Hub

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/PMAT77/game-serve-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/PMAT77/game-serve-hub/actions/workflows/ci.yml)
![Public Beta](https://img.shields.io/badge/status-Public%20Beta-orange)

面向 Steam 专用服务器的开源运维面板。当前以《饥荒联机版》（DST）为首个完整适配游戏，提供安装、更新、启停、监控、日志、控制台、世界和 Mod 管理。

## 面向用户

- **已经有一台服务器的服主** —— 云主机、家里的小主机都行：不必为开服换机器或买预装镜像，也不被某一家云厂商或面板服捆绑。
- **个人服主** —— 不想再开一堆 SSH 窗口改 ini、手动重启世界；想在浏览器里管世界、Mod、玩家名单、存档与定时备份。
- **小团队 / 游戏社区** —— 需要多实例并存与操作可追溯；面板已内置成员与角色：给每个运维建子账号、分配角色，并限定各自能管哪些实例。
- **托管商 / 集成方** —— 多节点统一管理属于规划中的 Pro 插件；也可直接联系做定制集成（见文末）。

**正在开发中的功能**：

- **玩家事件统计**：聊天日志与在线时长统计仍在规划中（在线玩家列表、踢出与封禁已经可用）。
- **多语言界面**：未提供，界面与文档均为简体中文。
- **插件页面注册协议**：插件宿主已交付（清单与签名校验、独立进程、回环能力服务、调用审计），但**插件还不能往面板里添加自己的界面**，插件包的在线分发渠道也未提供，当前由发布方人工交付、在面板内导入。插件页在侧边栏暂不显示，直接访问 `/plugins` 可打开。
- **组织 / 租户与 SSO**：属规划中的 Pro 插件。成员与角色支持到「一个账号一个角色 + 一批可见实例」；再往上的按组织分权、按房间授权与 SSO 留在这里（判据是"签下托管商客户后再做"）。

如果你需要组织 / 租户级权限隔离，或者要在 Windows 上开服，**建议同时看看同类面板**，例如 [DMP 饥荒管理平台](https://github.com/miracleEverywhere/dst-management-platform-api) 或 [DST Admin Go](https://github.com/carrot-hu23/dst-admin-go)：它们的部署更简单；本项目更适合已经有一台服务器、不想被云厂商绑定、希望自行长期维护的场景。

## 已上线功能

- **一键开服与更新** —— 图形化创建实例，SteamCMD 自动安装与更新，地上 / 洞穴双分片一键拉起。
- **世界与 Mod 管理** —— 房间参数、世界生成配置、创意工坊 Mod 在线订阅与开关；**世界地形图**一键导出（读的是游戏自己算出来的地形）；存档点回档与重置世界前会自动创建安全备份。
- **玩家管理与准入** —— 独立的「玩家管理」页面：按游戏名维护管理员、白名单与黑名单（也支持粘贴玩家 ID），查看地上 / 洞穴的在线玩家并踢出或封禁；封禁立刻生效，房间重启后依然有效。
- **成员与角色** —— 给每个运维建子账号。**能力与范围分开**：角色决定能做什么，实例授权决定能在哪些实例上做。子账号登录后只看到自己该看的东西，操作记录里也能分清是哪个账号做的。
- **文件与配置** —— 在浏览器里浏览实例目录、直接编辑房间与世界配置文件、上传下载单个文件，保存或覆盖前自动备份；集群令牌等敏感文件不可读写。
- **实时掌控** —— CPU / 内存 / 磁盘 / 网络监控，SSE 实时日志，游戏控制台直接下发命令。
- **出问题能自查** —— 环境自检一键检查运行环境、磁盘余量、数据目录可写、实例状态与通知渠道；控制台日志落盘，可查看历史与下载。
- **存档与备份** —— 定时备份、面板数据库快照、导入既有存档。
- **两种部署方式** —— Docker Compose 或裸机 systemd，按你的隔离预期选。
- **升级安全** —— 同模式原地升级，升级前自动备份数据库，保留实例、存档和自定义配置。

## 快速开始

当前为 `v0.10.0` 公测线。装法与环境要求见安装手册：[Docker 模式](docs/install-docker.md) · [Native systemd 模式](docs/install-native.md)；参数与变量速查见[参数速查](docs/reference.md)。

## 开源与规划

本项目采用 [MIT License](LICENSE)，**Community 核心功能永久开源免费。**

## 常见问题

安装报错、端口与连接问题见[参数速查](docs/reference.md)与[安装手册](docs/install-docker.md)；升级会不会丢存档、重跑安装脚本会不会清空数据、能不能从其他面板迁过来，见[安装手册 · 常见错误](docs/install-docker.md#常见错误)。

## 交流与反馈

![QQ 群：1055694763](https://img.shields.io/badge/QQ%E7%BE%A4-1055694763-12B7F5?logo=tencentqq&logoColor=white)

公测版本发布、部署安装问题、使用心得与建议都欢迎在群里讨论。

- **部署 / 配置 / 使用问题** → 群里问最快，也方便互相参考
- **可复现的 Bug、明确的功能请求** → 提 [Issue](https://github.com/PMAT77/game-serve-hub/issues)，不会被聊天记录冲掉，后续也好跟进

## 参与贡献

欢迎提交 [Issue](https://github.com/PMAT77/game-serve-hub/issues) 与 [Pull Request](https://github.com/PMAT77/game-serve-hub/pulls)；流程与规范见 [CONTRIBUTING.md](CONTRIBUTING.md)，本地开发环境与门禁命令在 `docs_local/DEVELOPMENT.md`（内部文档，不在本仓库），安全问题见 [SECURITY.md](SECURITY.md)。

后端基于 Fastify 与 Drizzle ORM，前端基于 Vue 3、Vite 与 Fantastic-admin。感谢这些项目及所有贡献者。

## 赞助与商业合作

项目主要利用业余时间维护。如果它帮你省下了时间，可以请我喝杯咖啡。

<table>
  <tr>
    <td align="center"><img src="https://cdn.jsdelivr.net/gh/PMAT77/PMAT77CDN@main/imgs/common/collection_wechat.jpg" alt="微信赞助" width="200" /><br />微信赞赏</td>
    <td align="center"><img src="https://cdn.jsdelivr.net/gh/PMAT77/PMAT77CDN@main/imgs/common/WeChat.jpg" alt="微信联系：PMAT77" width="195" /><br />微信：PMAT77</td>
  </tr>
</table>

**联系方式**

- 微信：`PMAT77`（上方二维码）
  - 添加时请**备注来意**，建议格式 `身份 / 需求 / 规模`，例如 `个人服主 / DST 开服 / 20 人`、`托管商 / 定制插件 / 多节点`
- 功能问题与 Bug 见[交流与反馈](#交流与反馈)。项目由我利用业余时间维护、平日有主业在身，回复可能不够及时，但看到都会回

### 付费服务

Community 核心永久免费。另提供部分收费服务，价格参考区间如下，实际按机器环境与工作量确认后报价：

| 服务 | 交付物 | 参考价 |
| --- | --- | --- |
| **代搭建（单机）** | 面板安装 + 实例创建 + 开服验证 + 端口/安全组清单 + 交接说明 | 50～200 元/次 |
| **存档与面板迁移** | 从裸机或其他面板迁到本面板：存档、集群配置、Mod 清单与端口一一对应，迁完能进服 | 150～400 元/次 |
| **私有化部署** | 内网 / 代理受限 / 无公网环境的部署与反向代理，含离线镜像包与校验流程 | 500～1000 元/次 |
| **适配其他游戏** | 复用安装、分片、Mod 与控制台链路适配其他 Steam 专用服务器 | 按需求评估 |
| **功能定制开发** | 按你的玩法或运营需求实现专属功能，交付形式按需求商定 | 1500～10000 元/项目 |


## 许可证

Community 源代码采用 [MIT License](LICENSE)：

```text
Copyright (c) 2026 Game Server Hub
SPDX-License-Identifier: MIT
```

**Game Server Hub** — 让开服像点一下那么简单。
