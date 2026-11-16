# 择影（selight）MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建本地桌面照片筛选应用择影：导入源文件夹、键盘/拖拽把照片分到批次内的文件夹或回收站、支持批量与撤销、原文件只读、可按文件夹导出复制。

**Architecture:** Electron 三进程结构。主进程持有 better-sqlite3 数据库与媒体管线（扫描、RAW 预览提取、缩略图队列、导出）；领域逻辑写成不依赖 Electron 的纯模块，Vitest 直接在 Node 下 TDD；渲染进程 React 通过 preload 暴露的类型化 IPC API 操作数据，自定义安全 protocol 提供图片。

**Tech Stack:** Electron + electron-vite + React 18 + TypeScript 5；better-sqlite3；exiftool-vendored；jpeg-autorotate；nativeImage（Electron 内置）；react-window；Vitest；electron-builder。

**Spec:** `docs/superpowers/specs/2026-11-13-zeying-design.md`（计划与规格配套，执行时两份都读）

## Global Constraints

- 运行环境 Windows 11，Node v24.11.0 / npm 11.6.1；路径一律 `path.join`，禁止硬编码分隔符
- 受支持扩展名（小写匹配）：直读 `.jpg .jpeg .png .webp`；RAW `.arw .cr2 .cr3 .nef .dng .raf .rw2 .orf .pef .srw`
- 原文件永远只读：任何代码路径不得对 `photos.abs_path` 指向的文件执行写入/移动/删除；导出只能复制
- 数据库路径 `app.getPath('userData')/selight.db`；缩略图缓存 `userData/thumbnails/<photoId>.jpg`；RAW 预览缓存 `userData/previews/<photoId>.jpg`
- macOS 视觉令牌（仅浅色）：主文字 `#1D1D1F`、次要文字 `#6E6E73`/`#86868B`、分隔线 `0.5px rgba(0,0,0,.10)`、系统蓝 `#007AFF`、系统红 `#FF3B30`、系统橙 `#FF9500`；侧栏底色 `rgba(240,240,243,.8)`
- 全部图标为 SF Symbols 风格单色线性 SVG（内联组件），禁止 emoji 充当图标
- 界面文案中文；字体栈 `-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Segoe UI", sans-serif`
- better-sqlite3 是原生模块，安装后必须 `electron-rebuild`（或 electron-builder install-app-deps）才能在 Electron 内加载
- 领域模块（`electron/domain/`、`electron/db/`）不得 import `electron` 包，保证 Vitest 裸 Node 可测
- 每个任务结束时提交一次，commit 用 Conventional Commits 英文短句
- 测试数据库一律用临时文件（`os.tmpdir()` 下），不得碰 userData 或真实素材

## Review Focus

1. **竖拍方向转反**（EXIF 6 与 8 互换会让 30% 照片躺反）：Task 9 用纯函数测试钉死 1/3/6/8 → 旋转角度映射，Task 19 用真实竖拍 ARW 样本闭环。
2. **protocol 路径穿越**：`selight://` 若接受任意绝对路径，等于本地文件泄露口。Task 10 测试只允许访问 DB 在册路径与两个缓存目录，`..`/未在册路径返回 403。
3. **原文件被写**：Task 8 测试扫描全程以只读 flag 打开文件；Task 17 导出测试断言源文件 mtime/size 不变且输出目录外无写入。
4. **重复导入产生重复行**：Task 5/8 测试同批次同路径二次 upsert 不新增行、更新 mtime 后刷新元数据。
5. **重启后撤销失效 / 删文件夹撤销后照片指向幽灵文件夹**：Task 7 关闭重开数据库后仍可撤销，且删文件夹撤销会连带复活文件夹（名称、sort_order 还原）。

---

## Phase 0 — 脚手架

### Task 1: 项目脚手架与工具链

**Files:**
- Create: 仓库根 `package.json`、`electron.vite.config.ts`、`tsconfig*.json`、`.gitignore`、`electron/main.ts`、`electron/preload.ts`、`src/main.tsx`、`src/App.tsx`、`vitest.config.ts`

**Interfaces:**
- Produces: `npm run dev`（electron-vite 启动空窗口）、`npm test`（Vitest）、`npm run typecheck`、`npm run build`

- [ ] **Step 1: git init 并初始化 electron-vite + React-TS 模板**

用 electron-vite 的 react-ts 模板生成；`.gitignore` 含 `node_modules/ dist/ out/ .superpowers/ samples/`。

- [ ] **Step 2: 安装依赖并处理原生模块**

依赖：`better-sqlite3`、`exiftool-vendored`、`jpeg-autorotate`、`react-window` 及其类型；dev 依赖：`vitest`、`@types/better-sqlite3`、`@electron/rebuild`。安装后跑 `npx electron-rebuild -f -w better-sqlite3`。

- [ ] **Step 3: 配置 Vitest（node 环境，含 tests/ 目录）与 typecheck 脚本**

`vitest.config.ts`：`environment: 'node'`、`include: ['tests/**/*.test.ts']`；写一个冒烟测试 `tests/smoke.test.ts` 断言 `1+1 === 2`。

- [ ] **Step 4: 验证三条命令**

Run: `npm test` → 1 passed；`npm run typecheck` → 零错误；`npm run dev` → 弹出带标题「择影」的空窗口。

- [ ] **Step 5: Commit**

`chore: scaffold electron-vite react-ts project with vitest`

---

## Phase 1 — 数据库与领域逻辑（裸 Node TDD，不涉及 Electron API）

### Task 2: 数据库 schema 与打开/迁移

**Files:**
- Create: `electron/db/schema.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Produces:
  - `openDatabase(file: string): BetterSqlite3.Database` — 打开文件库，启用 `PRAGMA foreign_keys=ON`、`journal_mode=WAL`，执行 DDL，写入 `PRAGMA user_version`
  - 表：`batches, sources, folders, photos, actions`，列定义严格按 spec §5（含 `photos.orientation` 默认 1、`actions.batch_id_group` 与 `undone`、所有软删/唯一约束）

- [ ] **Step 1: 写失败测试** — 临时文件库上断言五张表存在；`sqlite_master` 中包含 `UNIQUE(batch_id, abs_path)` 索引；二次 `openDatabase` 同文件不报错且数据还在（建一行 batches 后重开验证）；损坏库（写入垃圾字节）打开时捕获 SqliteError，把坏库复制为 `selight.db.corrupt-<时间戳>` 后重建空库并返回 `{db, recovered: true}`。
- [ ] **Step 2: Run** `npx vitest run tests/db/schema.test.ts` → FAIL（模块不存在）。
- [ ] **Step 3: 实现** `schema.ts`：DDL 字符串 + user_version 迁移骨架（v1 直接建表）；`openDatabase` 返回 `{ db, recovered }`，recovered 时由上层向渲染进程发提示通知。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: add sqlite schema and database open/migration`

### Task 3: 批次领域模块

**Files:**
- Create: `electron/domain/batches.ts`
- Test: `tests/domain/batches.test.ts`

**Interfaces:**
- Consumes: `openDatabase`
- Produces:
  - `interface BatchRow { id:number; name:string; createdAt:number; lastOpenedAt:number }`
  - `createBatch(db, name?: string): BatchRow` — 缺省名 `YYYY-MM-DD`（本地日期），同时更新 `lastOpenedAt`
  - `listBatches(db): BatchRow[]` — 按 `lastOpenedAt` 倒序
  - `touchBatch(db, id: number): void`
  - `getBatch(db, id: number): BatchRow | undefined`

- [ ] **Step 1: 写失败测试** — 缺省名等于当天日期；连建两个后 list 顺序为最近打开在前；touch 更新时间戳。
- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现**（better-sqlite3 prepared statements，时间戳用 `Date.now()`）。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: add batch domain module`

### Task 4: 文件夹领域模块

**Files:**
- Create: `electron/domain/folders.ts`
- Test: `tests/domain/folders.test.ts`

**Interfaces:**
- Consumes: batches
- Produces:
  - `interface FolderRow { id:number; batchId:number; name:string; sortOrder:number; createdAt:number; deletedAt:number|null }`
  - `createFolder(db, batchId, name): FolderRow` — `sortOrder` 取同批次未删最大值 +1
  - `renameFolder(db, id, name): void`
  - `softDeleteFolder(db, id): void` — 置 `deletedAt`
  - `listFolders(db, batchId): FolderRow[]` — 仅未删，按 sortOrder
  - 同批次同名（未删）冲突时抛 `FolderNameConflictError`（自定义 Error 子类）

- [ ] **Step 1: 写失败测试** — 新建 sortOrder 递增；中文名/长名正常；同名冲突抛错；软删后同名可再次创建、list 不返回已删项。
- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现**（冲突检查 + INSERT/UPDATE 放同一事务）。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: add folder domain module with soft delete`

### Task 5: 照片入库与视图查询

**Files:**
- Create: `electron/domain/photos.ts`
- Test: `tests/domain/photos.test.ts`

**Interfaces:**
- Consumes: batches, folders
- Produces:
  - `type PhotoStatus = 'inbox'|'folder'|'trash'`
  - `type View = {kind:'inbox'} | {kind:'folder'; folderId:number} | {kind:'trash'}`
  - `interface PhotoInput { batchId:number; sourceId:number; absPath:string; filename:string; ext:string; sizeBytes:number; mtime:number; orientation:number }`
  - `interface PhotoRow extends PhotoInput { id:number; width:number|null; height:number|null; thumbPath:string|null; previewPath:string|null; status:PhotoStatus; folderId:number|null; missing:number; createdAt:number; updatedAt:number }`
  - `upsertPhoto(db, input: PhotoInput): { row: PhotoRow; created: boolean }`
  - `listPhotos(db, batchId:number, view: View): PhotoRow[]` — 按 absPath 排序
  - `counts(db, batchId): { total:number; inbox:number; folder:number; trash:number }`
  - `markMissing(db, batchId:number, existingPaths: Set<string>): number` — 返回标记行数

- [ ] **Step 1: 写失败测试** — 新照片默认 inbox；同批次同 absPath 二次 upsert `created=false` 且不增行；改 mtime 后 upsert 刷新该行；三个 view 的过滤条件正确（folder 视图只返回该 folderId 且 status=folder）；counts 数值正确；markMissing 对不存在路径置 missing=1 并返回条数。
- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现**（`INSERT ... ON CONFLICT(batch_id, abs_path) DO UPDATE`）。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: add photo upsert and view queries`

### Task 6: 分类动作（分配/回收站/恢复）与动作日志

**Files:**
- Create: `electron/domain/classify.ts`
- Test: `tests/domain/classify.test.ts`

**Interfaces:**
- Consumes: photos, folders
- Produces:
  - `assignToFolder(db, photoIds:number[], folderId:number): number` — 返回处理行数
  - `moveToTrash(db, photoIds:number[]): number` — trash 时 `folder_id` 保留原文件夹用于恢复
  - `restoreFromTrash(db, photoIds:number[]): number` — 原文件夹仍存在（未软删）则回原文件夹，否则回 inbox
  - 三者各自在一个事务内：更新 photos + 向 `actions` 追加同组记录（共享 `batch_id_group`，单张操作也独占一组），逐行写 `from_status/from_folder_id → to_status/to_folder_id`

- [ ] **Step 1: 写失败测试** — 分配后照片离 inbox、目标文件夹计数 +1；同一次 100 张调用只产生 1 个 group；trash 保留 folder_id；恢复回原文件夹；删掉原文件夹后恢复回落 inbox；每次调用后 actions 行数等于照片数。
- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现**（事务 + 组 id 用 `max(batch_id_group)+1`，序列按 batch 隔离）。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: add classification actions with grouped action log`

### Task 7: 撤销引擎

**Files:**
- Create: `electron/domain/actions.ts`
- Test: `tests/domain/undo.test.ts`

**Interfaces:**
- Consumes: classify 写入的 actions 表
- Produces:
  - `undoLastGroup(db, batchId:number): boolean` — 无未撤销组返回 false；否则整组回滚：每张照片恢复 `from_status/from_folder_id`、置 `undone=1`；若组内目标/来源涉及软删文件夹，则连带还原其 `deletedAt`（复活）或重新软删，保持名称与 sort_order 不变

- [ ] **Step 1: 写失败测试** — 单张分配撤销后回 inbox；批量分配一次 Ctrl+Z 整组回滚；连续撤销按组倒序；撤销删文件夹：照片回 inbox 且文件夹复活、名称与 sortOrder 与删除前一致；`restoreFromTrash` 也可被撤销回 trash；**关闭数据库再 openDatabase 后撤销仍有效**；全部撤完返回 false。
- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现**（单事务；组内若出现文件夹软删/复活，先对涉及的 folder id 去重再统一处理）。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: add grouped undo engine persisting across restarts`

---

## Phase 2 — 扫描与媒体管线

### Task 8: 目录扫描器

**Files:**
- Create: `electron/scanner.ts`
- Test: `tests/scanner.test.ts`

**Interfaces:**
- Consumes: `upsertPhoto`、`markMissing`、`ExifReader`（本任务定义接口，实现 Task 9 给）
- Produces:
  - `interface ScannedFile { absPath:string; filename:string; ext:string; sizeBytes:number; mtime:number; orientation:number }`
  - `interface ExifReader { readOrientation(absPath:string, ext:string): Promise<number> }`
  - `scanDirectory(root: string): Promise<ScannedFile[]>` — 递归、只收 Global Constraints 扩展名（小写）、跳过无权限文件并记录路径不中断
  - `importScanned(db, batchId:number, sourceId:number, files: ScannedFile[]): { added:number; updated:number; missing:number }`

- [ ] **Step 1: 写失败测试** — 在 `os.tmpdir()` 建夹具树（嵌套子目录、jpg/arw/txt/大写 `.JPG`/空目录）；断言递归命中、扩展名过滤、大写扩展名归一；用 stub `ExifReader`（返回固定 orientation）跑 `importScanned`，断言 added 数量；二次导入 added=0；删掉夹具中一个文件后重扫，missing 计数 +1；测试中以只读 flag 打开源文件（`fs.openSync(path,'r')`），代码里禁止出现写模式打开。
- [ ] **Step 2: Run** → FAIL。
- [ ] **Step 3: 实现**（`fs.promises.readdir({withFileTypes})` 递归；reader 失败时 orientation 回落 1，不阻断）。
- [ ] **Step 4: Run** → PASS。
- [ ] **Step 5: Commit** `feat: add recursive photo scanner and import pipeline`

### Task 9: EXIF 方向映射与 RAW 预览提取

**Files:**
- Create: `electron/media/orientation.ts`、`electron/media/rawPreview.ts`
- Test: `tests/media/orientation.test.ts`、`tests/media/rawPreview.test.ts`

**Interfaces:**
- Consumes: exiftool-vendored、jpeg-autorotate
- Produces:
  - `orientationToRotate(orientation:number): 0|90|180|270` — 映射：1→0，3→180，6→90（顺时针），8→270；未知值→0
  - `rotateJpegBuffer(buf: Buffer, orientation:number): Promise<Buffer>` — orientation=1 时原样返回
  - `class ExiftoolReader implements ExifReader` — `readOrientation` 走 exiftool；`extractPreview(absPath:string): Promise<Buffer>` 提取内嵌 JPG（ThumbnailImage 优先，回落 PreviewImage）
  - `ensureRawPreview(photo: PhotoRow, cacheDir: string): Promise<string>` — 提取→按 orientation 旋转→写 `cacheDir/<id>.jpg`，已存在则直接返回路径

- [ ] **Step 1: 写失败测试（orientation 纯函数）** — 四个合法值与两个未知值（0、9）的断言，钉死 6→90、8→270 不互换。
- [ ] **Step 2: Run** → FAIL → 实现 `orientation.ts` → PASS。
- [ ] **Step 3: 写失败测试（rawPreview，exiftool 打桩）** — 注入 fake exiftool 返回固定 JPEG buffer 与 orientation=6，断言输出文件存在、经过旋转模块调用、重复调用不重复提取（缓存命中）；提取抛错时向上传 `RawPreviewError`（自定义 Error），由调用方降级。
- [ ] **Step 4: Run** → FAIL → 实现 → PASS。
- [ ] **Step 5: Commit** `feat: add orientation mapping and RAW embedded preview extraction`

### Task 10: 缩略图队列与安全媒体 protocol

**Files:**
- Create: `electron/media/thumbnails.ts`、`electron/media/protocol.ts`
- Test: `tests/media/protocol.test.ts`（队列部分用手动步进的假队列测优先级）

**Interfaces:**
- Consumes: `ensureRawPreview`、Electron `nativeImage`、`protocol.handle`
- Produces:
  - `class MediaQueue { enqueue(photoIds:number[]): void; prioritize(photoIds:number[]): void; onIdle(cb): void }` — 并发 2 的异步队列，prioritize 的 id 插队首
  - `ensureThumbnail(photo: PhotoRow, cacheDir:string): Promise<string>` — RAW 走 `ensureRawPreview` 的产物再 `nativeImage.createFromBuffer().resize({width:320})`；直读格式 `nativeImage.createThumbnail({filePath,size:320})`，orientation≠1 的 JPEG 先 `rotateJpegBuffer` 再 resize；输出 `thumbnails/<id>.jpg`；任何提取/解码失败（含 `RawPreviewError`、missing=1）不抛断，落一张文件类型占位缩略图并在返回值标记 `placeholder: true`
  - `registerMediaProtocol(db: Database, roots: {thumbDir:string; previewDir:string}): void` — 注册特权 scheme `selight://`，路由 `thumb/<photoId>`、`photo/<photoId>`；只允许 DB 在册 abs_path 与两个 roots 下的文件，其余返回 403

- [ ] **Step 1: 写失败测试（protocol 鉴权，不启动 Electron，抽出纯函数 `resolveMediaPath(db, roots, host, photoId): string | null` 单测）** — 在册 id 返回路径；不存在 id、含 `..` 的 id、abs_path 指向 roots 之外的照片直读请求：photo 路由允许在册源文件、thumb 路由只允许 thumbDir，越界一律 null。
- [ ] **Step 2: Run** → FAIL → 实现解析函数与 protocol 注册壳 → PASS。
- [ ] **Step 3: 写队列测试** — 假 worker 下 enqueue 顺序、prioritize 插队、单 id 不重复入队。
- [ ] **Step 4: 实现 thumbnails 与队列 → 测试 PASS。
- [ ] **Step 5: Commit** `feat: add thumbnail queue and sandboxed media protocol`

### Task 11: IPC、preload 与主窗口

**Files:**
- Create: `electron/ipc.ts`、修改 `electron/preload.ts`、`electron/main.ts`
- Test: `tests/ipc.contract.test.ts`（handler 纯逻辑部分抽出为可注入 db 的函数测试，不启动窗口）

**Interfaces:**
- Produces（preload 暴露 `window.selight`，全部 Promise 化）：
  - 批次：`listBatches() / createBatch(name?) / openBatch(id)`（openBatch 调 touchBatch 并返回该批次全量状态）
  - 文件夹：`listFolders() / createFolder(name) / renameFolder(id,name) / deleteFolder(id)`
  - 照片：`importDirectory(rootPath) / listView(view) / counts() / mediaUrl(photoId, kind:'thumb'|'photo') / markSelection(ids)`（后者把 id 送 MediaQueue.prioritize）
  - 分类：`assign(photoIds, folderId) / trash(photoIds) / restore(photoIds) / undo()`
  - 导出：`exportBatch(outputDir)`，进度走 `webContents.send('export:progress', {done,total})`
- [ ] **Step 1: 写失败测试** — 对每个 handler 对应的纯函数做一轮契约测试（临时库：建批次→建文件夹→导入夹具→分配→counts 变化→undo 回滚），等于端到端领域串联。
- [ ] **Step 2: Run** → FAIL → 实现 ipc.ts 与 preload contextBridge（contextIsolation 开启，禁用 nodeIntegration）→ PASS。
- [ ] **Step 3: main.ts** — 单窗口、`userData/selight.db` 打开、注册 protocol、缓存目录初始化；`npm run dev` 启动后在 DevTools 控制台能 `await window.selight.createBatch()` 并查到返回。
- [ ] **Step 4: Commit** `feat: wire IPC contract, preload bridge and main window`

---

## Phase 3 — 渲染进程界面

### Task 12: 设计令牌、App 外壳与工具栏

**Files:**
- Create: `src/styles/tokens.css`、`src/styles/global.css`、`src/App.tsx`、`src/components/Toolbar.tsx`、`src/state/store.ts`
- Test: 无单测（纯展示），验证靠 Step 3 手工清单

**Interfaces:**
- Consumes: `window.selight.*`
- Produces:
  - `store.ts`：React context + useReducer，状态形状 `{ batchId, view: View, selection: number[], folders, photos, counts }`，动作 `refresh()` 重新拉 listView/counts/listFolders
  - 三栏 flex 外壳（左 200px / 右 264px，中间弹性），毛玻璃侧栏、0.5px 分隔线、全局令牌按 spec 色板
  - Toolbar：批次下拉 + 新建批次、导入文件夹、导出、右侧「已分 X / 共 Y」+ 细进度条

- [ ] **Step 1: 实现 tokens/global + 外壳 + Toolbar**（按钮/分段控件样式按 v3 草图，无 emoji）。
- [ ] **Step 2: 接 IPC**：导入按钮调 dialog 选目录 → `importDirectory` → refresh；进度文字由 counts 计算 `(total-inbox)/total`。
- [ ] **Step 3: 手工验证** `npm run dev`：建批次、导入 `素材/` 任一子目录，工具栏计数变化、中文文案、浅色 macOS 观感与草图 v3 一致。
- [ ] **Step 4: Commit** `feat: add app shell, design tokens and toolbar`

### Task 13: 左栏虚拟化缩略图网格与多选

**Files:**
- Create: `src/components/ThumbPane.tsx`、`src/components/ThumbCell.tsx`、`src/hooks/useSelection.ts`
- Test: `tests/renderer/selection.test.ts`（useSelection 纯逻辑抽到非 DOM 模块测）

**Interfaces:**
- Consumes: store、`mediaUrl(id,'thumb')`、`markSelection`
- Produces:
  - `useSelection(orderedIds:number[])` 返回 `{selected:Set<number>, toggle(id, {ctrl,shift}), selectAll(), clear(), anchor }` — Ctrl 切换、Shift 区间、Ctrl+A 全选当前视图
  - ThumbPane：react-window `FixedSizeGrid`（columnCount=2），蓝圈对勾=单选锚点、橙圈对勾=多选其余、missing 灰色警告角标；可见 id 变化时调 `markSelection` 预热缩略图

- [ ] **Step 1: 写失败测试** — 纯选择逻辑：ctrl 累加/取消、shift 从 anchor 区间选择、selectAll、切视图清空。
- [ ] **Step 2: Run** → FAIL → 实现 hook → PASS。
- [ ] **Step 3: 实现网格**（固定行高，两列；图片 `loading="lazy"` 由虚拟化天然保证）。
- [ ] **Step 4: 手工验证** — 导入 1000+ 张滚动不卡（DOM 节点数保持在几十个量级），角标颜色正确；当前视图无照片时显示 macOS 风格空状态文案（待分类空：「全部过完了」；文件夹空：「还没有照片，拖进来」）。
- [ ] **Step 5: Commit** `feat: add virtualized thumbnail grid with multi-select`

### Task 14: 中间预览区与全局键盘

**Files:**
- Create: `src/components/PreviewPane.tsx`、`src/hooks/useShortcuts.ts`
- Test: `tests/renderer/shortcuts.test.ts`（快捷键→action 映射纯函数）

**Interfaces:**
- Produces:
  - 大图 contain、左右圆形翻页按钮、底部信息条（文件名/尺寸/大小 + 快捷键提示）
  - 快捷键映射纯函数 `shortcutToAction(key, ctrl, inInput): Action | null`：←/→（或↑/↓）切换、1–9 分配第 N 个文件夹、Delete/Backspace 扔回收站、Ctrl+Z 撤销、Esc 返回 inbox 视图、Ctrl+A 全选；输入框聚焦时返回 null

- [ ] **Step 1: 写失败测试** — 每个键的映射、超过文件夹数量的数字键返回 null、inInput=true 时全 null、Ctrl+Z 不与浏览器默认冲突的 preventDefault 标记。
- [ ] **Step 2: Run** → FAIL → 实现 → PASS。
- [ ] **Step 3: 实现 PreviewPane 与全局监听**（动作后 refresh 并保持选中落在下一张）。
- [ ] **Step 4: 手工验证** — 键盘可完成全部分类流程；RAW 照片显示的是转正后的预览。
- [ ] **Step 5: Commit** `feat: add preview pane and keyboard shortcuts`

### Task 15: 右栏文件夹卡片、回收站与拖拽/二次筛选

**Files:**
- Create: `src/components/FolderCards.tsx`、`FolderCard.tsx`、`TrashCard.tsx`、`InlineNameInput.tsx`
- Test: `tests/renderer/drop.test.ts`（拖放 payload 解析纯函数：`parseDropPayload(dataTransfer): number[]`）

**Interfaces:**
- Consumes: 文件夹/分类 IPC、store
- Produces:
  - 两列卡片网格 + 虚线「新建文件夹」卡（行内输入，Enter/Esc）；右键菜单改名/删除（删除弹确认框，文案写明照片回到待分类）；当前浏览卡片蓝实心、拖拽悬停蓝虚线
  - TrashCard 独占整行红调；拖到卡片 → `assign`/`trash` 后 refresh
  - 点卡片切换 store.view；回收站视图内显示「恢复」按钮调 `restore`；Esc 回 inbox

- [ ] **Step 1: 写失败测试** — payload JSON 解析、非法 JSON 返回空数组；空选择拖放不触发 IPC（在 reducer 层断言）。
- [ ] **Step 2: Run** → FAIL → 实现纯函数 → PASS。
- [ ] **Step 3: 实现卡片与 HTML5 DnD**（dragstart 写 `application/x-zeying-photos` JSON）、右键菜单、行内编辑（聚焦时 useShortcuts 自动让位）。
- [ ] **Step 4: 手工验证** — 拖单张/批量到卡片与回收站、二次筛选挪文件夹、恢复、改名重名报错提示、删文件夹确认后照片回 inbox。
- [ ] **Step 5: Commit** `feat: add folder cards, trash card, drag-and-drop and re-filtering`

### Task 16: 批次切换与会话恢复

**Files:**
- Modify: `src/state/store.ts`、`src/components/Toolbar.tsx`
- Test: `tests/domain/session.test.ts`（持久化内容的领域侧验证）

**Interfaces:**
- Produces: `userData/session.json` 记录 `{ batchId, view }`；启动时恢复；新建/切换批次刷新 store；不同批次的文件夹/照片/回收站严格隔离

- [ ] **Step 1: 写失败测试** — 两个批次各导入同名相对路径文件，互查不到对方数据；切批次后 view 重置为 inbox；session.json 写入/读取往返一致。
- [ ] **Step 2: Run** → FAIL → 实现主进程 session 存取与 IPC → PASS。
- [ ] **Step 3: 工具栏下拉接线；手工验证关闭重开恢复批次与视图。
- [ ] **Step 4: Commit** `feat: add batch switching and session restore`

### Task 17: 导出

**Files:**
- Create: `electron/exporter.ts`、`src/components/ExportDialog.tsx`
- Test: `tests/exporter.test.ts`

**Interfaces:**
- Produces:
  - `exportBatch(db, batchId, outputDir, onProgress:(done:number,total:number)=>void): Promise<{copied:number; failures:string[]}>`
  - 规则：每非空文件夹一个同名子目录；复制**原文件**（RAW 复制原 RAW）；trash 不导出；冲突加 `(1)`、`(2)` 后缀不覆盖；失败入清单不中断

- [ ] **Step 1: 写失败测试** — 临时库 + 临时输出目录：两个文件夹各放照片（含一个 trash），断言子目录名、文件数、trash 未导出；制造同名冲突断言 `xxx (1).jpg`；断言源文件 size/mtime 前后不变；onProgress 最终 done=total。
- [ ] **Step 2: Run** → FAIL → 实现（`fs.promises.copyFile`）→ PASS。
- [ ] **Step 3: ExportDialog 接 `export:progress` 事件显示进度，完成后提供「在资源管理器中打开」（`shell.openPath`）。
- [ ] **Step 4: Commit** `feat: add batch export with conflict suffixes and progress`

---

## Phase 4 — 全量验证与打包

### Task 18: 真实素材全流程冒烟（webp，1871 张规模）

**Files:**
- Create: `tests/smoke/fullflow.test.ts`

- [ ] **Step 1: 写冒烟测试**（指向仓库 `素材/`，路径不存在则 skip）：导入全量 → 断言照片数=文件数、零重复；随机抽 200 张分配、50 张 trash、再 undo 3 次后 counts 符合预期；缩略图队列跑完后抽查 20 个缓存文件存在且可被 nativeImage 解码。
- [ ] **Step 2: Run** → 全绿；记录 2000 张规模下列表滚动与导入耗时到 PR 描述。
- [ ] **Step 3: 手工过一遍**：重启应用恢复现场、导出到临时目录并核对数量。
- [ ] **Step 4: Commit** `test: add full-flow smoke test on real webp corpus`

### Task 19: 真实 RAW 样本闭环（依赖用户提供 samples/）

**Files:**
- Create: `tests/smoke/raw-samples.test.ts`（samples 缺失则 skip）

- [ ] **Step 1: 等用户把 3–5 张样本（含竖拍 ARW、普通 JPG）放入 `samples/`（已 gitignore）。
- [ ] **Step 2: 测试断言**：ARW 预览提取成功；EXIF 6/8 竖拍样本的缩略图与大图宽高方向正确（解码后 width < height）；JPG 直读方向与系统看图一致；thumb 与 photo 两个 protocol 路由方向一致。
- [ ] **Step 3: 手工在应用内核对样本视觉无横置；失败则回 Task 9 修映射。
- [ ] **Step 4: Commit** `test: add RAW sample orientation smoke test`

### Task 20: Windows 打包

**Files:**
- Modify: `package.json`（build 配置）、Create: `build/` 图标资源

- [ ] **Step 1: 配置 electron-builder**：nsis 安装包；`asarUnpack` 含 better-sqlite3 与 exiftool-vendored 的二进制；产品名「择影」。
- [ ] **Step 2: `npm run build` 后在干净环境（脱离 dev 终端）安装运行**：建批次、导入、分类、导出各跑一次；确认 userData 下 db 与缓存目录位置正确。
- [ ] **Step 3: 核对安装包体积，把 exiftool 二进制占用写进交付说明。
- [ ] **Step 4: Commit** `build: configure electron-builder windows installer`

---

## 自检备注（写作时已核对）

- spec §2 全部目标均有任务归属：批次(T3/T16)、导入扫描(T8)、三栏 UI(T12-T15)、文件夹管理(T4/T15)、回收站与恢复(T6/T15)、批量(T6/T13)、撤销(T7)、方向转正(T9/T19)、持久化(T2/T16)、导出(T17)、RAW(T9/T19)、macOS 视觉(T12-T15)。
- 非目标项（深色模式、星级、视频、搜索、列表视图）计划中无对应任务。
- 命名一致性：`View` 联合类型、`PhotoRow`、`batch_id_group`、`mediaUrl(photoId, kind)` 在各任务接口间统一。
- Task 19 依赖外部输入（samples/），阻塞时可先合入其余全部任务，测试保持 skip。
