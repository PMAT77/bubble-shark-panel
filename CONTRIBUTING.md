# 参与贡献

感谢关注 BubbleSharkPanel。本文说明如何有效地提交 Issue 与 Pull Request。

---

## 开始之前

1. 阅读 [README.md](README.md) 了解项目定位（当前为 **v0.x 公测**，DST 优先）
2. 大改动请先开 [Issue](https://github.com/PMAT77/bubble-shark-panel/issues) 讨论，避免重复劳动
3. 本地开发环境（Node 版本、`pnpm install`、数据库与迁移、开发栈启动方式）在 `docs_local/DEVELOPMENT.md`（内部文档，不在公开仓库内）；面向使用者的部署方式见 [Docker 模式安装](docs/install-docker.md) 与 [Native systemd 模式安装](docs/install-native.md)

---

## 报告 Bug

使用 [Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.yml)，并尽量提供：

- 操作系统与 Node / Docker 版本
- 复现步骤
- 期望行为 vs 实际行为
- 相关日志（脱敏后）

安全问题请勿公开 Issue，见 [SECURITY.md](SECURITY.md)。

---

## 提交 Pull Request

### 1. Fork 与分支

```bash
git checkout -b feat/your-topic
# 或 fix/your-topic
```

### 2. 本地检查

```bash
pnpm install
pnpm run release:check
```

本地、普通 CI 与 tag CI 共用质量门禁，包含前后端构建。后端迭代可单独运行 `pnpm test:server`。

改动数据库 schema 后运行 `pnpm run db:generate`，将生成的迁移一并提交；CI 另行检查迁移漂移。安装器检查在本地缺少 bash 时显示跳过，在 CI 中必须执行。

### 3. 变更范围

- **保持 PR 聚焦**：一个 PR 解决一类问题
- **匹配现有风格**：Composition API、TypeScript、现有目录约定
- **不要提交**：`panel.env`、`.env*` 凭据、本地 SQLite、`docs_local/`、密钥

### 4. 提交信息

Conventional Commits，中文 subject 示例：

```text
fix(auth): 强制改密流程补全路由注册
docs(release): 添加版本发布说明
chore(ci): 统一本地与发布质量门禁
```

### 5. CHANGELOG

用户可见变更请写入 [CHANGELOG.md](CHANGELOG.md) 的 **`[Unreleased]`** 小节（`feat` / `fix` / `Security` 等）。

### 6. 打开 PR

使用 [PR 模板](.github/pull_request_template.md)，说明动机、测试方式与关联 Issue。

---

## 文档贡献

文档与代码同等重要，改动文档时请遵守：

- **语言与排版**：遵循[中文技术文档写作规范](https://github.com/ruanyf/document-style-guide)；中文与英文、数字之间留一个半角空格，并列词用顿号，一个句子构件尽量不超过 40 字。
- **文件名**：新增文档用小写字母加连字符（如 `advanced-usage.md`）；现有文档沿用原文件名（`install-docker.md`、`install-native.md`、`reference.md` 等），以免破坏外部链接与锚点。
- **跨文档引用用锚点**：写成 `[标题](install-docker.md#锚点)`，不要写“见 XXX 第 8 章”这类会随标题漂移的引用。
- **本地校验**：提交前运行 `pnpm run docs:check`，它会校验相对链接、锚点、版本 tag 与索引同步。

## Code Review 原则

维护者会关注：

- 行为是否正确、边界是否处理
- 是否引入不必要的抽象或范围膨胀
- 测试是否覆盖真实逻辑（非琐碎断言）
- 文档与 CHANGELOG 是否同步

---

## 行为准则

参与本项目即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

---

## 许可证

贡献代码以 [MIT License](LICENSE) 发布；你保留对原创内容的版权。
