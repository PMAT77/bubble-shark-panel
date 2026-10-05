# 示例插件：调用记录播报

一个可直接放进面板运行的示例插件，用来演示插件与宿主之间的全部约定。它**不做任何破坏性操作**：只读取实例列表与自己的调用记录，把结果写进插件目录。

## 装上试试

```bash
# 1. 复制到面板数据目录下的 plugins/
#    Native：      /var/lib/bubblesharkpanel/plugins/
#    Docker：      docker cp ./audit-reporter <面板容器>:/app/data/plugins/
cp -r examples/plugins/audit-reporter /var/lib/bubblesharkpanel/plugins/

# 2. 在左侧菜单打开「插件」，点「刷新列表」，然后启用它
```

启用后：

- 插件目录下会出现 `summary.json`（它读到的实例与自己的调用记录）与 `plugin.log`（它的输出）；
- 「插件」页会显示它的进程状态（这个示例跑完就退出，因此是「已正常退出」）；
- 同页下方的「插件调用记录」里能看到它调用过 `instances:list`、`audit:self`，每条都带耗时与结果。

## 这个示例演示了什么

| 约定 | 位置 |
| --- | --- |
| 清单字段与能力声明 | `plugin.json`：`id`、`version`、`apiVersion`、`kind`、`entry`、`capabilities` |
| 从环境变量取身份与地址 | `plugin.mjs` 顶部：`BSP_PLUGIN_ID`、`BSP_CAPABILITY_URL`、`BSP_PLUGIN_TOKEN`、`BSP_PLUGIN_API_VERSION` |
| 调用宿主能力 | `callCapability()`：`POST /capabilities/<能力>`，请求头 `x-bsp-plugin-token`，body 带 `pluginId` |
| 退出语义 | 处理完 `process.exit(0)` → 宿主记为「已正常退出」且不重启；常驻插件则监听 `SIGTERM` 后退出 |
| 输出去哪 | 插件目录下的 `plugin.log`（宿主流转写入，不混进面板日志） |

## 几个容易踩的点

1. **不要硬编码能力服务地址**：端口每次面板启动都不同，只能从 `BSP_CAPABILITY_URL` 读。
2. **没有令牌就别想调通**：令牌是宿主注入的一次性凭证，插件不能自己"申请"，也不该试图写进配置文件。
3. **越权调用会被记账**：声明了 `console:read` 才能读日志；没声明就拿 403，而且这次尝试会出现在「插件调用记录」里。这是有意的——插件行为需要对管理员可见。
4. **想让插件能启停实例**：在清单里加 `instances:lifecycle`。这类危险能力在面板启用时需要管理员确认，每次调用都会记审计。
5. **商业插件（`kind: "commercial"`）必须带签名**：`plugin.signature.json` 由发布方提供，用与授权同一套公钥验签。自己写着玩用 `community` 即可，不需要签名。

## 从示例到真插件

想做一个「存档异地备份」或「多节点巡检」插件，思路是一样的：

1. 先用只读能力（`instances:read`、`metrics:read`、`console:read`）把数据取出来；
2. 把结果写到插件自己的目录或通过 `network:outbound` 发到你的对象存储 / 告警平台；
3. 需要改实例状态时再加 `instances:lifecycle`，并接受"启用需确认 + 每次调用留痕"这两条约束。
