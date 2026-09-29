# 授权与插件签发（内部工具）

面向 Pro 商业授权的签发流程。脚本都在**你自己的离线环境**里跑，不在客户机器上跑。

| 脚本 | 用途 | 谁执行 |
| --- | --- | --- |
| `generate-keypair.ts` | 生成 Ed25519 密钥对（一次性，`--purpose license\|plugin`） | 你，离线环境 |
| `sign-license.ts` | 签发客户许可 `license.json` | 你，每次成单 |
| `print-fingerprint.ts` | 打印机器指纹 | **客户**，在目标机器上跑 |
| `../plugins/sign-plugin.ts` | 为插件目录签发 `plugin.signature.json` | 你，每次发插件 |

## 〇、两把密钥，别混用（推荐）

授权许可与插件包在信任模型上是两件事：许可按**客户**签发，插件按**发布流程**签发。
混用一把私钥的后果是——一次插件签名失误（误签、私钥保管不当、轮换）会**同时**波及所有客户授权。

```bash
pnpm exec tsx scripts/license/generate-keypair.ts --purpose license   # 授权用
pnpm exec tsx scripts/license/generate-keypair.ts --purpose plugin    # 插件用
```

- 授权公钥 → `GSH_LICENSE_PUBLIC_KEY`
- 插件公钥 → `GSH_PLUGIN_PUBLIC_KEY`（**未配置时会回落到授权公钥**，所以只配一把也能跑）

两个变量都支持一次配多把（逗号或换行分隔），用于密钥轮换期同时信任新旧密钥。

## 一、一次性准备：生成密钥对

```bash
pnpm exec tsx scripts/license/generate-keypair.ts --purpose license
```

- 默认输出到 `~/.gsh-license-keys/`：`license-private.gsh-key`（权限 0600）与同名 `.public.pem`。
- **私钥不要提交、不要上传、不要放进面板部署目录**；`.gitignore` 已排除 `*.gsh-key`，但这只是兜底。
- 把脚本输出的 `GSH_LICENSE_PUBLIC_KEY=<base64>` 放进**构建环境**（发布镜像时注入）与客户部署的 `panel.env`。
- 换密钥 = 所有已签发许可立即失效。私钥要备份到离线介质，并在开始卖之前就定下来。

公钥不是秘密，随构建分发；私钥只在你手里，这是整套机制唯一的信任根。

## 二、客户机器取指纹（可选，仅绑定设备时需要）

让客户在目标机器上执行：

```bash
pnpm exec tsx scripts/license/print-fingerprint.ts
```

指纹由主机名与系统标识算出（容器环境退回数据目录标识）。**不要凭客户口述的机器名手写指纹**——大小写或空格差一点，结果都是「许可无效」，而客户看不出原因。

不绑定设备就不需要这一步：许可文件里 `fingerprint` 为 `null` 时可在任意机器生效，适合按客户（而不是按机器）计价的场景。

## 三、签发许可

```bash
pnpm exec tsx scripts/license/sign-license.ts \
  --key ~/.gsh-license-keys/license-private.gsh-key \
  --customer "某某社区" \
  --capabilities multi-node,audit-log,remote-backup \
  --days 365 \
  --note "订单 2026-001" \
  --out ./某某社区-2026.json
```

- `--capabilities` 取值：`multi-node`、`audit-log`、`remote-backup`、`advanced-rbac`；
- `--days N` 与 `--expires <ISO 时间>` 二选一，都不给即**永久**授权；
- `--fingerprint gsh-xxx` 绑定设备，省略则不绑定。

## 四、签发插件（商业插件必做）

```bash
pnpm exec tsx scripts/plugins/sign-plugin.ts \
  --dir examples/plugins/remote-backup \
  --key ~/.gsh-license-keys/plugin-private.gsh-key \
  --publisher gsh-official
```

- 签名对象是**清单**（`plugin.json`）的规范化 JSON，不是压缩包：tar 的字节随打包工具与时间戳变化，签包体无法复现；而清单已包含 id / version / apiVersion / capabilities 等全部授权相关字段。
- **清单改动后必须重签**，否则面板会以「签名校验失败」拒绝装载（这条有测试钉住）。
- 已有签名时默认拒绝覆盖，加 `--force` 才允许。

## 五、交付给客户

1. 许可 JSON 改名为 `license.json`，放到**面板数据目录**（`Native` 为 `/var/lib/game-server-hub/license.json`，`Docker` 为容器内 `/app/data/license.json`），或用 `GSH_LICENSE_FILE` 指定路径；
2. 客户打开左侧菜单「商业支持与 Pro」即可看到授权状态、已授权能力与到期时间；
3. 续期只需重新签发并覆盖同一个文件；
4. 插件包连同 `plugin.signature.json` 一起交给客户，放进 `<数据目录>/plugins/` 后在面板启用。

## 六、机制边界（对客户要说清楚的三件事）

1. **验签是离线的**：不需要联网，没有授权服务器，也没有「回连检查」。断网环境照样生效。
2. **许可只影响 Pro 插件**：Community 核心功能不因许可缺失、过期或无效而减少，
   **正在运行的游戏实例永远不会因为许可问题被停止**（见 `docs_local/ARCHITECTURE.md` 的 Open-Core 边界）。
3. **到期后**：Pro 插件的操作入口关闭并说明原因；核心与实例继续照常运行，客户随时可以续期，不需要重装。

## 七、排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 「此构建未内置授权公钥」 | 构建或 `panel.env` 里没有 `GSH_LICENSE_PUBLIC_KEY` | 把公钥 base64 写进 `panel.env` 后重启面板 |
| 「许可签名校验失败」 | 文件被编辑过、抄错、或用了另一套密钥签发 | 重新签发，交付时用文件传输而不是复制粘贴正文 |
| 「许可绑定了另一台机器」 | 客户换了机器 / 重装了系统 / 容器未挂持久卷 | 用新指纹重新签发；或改发不绑定设备的许可 |
| 「插件签名校验失败」 | 清单改动后没重签，或用授权私钥签了插件 | 用插件私钥重签（`--publisher` 可核对来源） |
| 「未内置插件签名公钥」 | 既没配 `GSH_PLUGIN_PUBLIC_KEY` 也没配 `GSH_LICENSE_PUBLIC_KEY` | 配置其一；分开用两把时两个都要配 |
| 状态一直是「未安装授权文件」 | 文件位置不对 | 确认路径：面板「商业支持与 Pro」页会显示判定结果 |
| 面板显示已授权但仍无 Pro 功能 | 对应插件未安装或未启用 | 在「插件」页启用；缺授权能力的插件会显示「缺授权」 |
