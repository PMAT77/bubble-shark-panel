# Game Server Hub — Standalone 迁移日志

本仓库已从 fantastic-admin 母仓独立，**不再与其同步**；本仓是唯一开发源。本文仅作历史记录与独立化收尾清单。

## 基线

| 项 | 值 |
|----|-----|
| 源路径 | `apps/game-server-hub`（母仓 fantastic-admin） |
| 源 commit | `64f359aba20a98b23180fa35646eb4a116954df3` |
| 复制日期 | 2026-05-17 |
| 副本路径 | `apps/game-server-hub-standalone` |

## 现状

- **开发源**：本仓。业务功能不再回同步到母仓。
- **框架依赖**：内嵌 `packages/{components,settings,types,themes,copyright}` 与自包含 `uno.config.ts`，不依赖母仓 `packages/*` 与根 `uno.config.ts`。
- **UI**：保持 FA 布局/主题 + Naive 业务页，不替换 `Fa*`、不重构 `layouts/`。

## 独立化收尾清单

- [x] `src/views/index.vue` 中 fantastic-admin Git 外链已移除
- [x] 镜像统一为 `ghcr.io/pmat77/game-server-hub`
- [x] 包名为 `game-server-hub`

## Git 分支

- **`main`**：唯一长期分支，也是可部署基线。仓库已不再使用 `develop`。
- **`feature/*` / `fix/*`**：改动在临时分支上做，通过 PR 合入 `main`。
- CI（`.github/workflows/ci.yml`）在 PR 与推送到 `main` 时运行；只推临时分支不会产生检查结果，PR 才是拿到门禁的路径。
- 发布：`main` 上的提交通过门禁后打 `v*` tag，[`docker-publish.yml`](.github/workflows/docker-publish.yml) 会要求该 commit 已在 `main` 上，见 [docs/RELEASE.md](docs/RELEASE.md)。
- 数据库：改 schema 后 `pnpm db:generate`，同 commit 提交 `server/drizzle/`；不提交 `*.sqlite`。
