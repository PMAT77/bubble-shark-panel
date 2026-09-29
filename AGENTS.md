# AGENTS.md

在任何任务中都会加载本文件，所以它只记代码里读不出来的信息。请保持精简。

**优先级**：用户的指令 > 本文件 > 任何 skill 的指引。若某条指引让你停手、请求确认或偏离用户意图，先确认是不是本文件或某个 skill 造成的，并指名具体文件与那句话。

## 读代码

不要为了改动先去通读文档或整张仓库地图。改某个模块时，优先看它旁边的 README：

- `server/src/README.md`（后端分层）、`server/src/modules/README.md`、`server/src/infra/README.md`、`server/src/shared/README.md`
- `shared/README.md`（前后端契约与错误码）、`src/hotkeys/README.md`

需求含糊或涉及架构边界时，再查 `docs_local/ARCHITECTURE.md`（内部文档，不在公开仓库内）。文档按需取用，不做通读要求。

## 验证

先跑针对本次改动的最小检查，例如相关的单测或检查脚本。准备 PR 前跑一次 `docs_local/DEVELOPMENT.md`（内部文档，不在公开仓库内）里的门禁命令即可，不必每步都跑全套。

改动小且可逆时，不需要为了“再确认一次”而扩大测试范围。

## 自动化授权

以下是不必事先征求同意的操作：

- 本地检查与测试：它们使用一次性夹具，不接触生产环境，直接运行、修复本次改动导致的失败、重跑受影响的检查。
- 只读排查：读日志、查数据库结构、查 git 历史。
- 不涉及生产数据与发布产物的代码改动，包括顺手修掉明显笔误。

需要先说明再动手的：初始化或重建 `data/` 下的数据库、改动 `panel.env.example` 与安装脚本的默认值、发布 tag。

## 边界

- 不要提交 `panel.env`、`.env*` 凭据、本地 SQLite、`docs_local/`、密钥文件；`*.example` 模板可以提交。
- Windows 仅用于本机开发，生产目标是 Linux，不要为 Windows 部署加兼容代码。
- 表结构变更必须用 `pnpm run db:generate` 生成迁移，不能只改 schema。

以上是仓库约定，不是需要逐次批准的事项。

## 提交

Conventional Commits，中文 subject，细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。用户可见的变更写进 CHANGELOG.md 的 `[Unreleased]` 小节。
