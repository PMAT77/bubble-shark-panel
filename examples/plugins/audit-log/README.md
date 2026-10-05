# Pro 插件：操作审计日志

把面板的**用户操作审计**按天归档成可交付的文件，可选推送到另一块盘，并对敏感操作与被拒的写操作告警。

## 为什么需要它

面板本身已经能查操作审计（左侧菜单「插件」页下方的操作记录，以及 `GET /app/system/audit/operations`），但它有两个边界：

1. **审计文件有保留上限**（默认 2 万条，超出丢最旧的一半）——长期留存需要外部归档；
2. **审计和存档通常在一块盘上**——盘坏了两样一起没了，这恰恰是最需要审计的时刻。

这个插件补的就是这两点：归档 + 异地留存 + 敏感操作告警。

## 它做什么

| 动作 | 说明 |
| --- | --- |
| 归档 | 每 5 分钟拉一次新记录，按 UTC 日期写成 `archive/YYYY-MM-DD.ndjson`（或 `.csv`） |
| 增量 | 用审计记录 id 作游标，只归档新记录，不会重复写 |
| 远端 | 配置 `remoteDir` 后把归档文件推过去，先写 `.part` 再改名，不留半成品 |
| 告警 | 命中敏感路径（删备份、重置世界、踢人封禁、改配置、启用插件…）**或任何被拒的写操作**时 POST 到 webhook |
| 可交付 | NDJSON 便于程序处理，CSV 便于直接交给客户或审计方 |

参数摘要在面板侧已脱敏（token / password / secret 等记成「已隐去」），归档文件继承同一份内容。

## 安装与启用

```bash
cp -r examples/plugins/audit-log /var/lib/bubblesharkpanel/plugins/
# 放入 plugin.signature.json（发布方提供），然后在左侧菜单「插件」启用
```

启用需要三条同时满足：

1. 清单声明 `operations:read`（以及 `network:outbound`、`storage:kv`）；
2. `plugin.signature.json` 签名有效；
3. 授权文件包含 **`audit-log`**——缺授权时面板显示「缺授权（操作审计日志）」，不会静默不工作。

## 配置（`config.json`，首次运行自动生成）

```json
{
  "intervalSeconds": 300,
  "fetchLimit": 500,
  "format": "ndjson",
  "sensitivePathPatterns": [
    "/app/instance/backup/delete",
    "/app/instance/delete",
    "/app/instance/shards/reset",
    "/app/instance/backup/restore",
    "/app/instance/player",
    "/app/system/plugins/toggle",
    "/app/account/password"
  ],
  "alertWebhook": "",
  "remoteDir": ""
}
```

| 字段 | 说明 |
| --- | --- |
| `format` | `ndjson`（默认，便于程序处理）或 `csv`（便于交付） |
| `sensitivePathPatterns` | 路径包含这些片段就告警；**任何 `denied`（401/403）的记录也会告警** |
| `remoteDir` | 另一台机器挂载过来的目录；留空则只在本机归档 |
| `alertWebhook` | 告警地址，POST JSON `{ source, at, level, message, record }` |

## 运行期产物

| 文件 | 内容 |
| --- | --- |
| `archive/YYYY-MM-DD.ndjson` | 按天归档的可交付审计文件 |
| `state.json` | 游标（`lastSeenId`）、累计归档条数、最近一次运行时间与失败原因 |
| `plugin.log` | 每轮的结论 |

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 面板显示「缺授权（操作审计日志）」 | 授权文件不含 `audit-log` | 重新签发 |
| `state.json` 的 `lastError` 含「无法连接宿主能力服务」 | 面板重启中或插件与面板版本不匹配 | 重启面板；确认插件 `apiVersion` 与面板一致 |
| 归档目录一直是空的 | 面板侧还没有写操作记录 | 随便做一个写操作（例如改一次设置）再看 |
| 远端没有文件 | `remoteDir` 未配置或不可写 | 检查挂载与权限；`lastError` 会写明原因 |
| 告警太吵 | `sensitivePathPatterns` 命中面太大 | 精简模式列表；被拒操作的告警建议保留 |

## 面向开发者

- 能力调用：`POST /capabilities/operations`，body `{ pluginId, account?, limit? }`，请求头 `x-bsp-plugin-token`；
- 归档是**纯逻辑**（`runOnce(config, state)`），因此测试直接 import 它逐个覆盖格式与远端推送，而进程生命周期由宿主测试覆盖；
- 网络异常被收敛成结构化错误（`status: 0`）而不是抛出：插件不该因为一次连不上就变成"崩溃"记录。
