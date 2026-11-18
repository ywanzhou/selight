# 导出改 JSON 清单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把导出产物从「按文件夹复制原文件」替换为单个 `selight-manifest` JSON 清单文件，供精修同事的 Python 脚本按清单取片。

**Architecture:** 新增 electron-free 的 `electron/manifest.ts`（组装 + 落盘，bare Node 可测），旧 `electron/exporter.ts` 整删。IPC 面整体换名（保存文件对话框 + manifest 写入），preload/main/假 API 表三处同步；渲染层对话框从「复制进度」改为「结果统计」。不碰 schema、分类领域逻辑与磁盘只读原则。

**Tech Stack:** TypeScript strict、better-sqlite3、node:fs/path、Electron `dialog.showSaveDialog`、Vitest（node 环境）。

**Spec:** `docs/superpowers/specs/2026-11-18-export-manifest-design.md`

## Global Constraints

- 不执行 `git add/commit/push`：用户未发话前改动留工作区；当前已在 `feat/export-manifest` 分支（含 spec 与 backlog 改动，未提交）。
- 代码标识符/注释英文，UI 文案中文；不新增运行时依赖；Vitest node 环境，禁止 jsdom。
- `SelightHandlers` 加/删方法后，preload、main 注册、`tests/renderer/store.test.ts` 的 `HANDLER_NAMES` 必须三处同步（CLAUDE.md §3）。
- 涉及 preload 改动，最后必须 `npm run build`，且真机验证前需完全重启应用（HMR 加不出新桥接）。
- 验证顺序：`npm run typecheck` → 受影响测试 → `npm test` → `npm run build`。
- 取片小工具与 Python 示例脚本明确不在本期（backlog 中优先 #10）。

## File Structure

- Create: `electron/manifest.ts` — 清单类型、`toPosix`/`safeFileName`/`buildManifest`/`writeManifest`/`exportManifest`
- Create: `tests/manifest.test.ts` — 真实临时 sqlite 的领域测试
- Delete: `electron/exporter.ts`、`tests/exporter.test.ts`
- Modify: `electron/shared/api.ts` — 类型、通道常量、handler/api 接口换名
- Modify: `electron/ipc.ts` — 删 `onExportProgress` 注入与 exportBatch，接 exportManifest
- Modify: `electron/main.ts` — showSaveDialog 注册、exportManifest 注册、lastExportDir 语义改 dirname
- Modify: `electron/preload.ts` — 桥接换名，删 onExportProgress
- Modify: `src/state/store.ts` — thunk 与 AppStore 接口换名
- Modify: `src/App.tsx` — 保存文件流程、ExportRun 形状
- Modify: `src/components/ExportDialog.tsx` — 去进度条，改结果统计
- Modify: `src/components/Toolbar.tsx` — 导出 tooltip 文案
- Modify: `tests/ipc.contract.test.ts`、`tests/renderer/store.test.ts`、`tests/smoke/fullflow.test.ts`

## Review Focus

1. 保存对话框取消（返回 null）时流程静默结束无弹窗；用户未输入 `.json` 后缀时代码补全——Electron dialog 无法 bare-node 测，进 Task 2 真机清单。
2. 目标路径无写权限/只读时 `writeManifest` 的 reject 必须冒泡到 `App.tsx` 的 alert，不许静默——真机清单核对报错文案。
3. `openPath` 守卫新语义：`lastExportDir` 从「选的目录」变成「目标文件的 dirname」，「打开所在目录」必须传 dirname 才能过 containment，传文件路径会被自身守卫拒绝——代码走查 + 真机。
4. 结果弹窗 `missingCount > 0` 的告警提示与三个统计数（文件夹/照片/missing）——组件无 DOM 测试，真机目检。
5. preload 新桥接只在 build+完全重启后生效，运行旧 preload 会报 `window.selight.xxx is not a function`——交付说明必须强调重启。

---

### Task 1: manifest 领域层（TDD，纯新增不碰旧链路）

**Files:**
- Create: `electron/manifest.ts`
- Test: `tests/manifest.test.ts`

**Interfaces:**
- Consumes: `openDatabase`（tests 夹具）、`createBatch`/`getBatch`（domain/batches）、`createFolder`（domain/folders）、`upsertPhoto`/`listPhotos`（domain/photos）；sources 表无 domain 函数，测试照 `tests/domain/photos.test.ts:48-53` 的 `addSource` 直接 insert
- Produces（全部从 `electron/manifest.ts` 导出，`electron/shared/api.ts` 在 Task 2 re-export）:
  - `export interface ManifestPhoto { sourceId: number; path: string; absPath: string; filename: string; sizeBytes: number; missing: boolean }`
  - `export interface ManifestFolder { id: number; name: string; photos: ManifestPhoto[] }`
  - `export interface ManifestSource { id: number; root: string }`
  - `export interface Manifest { kind: 'selight-manifest'; version: 1; batch: { id: number; name: string; exportedAt: string }; sources: ManifestSource[]; folders: ManifestFolder[] }`
  - `export interface ManifestResult { targetPath: string; folderCount: number; photoCount: number; missingCount: number }`
  - `export function toPosix(p: string): string`
  - `export function safeFileName(name: string): string`
  - `export function buildManifest(db: Database, batchId: number, now: number = Date.now()): Manifest`
  - `export function writeManifest(targetPath: string, manifest: Manifest): Promise<void>`
  - `export async function exportManifest(db: Database, batchId: number, targetPath: string, now?: number): Promise<ManifestResult>`

- [ ] **Step 1: 写失败测试** `tests/manifest.test.ts`，夹具照 `tests/domain/photos.test.ts`（tempDb + addSource + upsertPhoto，afterEach 关库清目录），固定 `now = new Date(2026, 10, 18, 15, 0).getTime()`：
  - `toPosix`：`'a\\b\\c.ARW' → 'a/b/c.ARW'`；已是正斜杠时不变。
  - `safeFileName`：`'婚礼?a*b' → '婚礼_a_b'`（覆盖 `\\ / : * ? " < > |` 全字符）；纯空白/空串 → `'manifest'`。
  - `buildManifest` 空批次：`kind/version` 正确，`sources/folders` 为 `[]`，`batch.id/name` 来自 getBatch，`exportedAt` 是 `new Date(now).toISOString()`。
  - 多 source + 嵌套：两个 source root，照片分别在 root 下一级与 `sub/nested/` 下；断言 `path` 为正斜杠相对路径（如 `sub/nested/d.arw`）、`sourceId` 与各自 source 关联、`absPath` 保留原值、`missing` 为 boolean。
  - 排除规则：inbox 照片、trash 照片不进任何 folder；无照片的文件夹不出现在 `folders`；软删文件夹不出现。
  - missing：`upsertPhoto` 后 `markMissing`（或直接 update missing=1）的照片 `missing: true`，其余 false。
  - `writeManifest`：写到临时目录后 `JSON.parse(fs.readFileSync(...,'utf8'))` 深等于 manifest；文本以 `\n` 结尾、2 空格缩进；同目录无 `.tmp` 残留。
  - `exportManifest`：组合落盘，返回 `{ targetPath, folderCount, photoCount, missingCount }` 计数与夹具一致。
- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL，模块不存在。
- [ ] **Step 3: 实现 `electron/manifest.ts`**
  - `toPosix`：`p.split(path.sep).join('/')`（Windows sep 为 `\\`；posix 平台 split 无副作用）。
  - `safeFileName`：`/[\\/:*?"<>|]/g → '_'`，trim 后为空返回 `'manifest'`。
  - `buildManifest`：getBatch 取批次名（undefined 抛 Error，与 exporter 对批次存在的隐含前提一致）；直接 prepare 查 `SELECT id, abs_path FROM sources WHERE batch_id=? ORDER BY id`；listFolders 复用 domain 函数，每 folder 用 `listPhotos(db, batchId, {kind:'folder', folderId})`，空则跳过；`path = toPosix(path.relative(sourceRoot, photo.absPath))`，sourceId 在 sources 中查不到属于数据不一致，抛错而非静默。
  - `writeManifest`：`fs.promises.writeFile(targetPath + '.tmp', JSON.stringify(manifest, null, 2) + '\n', 'utf8')` 后 `rename`；照 `electron/sessionStore.ts` 的 sibling-tmp 模式。
  - `exportManifest`：build → write → 统计 folderCount/photoCount 与 missingCount（reduce）。
- [ ] **Step 4: 跑测试确认 GREEN**

Run: `npx vitest run tests/manifest.test.ts`
Expected: 全过。
- [ ] **Step 5: 类型检查（旧链路仍在，应全绿）**

Run: `npm run typecheck`
Expected: 零错误。

---

### Task 2: 替换整条导出链路（桥接、渲染层、旧代码删除、测试改写）

本任务不可再分：桥接换名后渲染层与测试必须同轮改完，否则 web tsconfig 编译断。按步骤顺序执行，最后统一跑门禁。

**Files:** 见 File Structure 全部 Modify/Delete 项。

**Interfaces:**
- Consumes: Task 1 的 `exportManifest(db, batchId, targetPath, now?)` 与 `ManifestResult`
- Produces: `SelightApi` 新面——`pickExportFile(suggestedName: string): Promise<string | null>`、`exportManifest(batchId: number, targetPath: string): Promise<ManifestResult>`；删除 `pickExportDirectory`、`exportBatch`、`onExportProgress`

- [ ] **Step 1: `electron/shared/api.ts` 契约换名**
  - 删 `ExportResult` re-export、`ExportProgressEvent` 接口；加 `export type { ManifestResult } from '../manifest'`。
  - `SelightHandlers`/`SelightApi`：删 `exportBatch`、`onExportProgress`、`pickExportDirectory`；加 `exportManifest(batchId: number, targetPath: string): Promise<ManifestResult>` 与 `pickExportFile(suggestedName: string): Promise<string | null>`（注释写明也 armed openPath 守卫）。
  - `IPC_CHANNELS`：删 `exportBatch`/`exportProgress`/`dialogPickExportDirectory`；加 `exportManifest: 'selight:export:manifest'`、`dialogPickExportFile: 'selight:dialog:pick-export-file'`；`shellOpenPath` 保留。
- [ ] **Step 2: `electron/ipc.ts` handler 工厂改造**
  - 删 `import { exportBatch as runExport }` 与 `HandlerDeps.onExportProgress`（含 deps 解构）；`import { exportManifest as runExportManifest } from './manifest'`。
  - export 段改为 `async exportManifest(batchId, targetPath) { return runExportManifest(db, batchId, targetPath) }`。
- [ ] **Step 3: `electron/main.ts` 原生对话框与注册**
  - import 类型加 `SaveDialogOptions`；删 exportProgress 发送回调（createHandlers 调用处的 `onExportProgress` 参数）、旧 exportBatch 与 dialogPickExportDirectory 两个 ipcMain.handle。
  - 新 `dialogPickExportFile` handle：`showSaveDialog(mainWindow, { title: '导出分类清单', defaultPath: suggestedName, filters: [{ name: 'JSON', extensions: ['json'] }] })`（mainWindow 为空时走无窗重载，照现有 openDirectory 模式）；canceled → null；否则取 `filePath`，先对 basename 调 `safeFileName`（目录部分不动），无 `.json` 后缀（大小写不敏感）则补全；`lastExportDir = path.dirname(resolved)`。
  - 默认建议名由渲染层拼：`择影清单-${batchName}-${本地时区 yyyymmdd}.json`（年月日各 padStart 2）；main 侧 safeFileName 是兜底，因为用户可在对话框里改名。
  - 新 `exportManifest` handle：`lastExportDir = path.dirname(path.resolve(targetPath))` 后调 `handlers.exportManifest`。
- [ ] **Step 4: `electron/preload.ts` 桥接**
  - 删 `exportBatch`、`pickExportDirectory`、`onExportProgress` 三个桥接；加同名新通道的 `pickExportFile: (suggestedName) => invoke(...)`、`exportManifest: (batchId, targetPath) => invoke(...)`。
- [ ] **Step 5: 渲染层 `src/state/store.ts`**
  - import 换 `ManifestResult`；thunk 改为 `export async function exportManifest(deps: ThunkDeps, targetPath: string): Promise<ManifestResult | null>`，无打开批次返回 null，否则 `deps.api.exportManifest(batchId, targetPath)`；AppStore 接口同步换名删旧。
- [ ] **Step 6: `src/App.tsx` 流程改造**
  - `ExportRun` 改 `{ targetPath: string; result: ManifestResult | null }`；`handleExport`：先取当前批次名（state.batches find），调 `pickExportFile(safeFileName 后的默认名？——注意 safeFileName 在 electron/manifest，渲染层不可 import electron 目录外的纯函数？manifest.ts import better-sqlite3 类型，渲染层打包会带入类型-only 引用风险。Ruling 见 ledger：默认文件名在 main 侧再 sanitize 一次，渲染层只传 `择影清单-${batchName}-${yyyymmdd}.json` 原始建议名，main 的 pickExportFile 内调 safeFileName 兜底)`；null 直接 return；setExportRun 后 await store 的 exportManifest，结果/异常处理照现状（异常 alert 并关弹窗）。
  - ExportDialog 的 `outputDir` prop 改 `targetPath`，「打开所在目录」调 `openPath(path.dirname(targetPath))`——在组件内用字符串 split（渲染层无 node path）：`targetPath.slice(0, targetPath.lastIndexOf(sep))`，sep 用 `[\\\\/]` 兼容；或 App 传 `targetDir` prop。Ruling：App 计算 `targetDir` 作为 prop 传入，ExportDialog 不碰路径解析。
- [ ] **Step 7: `src/components/ExportDialog.tsx` 改造**
  - props：`{ open; targetPath: string | null; result: ManifestResult | null; onClose() }`；删 done/total state、onExportProgress 订阅、进度条 JSX 与 `.export-progress` 依赖（CSS 类无引用则在 Step 9 清理）。
  - 进行态文案「正在写入清单…」+ 现有 loading 转圈样式（`.preview-loading` 同款 spin 类可复用，不加新 CSS）；结果态：`已导出清单：N 个文件夹、M 张照片`；`missingCount > 0` 时红色 `role="alert"` 行「其中 K 张源文件已丢失，取片时会跳过」；按钮「完成」+「打开所在目录」（调 openPath(targetDir)）。Esc 契约不变（仅结果态可关）。
- [ ] **Step 8: `src/components/Toolbar.tsx` 文案**
  - 导出 icon-btn 的 title/wrap title 改为「导出分类清单」；禁用条件 `nothingToExport` 不变。
- [ ] **Step 9: 删旧代码与死样式**
  - 删 `electron/exporter.ts`、`tests/exporter.test.ts`；grep `exporter|exportBatch|onExportProgress|pickExportDirectory|ExportResult|exportProgress|tb-enrich` 确认 src/electron/tests 零残留；`global.css` 中仅服务旧进度条的规则（`.export-progress`/`.export-count` 等，先 grep 确认无其他引用）删除，`.export-bar` 若随之无引用一并删。
- [ ] **Step 10: 测试改写**
  - `tests/ipc.contract.test.ts`：setup() 删 `onExportProgress` 桩与 `progressCalls`；export describe 两个用例重写——(a) 正常夹具：写临时目标文件，`handlers.exportManifest` 返回 `{ folderCount:2, photoCount:3, missingCount:0, targetPath }`，read+parse 断言 folders 名称集合、旅行组只有 c.webp、trash 的 d.arw 不在清单、sources/root 与 path 为 posix；(b) missing 夹具：rm 源文件后（注意 manifest 不读盘，missing 标记来自 DB，需经 markMissing 路径或直接断言 DB 中 missing=1 的照片入清单且 `missing:true`——照现有用例的造数方式调整，删文件对 manifest 结果无影响这一点要在注释说明）；通道探针用例改断言新两个通道常量与 `SelightApi['pickExportFile']`/`['exportManifest']` 结构探针，删 progress 订阅探针。
  - `tests/renderer/store.test.ts`：HANDLER_NAMES 换名（删三个加两个，`base.onExportProgress` 赋值行删除）；两个 export thunk 用例改写为 exportManifest（no-op 不调桥接；正常调用透传 batchId 与 targetPath 并回传 result）。
  - `tests/smoke/fullflow.test.ts` 第 7 段（默认 skip）：import 换 `exportManifest`；断言改为 parse 清单后的 folder 数==expectedGroups、各组 photo 数、trashedNames 不在清单、源语料 size/mtime 不变的既有断言保留；exportDir 临时目录改为 exportFile 路径。
- [ ] **Step 11: 全量门禁**

Run: `npm run typecheck && npm test && npm run build`
Expected: 类型零错误；417 项左右测试全过（exporter 测试换 manifest 测试，总数随用例数变化，1 个 smoke skip 不变）；build 三端成功。
- [ ] **Step 12: 真机目检清单**（`npm run dev` 前完全重启应用）
  - 导出按钮 tooltip「导出分类清单」；保存对话框默认文件名含批次名与日期、filters 只显示 JSON；取消时无弹窗无残留。
  - 手输无后缀文件名落盘自动补 `.json`；用无权限路径（如 Windows 根目录或只读目录）触发报错，alert 显示错误。
  - 结果弹窗三个统计数正确；造一张 missing 照片验证红色告警；「打开所在目录」定位到文件所在文件夹且 openPath 守卫生效。
  - 清单内容目检：正斜杠相对路径、中文 UTF-8 无乱码、回收站照片不在内。
