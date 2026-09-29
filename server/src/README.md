# Server 目录说明

Node.js 后端代码位于本目录。前端在 `../src/`，前后端共享契约在 `../shared/`，公开文档在 `../docs/`。

## 环境变量

后端独立读取 `server/.env.*`（例如 `server/.env.development`），启动时由 zod 统一校验；完整清单、默认值与解析逻辑见 `shared/config/index.ts`。常用键：

- `SERVER_HOST`、`SERVER_PORT`
- `DB_PATH`、`SERVER_LOG_DIR`、`LOG_LEVEL`

生产部署时，面板进程的配置来自 `panel.env`（Docker 模式由 compose 注入，Native 模式由 systemd `EnvironmentFile` 注入），模板见仓库根目录 `panel.env.example`。

## 顶层结构

- `modules/`：业务模块，见 [modules/README.md](modules/README.md)
- `shared/`：后端跨模块共享能力，见 [shared/README.md](shared/README.md)
- `infra/`：外部系统适配层，见 [infra/README.md](infra/README.md)
- `../server/drizzle/`：Drizzle 迁移文件（由 `drizzle-kit generate` 生成）

## 数据库迁移

在**仓库根目录**执行：

- `pnpm run db:generate`：基于 `server/src/shared/db/schema/index.ts` 生成迁移
- `pnpm run db:migrate`：执行迁移
- `pnpm run db:studio`：打开 Drizzle Studio

改 schema 后，请在同一次提交里包含 `server/drizzle/` 下的迁移文件；CI 会做 schema 漂移检查。

## 本地开发

- `pnpm run dev:prepare`：创建数据目录与日志目录（建库与迁移在后端启动时进行）并初始化工作区组件
- `pnpm run dev`：同时启动前端与后端（内部会先跑 `dev:prepare`）

## Linux 生产安装

- `sudo bash ./scripts/install.linux.sh --mode docker|native`，或 `pnpm run install:linux`
- 参数与行为以 `sudo bash ./scripts/install.linux.sh --help` 为准；面板默认端口 `9527`
- 安装、升级、回滚、卸载与排错见 [docs/install-docker.md](../docs/install-docker.md)（Docker 模式）与 [docs/install-native.md](../docs/install-native.md)（Native systemd 模式）；安装器参数与 `panel.env` 变量速查见 [docs/reference.md](../docs/reference.md)

## 分层约定

- 调用链：`controller -> service/usecase -> domain -> repository/infra adapter`
- 业务模块不得直接调用 `dockerode`、执行 `docker` 命令或拼接 systemd 单元，基础设施细节只存在于 `infra/` 的对应 Adapter 中（见内部文档 `docs_local/ARCHITECTURE.md`）
- 避免跨模块深层引用；公共能力统一沉淀到 `server/src/shared/*`
