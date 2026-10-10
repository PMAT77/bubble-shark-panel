# panel.env 内存预设

按宿主机 **总内存（MemTotal）** 选用预设，写入 `panel.env` 中的 **可选** 子容器内存上限与安装守卫参数。  
新安装默认按总内存合并对应预设；升级保留已有 `panel.env` 与手动配置。硬上限按需使用，不预留内存；实例可分别设置主世界、洞穴上限。

| 预设文件 | 适用总内存 | 说明 |
|----------|------------|------|
| `small.env` | 约 4 GiB（&lt; 5 GiB） | 每片 3072 MiB；双世界与较重 Mod 配置需观察共享 swap 和宿主机余量 |
| `medium.env` | 约 6 GiB（5–8 GiB） | 每片 4096 MiB；建议保留 swap，并按实际峰值调整 |
| `large.env` | ≥ 8 GiB | 默认不设硬上限；可按需取消注释 |

## 用法

**安装脚本自动档位**（默认 `BSP_PANEL_ENV_PRESET=auto`）：

```bash
sudo bash ./scripts/install.linux.sh
# 显式指定：sudo BSP_PANEL_ENV_PRESET=small bash ./scripts/install.linux.sh
```

**已安装后手动合并**（保留现有 `panel.env`，追加预设行）：

```bash
sudo bash -c 'cat /opt/bubblesharkpanel/config/panel.env.presets/small.env >> /opt/bubblesharkpanel/panel.env'
# 安装脚本会将预设同步到 PANEL_INSTALL_DIR/config/panel.env.presets/
cd /opt/bubblesharkpanel
sudo docker compose --env-file panel.env -f docker-compose.yml -f docker-compose.bind.yml up -d
```

完整说明见 [docs/MEMORY.md](../../docs/MEMORY.md)。
