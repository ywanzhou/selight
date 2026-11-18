# Input Hardening Plan（backlog I2/I3/I4/I6）

> **For agentic workers:** 单分支 `feat/input-hardening` 连续 TDD，合并一个 `--no-ff`。Steps use checkbox (`- [ ]`)。

**Goal:** 关闭 backlog 高优先四项：双实例 SQLITE 竞争、键盘导航脱视口、非法文件夹名、跨批次/软删 folder 归属。

**Spec:** `docs/superpowers/specs/2026-11-16-post-mvp-backlog.md` 高优先 #1–#4。

## Global Constraints

- 只读原则、工厂 electron-free、禁 `as any`、弱断言；验证顺序 typecheck → 受影响测试 → 全量 `npm test` + build。
- 不改 schema 版本（busy_timeout 是 PRAGMA 非 DDL）。
- 提交英文 conventional commits + Co-Authored-By。
- 纯逻辑全部下沉 bare-node 可测；Electron app 级行为（单实例锁、Grid 滚动）只做最小接线，靠类型/构建与既有 harness 兜底。

## Tasks

### Task 1 — I3: busy_timeout PRAGMA + 单实例锁
- `schema.ts` init 加 `db.pragma('busy_timeout = 5000')`；测试在 `tests/db/schema.test.ts` 读回 `db.pragma('busy_timeout', {simple:true})` 断言 5000。
- `main.ts` 模块级 `const lock = app.requestSingleInstanceLock()`，失败立即 `app.quit()`；成功后 `app.on('second-instance')` 聚焦并恢复主窗口（show+focus，最小化时 restore）。
- 提交 `feat: enforce single instance lock and sqlite busy timeout`。

### Task 2 — I2: 键盘导航滚动跟随
- `gridGeometry.ts` 加纯函数 `anchorRowIndex(anchorIndex, columnCount)`（`Math.floor`，null→null），node 测试先行。
- ThumbPane 的 Grid 挂 ref，`useEffect([anchor, gridKey, photos])` 用 `gridRef.current?.scrollToItem({ rowIndex: anchorRowIndex(orderedIds.indexOf(anchor), 2), align: 'smart' })`；anchor null 不动作。
- 提交 `feat: keep keyboard anchor visible with react-window scrollToItem`。

### Task 3 — I4: 文件夹名领域校验
- `folders.ts` 加 `FolderNameInvalidError` 与纯函数 `validateFolderName(name): string | null`（null=合法；否则返回英文错误码串）：trim 后空、含 `? * | < > " / \`、Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，大小写不敏感、含扩展名前缀）、`.`/`..`。
- createFolder/renameFolder 事务入口先校验，冲突检查保持不变。
- `tests/domain/folders.test.ts` 表驱动覆盖每类非法输入与合法边界（中文名、带空格、保留名带 .txt）。
- 提交 `feat: reject invalid folder names at the domain layer`。

### Task 4 — I6: assignToFolder 归属断言
- classify.ts 事务内、写动作前校验目标 folder：`SELECT batch_id, deleted_at FROM folders WHERE id=?`，不存在/已软删/批次与照片 batchId 不符 → 抛既有 `FolderNotFoundError`。
- `tests/domain/classify.test.ts` 加：软删 folder reject、跨批次 folder reject、正常归属仍成功（含动作行数）。
- 全量回归 + 两 harness + build，提交 `feat: validate folder ownership before classifying photos`。

## Self-Review

- 四项互不共享接口，冲突面只在 folders.ts（Task 3）与 classify.ts（Task 4），无交叉。
- I4 只做领域拒绝与既有 alert 呈现，统一通知组件是 backlog #8 不在本批。
- 单实例锁无自动化测试面（Electron app 生命周期），计划内接受，靠代码审查与手工验证。
