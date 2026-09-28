# Shared 目录说明

该目录用于前后端共享的契约与类型定义。

## 目录结构

- `contracts/`：接口请求/响应契约与校验规则（按模块分文件：`auth.ts`、`rbac.ts`、`instance.ts`、`cluster.ts`、`mod.ts`、`backup.ts`、`schedule.ts`、`notify.ts`、`plugin.ts`、`license.ts` 等）
- `constants/`：共享常量与枚举。其中三份是**唯一真源**，改动前先看它们的注释：
  - `permissions.ts`：53 个权限点（`PERMISSION_SPECS`）+ 模块分组。服务端鉴权、菜单 `auth`、前端勾选面板、`scripts/check-route-permissions.mjs` 门禁都从这一份消费；
  - `password.ts`：密码强度规则。改密与"管理员建号/重置密码"共用同一份判定，避免两条路径各自漂移；
  - `error-code.ts`：错误码。
- `types/`：共享 TypeScript 类型

请保持该目录无运行时副作用，便于后续平滑迁移到 Monorepo 根目录复用。
