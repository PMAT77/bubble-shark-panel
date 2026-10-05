# Pro 插件：异地与云备份

把实例存档备份自动同步到另一台机器、WebDAV 或对象存储，并按保留份数清理**远端**旧备份；上传失败会写进状态并可选发告警。

这是第一个真实的 Pro 插件，同时也是插件机制本身的参考实现：它演示了商业插件的签名与授权、写类能力的使用与审计、以及长驻插件的进程模型。

## 它做什么

| 动作 | 说明 |
| --- | --- |
| 定时检查 | 默认每 15 分钟看一次本机是否有新备份 |
| 上传 | 把未上传过的备份推到远端；**流式读取**，几百 MB 的包也不会把内存打满 |
| 远端保留 | 按 `keepRemote` 只保留最近 N 份，更旧的从**远端**删除 |
| 失败可见 | 失败写进 `state.json` 的 `lastError`，可选 POST 到 `alertWebhook` |
| 不碰本机备份 | **清理只作用于远端**：本机备份是回滚的最后一道防线，交给面板自己管 |

## 安装

```bash
# 1. 复制到面板数据目录下的 plugins/
#    Native：/var/lib/bubblesharkpanel/plugins/
cp -r examples/plugins/remote-backup /var/lib/bubblesharkpanel/plugins/

# 2. 放进 plugin.signature.json（由发布方随插件提供；本地自测可自行签发，见下）
# 3. 在左侧菜单打开「插件」→ 刷新列表 → 启用（会申请危险能力，需确认）
# 4. 首次启动会在插件目录生成 config.json，填好 target 后在面板里停用再启用
```

## 配置（`config.json`）

```json
{
  "intervalSeconds": 900,
  "keepRemote": 7,
  "target": {
    "kind": "webdav",
    "url": "https://dav.example.com/bsp-backups",
    "putUrlTemplate": "",
    "dir": "",
    "username": "user",
    "password": "pass"
  },
  "alertWebhook": "https://example.com/alerts",
  "requestTimeoutSeconds": 600
}
```

`target.kind` 三选一：

| kind | 用途 | 关键字段 |
| --- | --- | --- |
| `webdav` | 群晖 / Nextcloud / 坚果云等 WebDAV 目录 | `url`（目录地址）、`username`、`password` |
| `http-put` | 对象存储的预签名 PUT 地址模板 | `putUrlTemplate`，用 `{name}` 占位文件名 |
| `directory` | 另一台机器挂载过来的目录（NFS / SMB / 移动硬盘） | `dir` |

## 启用条件（三条同时满足）

1. 清单声明了所需能力：`backups:read`、`backups:write`、`backups:delete`、`network:outbound`、`storage:kv`；
2. `plugin.signature.json` 签名有效（商业插件必须签名，用与授权同一套公钥验签）；
3. 授权文件里包含 **`remote-backup`** 能力。缺授权时面板会明确显示「缺授权（异地与云备份）」，而不是静默不工作。

本机自测签发：

```bash
pnpm exec tsx scripts/license/generate-keypair.ts          # 生成密钥对（一次）
pnpm exec tsx scripts/license/sign-license.ts \
  --key ~/.bsp-license-keys/license-private.bsp-key \
  --customer "自测" --capabilities remote-backup --days 30 --out license.json
# 私钥对清单签名，生成 plugin.signature.json（签发流程见内部文档 docs_local/license.md）
```

## 运行期产物（都在插件目录下）

| 文件 | 内容 |
| --- | --- |
| `plugin.log` | 插件输出（宿主流转写入），每轮的结论写在这里 |
| `state.json` | 已上传的备份、最近一次运行时间与失败原因 |
| `config.json` | 配置；不存在时自动生成默认值 |

「插件」这一页能看到它的进程状态；下方「插件调用记录」能看到它每次调用宿主能力的审计（读列表、创建备份、删除备份），**包括被拒的越权尝试**。

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 面板显示「缺授权」 | 授权文件不含 `remote-backup` | 重新签发含该能力的许可 |
| 面板显示「装载失败：缺少 plugin.signature.json」 | 没把签名文件复制过去 | 向提供方重新获取插件包 |
| 状态里 `lastError` 是 `HTTP 401/403` | WebDAV 用户名密码错或无写权限 | 检查 `target.username/password` 与目录权限 |
| 一直没上传 | `config.json` 的 `target` 没填 | 填好后在面板停用再启用（配置在启动时读取） |
| 想立刻验证 | 间隔默认 15 分钟 | 临时把 `intervalSeconds` 改成 60 |

## 面向开发者的说明

想改这个插件或照着写自己的：

- 能力调用见 `plugin.mjs` 的 `callCapability()`：`POST /capabilities/<能力>`，请求头 `x-bsp-plugin-token`，body 带 `pluginId`；
- 备份列表返回的是**路径**而不是内容（`/capabilities/backups`），插件与面板同机，自己按需流式读取即可；
- 常驻插件监听 `SIGTERM` 干净退出；宿主停用插件时会发这个信号，超过退避上限的崩溃会停在「进程异常」不再重启；
- 完整能力清单与状态语义见仓库 `docs_local/research/API.md` 的「插件接口」一节（内部文档，不在公开仓库内）。
