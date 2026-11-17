# Import Discovery/Enrichment Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把导入关键路径缩减为纯 fs 发现 + 入库（秒回），EXIF/尺寸富化与缩略图生成全部后台化、视口驱动，并补齐中断补偿与就绪事件。

**Architecture:** scanner 退化为 fs-only，`orientation/width/height` 改由进程级单例 `EnrichmentService` 在后台写入（直读格式 sharp.metadata、RAW exiftool，有界双池 + 去重 + 聚合进度）；`openBatch` 按 `width IS NULL` 补偿。导入不再全量入队，缩略图由视口 `prioritize`（修复越级语义）与协议 404 入队双保险驱动，生成完经 `media:ready` 事件让渲染层 nonce 重载。

**Tech Stack:** Electron 44、sharp 0.35、exiftool-vendored、better-sqlite3、React 19、Vitest（bare node）

**Spec:** `docs/superpowers/specs/2026-11-17-media-pipeline-sharp-design.md`（第 5.1/5.3/5.5 节与第 8 节二期；一期已合并）

## Global Constraints

- 从最新 main 切 `feat/import-discovery-enrich`，`--no-ff` 合回，合并信息中文摘要。
- 不改 schema（v2 的 `orientation DEFAULT 1`、可空 `width/height` 已够用）；不改 `resolve.ts` 的 photo 原图路由（三期才切 2048）。
- 富化不变量（spec 第 9 节）：`width IS NULL` 是唯一"未富化"标记，任何富化路径成功必须写尺寸，失败保持 NULL 可重试；不许把失败行写成 0 或默认值。
- 只读原则：源文件只读；测试夹具落 `os.tmpdir()`，`素材/`、`samples/` 永不写入。
- 工厂纪律：`createHandlers` 保持 electron-free，新依赖走 `HandlerDeps` 注入；`SelightApi` 每加一个方法，preload、main 注册、`tests/renderer/store.test.ts` 假 API 三处同步。
- 常量：富化池直读并发 4、RAW 并发 2（集中在 enrich.ts）；展示态尺寸 orientation 6/8 交换宽高。
- 验证顺序 `npm run typecheck` → 受影响测试 → 全量 `npm test`；preload/main 改动后跑 `npm run build`。
- 提交英文 conventional commits + `Co-Authored-By: Claude Code <noreply@anthropic.com>`；禁 `as any`、禁弱化断言。

## Review Focus

1. **重扫覆盖富化结果**：`upsertPhoto` 的 ON CONFLICT 若继续写 orientation，fs-only 扫描会用默认 1 冲掉富化值——Task 1 用"先富化再重扫"的测试钉死 orientation/width/height 三列不被触碰。
2. **富化失败可补偿**：坏文件富化后行保持 `width IS NULL`，`findUnenrichedPhotoIds` 仍能选到它——Task 3 断言失败行可被重新选取，Task 6 断言 openBatch 重新提交。
3. **404 入队风暴**：同一张图未生成时网格可能短时间多次请求 selight://thumb，每次 404 都调 enqueue——Task 5 断言 MediaQueue 的 isKnown 去重使实际 worker 只跑一次。
4. **RAW 富化/缩略图竞争**：width NULL 的 RAW 被视口优先请求时，worker 必须先自愈富化再出图，错误方向不得落缓存——Task 5 用 fake reader 断言先 readImageMeta 后 ensureRawPreview 的顺序。
5. **多批次交错的进度计数**：两次 submit 交错时 done 单调、不超过 total、排空时 done=total——Task 3 用双批次提交断言计数序列。

---

### Task 1: scanner fs-only，入库与 orientation 解耦

**Files:**
- Modify: `electron/scanner.ts`（删 reader 参数与 orientation 字段，ExifReader 接口迁出）
- Modify: `electron/domain/photos.ts`（PhotoInput 删 orientation；upsert 冲突子句不碰 orientation/width/height；新增 findUnenrichedPhotoIds）
- Modify: `electron/media/rawPreview.ts`（承接 ExifReader 接口）
- Modify: `electron/ipc.ts`（importDirectory 调新签名，本任务先传 noop 富化占位让类型绿，Task 6 换真服务）
- Test: `tests/scanner.test.ts`、`tests/domain/photos.test.ts`、`tests/ipc.contract.test.ts`

**Interfaces:**
- Produces: `scanDirectory(root: string): Promise<ScanResult>`；`ScannedFile { absPath; filename; ext; sizeBytes; mtime }`（无 orientation）；`PhotoInput` 同构无 orientation；`findUnenrichedPhotoIds(db: Database, batchId: number): number[]`；`ExifReader` 类型从 `electron/media/rawPreview.ts` 导出。
- Consumes: 无新依赖。

- [ ] **Step 1: 改 scanner.test 为 fs-only 契约（RED）**

删除 fixedReader/failingReader 与两处 orientation 断言；`scanDirectory(root)` 全部去掉第二参；新增用例 `re-import never overwrites enriched orientation/width/height`：手工 `UPDATE photos SET orientation=6, width=10, height=20` 后再跑一次 importScanned，断言三列值不变。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/scanner.test.ts`
Expected: FAIL（参数数量/属性不存在）。

- [ ] **Step 3: 实现 scanner/photos/rawPreview 改动**

scanner 删 `reader` 形参与 orientation 读写；`ExifReader` 接口整体移到 rawPreview.ts（保留 readOrientation，Task 2 扩方法）。photos.ts：PhotoInput 删 orientation，INSERT 不写该列（走 DEFAULT 1），ON CONFLICT 的 UPDATE 集合只留 source_id/filename/ext/size_bytes/mtime/updated_at。新增 findUnenrichedPhotoIds：`SELECT id FROM photos WHERE batch_id=? AND width IS NULL ORDER BY id`。

- [ ] **Step 4: 同步 ipc.ts 与 contract 测试的编译面**

ipc.importDirectory 改调 `scanDirectory(rootPath)`；HandlerDeps 本任务加 `enrichment: { submit: (_ids: number[]) => void }` 占位接口（main.ts 暂传 `{ submit: () => {} }`，Task 6 换真服务），importScanned 后的 ids 改交 enrichment.submit，删掉 thumbQueue.enqueue 行。contract 的 setup 补这个假依赖，queueCalls 断言改为断言 enrichment 收到 ids。

- [ ] **Step 5: photos.test 补 findUnenrichedPhotoIds 用例并跑绿**

NULL/非 NULL 混合行断言只返回 NULL 行且按 id 排序。Run: `npx vitest run tests/scanner.test.ts tests/domain/photos.test.ts tests/ipc.contract.test.ts`，Expected: PASS。

- [ ] **Step 6: typecheck + 提交**

Run: `npm run typecheck`，PASS 后 `git commit -m "refactor: make directory scan fs-only and decouple imports from orientation"`。

---

### Task 2: 展示态尺寸纯函数与 exiftool 元数据读取

**Files:**
- Modify: `electron/media/orientation.ts`（新增 orientDimensions）
- Modify: `electron/media/rawPreview.ts`（ExifReader 加 readImageMeta，ExiftoolReader 实现）
- Test: `tests/media/orientation.test.ts`、`tests/media/rawPreview.test.ts`

**Interfaces:**
- Produces: `orientDimensions(orientation: number, width: number, height: number): { width: number; height: number }`（6/8 交换，其余原样）；`ExifReader.readImageMeta(absPath: string, ext: string): Promise<{ orientation: number; width: number | null; height: number | null }>`。

- [ ] **Step 1: 写 orientDimensions 失败测试（RED）**

orientation.test.ts 加表驱动用例：1/3 不交换、6/8 交换、未知值（0/9）不交换。

- [ ] **Step 2: 跑失败**

Run: `npx vitest run tests/media/orientation.test.ts`，Expected: FAIL（not exported）。

- [ ] **Step 3: 实现 orientDimensions 并跑绿**

- [ ] **Step 4: 写 readImageMeta 失败测试（RED）**

rawPreview.test.ts 用现有 makeFake 模式扩 fake：`read` 返回 `{ Orientation, ImageWidth, ImageHeight }`，断言正常映射、缺 Orientation 回落 1、缺尺寸给 null、非法值（9）回落 1。

- [ ] **Step 5: 实现 readImageMeta 并跑绿**

一次 `exif.read(absPath)` 取三字段，Orientation 走现有 KNOWN_ORIENTATIONS 过滤。Run: 两文件 PASS。

- [ ] **Step 6: 提交**

`git commit -m "feat: add display-dimension mapping and exiftool image metadata read"`。

---

### Task 3: enrichPhoto 与 EnrichmentService 单例

**Files:**
- Create: `electron/media/enrich.ts`
- Test: `tests/media/enrich.test.ts`（真实临时 sqlite，项目既有模式）

**Interfaces:**
- Consumes: Task 1 的 findUnenrichedPhotoIds、Task 2 的 orientDimensions/readImageMeta、`RAW_EXTENSIONS`、sharp。
- Produces:
  - `enrichPhoto(db: Database, id: number, reader: Pick<ExifReader,'readImageMeta'>): Promise<boolean>`（已富化返回 false；成功写三列返回 true；失败 catch 后保持 NULL 返回 false）
  - `class EnrichmentService`：构造 `(db, reader, opts?: { directConcurrency?: number; rawConcurrency?: number; onProgress?: (done: number, total: number) => void })`；`submit(ids: number[]): void`；`stop(): void`。

- [ ] **Step 1: 写 enrichPhoto 失败测试（RED）**

临时 db 插直读格式行（sharp 自产 640x480 夹具，含 EXIF orientation 6）：断言返回 true、行内 orientation=6 且 width<height（展示态交换后 480x640）；重复调用返回 false 且不重复读文件（spy fs/sharp 调用次数）；零字节文件返回 false 且 width 仍 NULL。

- [ ] **Step 2: 实现 enrichPhoto 跑绿**

直读走 `sharp(absPath,{failOn:'none'}).metadata()`；RAW 走 reader.readImageMeta；统一经 orientDimensions 后单条 prepared UPDATE（orientation,width,height,updated_at）。

- [ ] **Step 3: 写 EnrichmentService 失败测试（RED）**

四个用例：① submit 混合 ext 的 id 组，排空后所有直读行 width 非 NULL、RAW 行走 fake reader；② 失败行保持 NULL 且再次 submit 能重新处理（Review Focus #2）；③ 双批次交错 submit 的 onProgress 序列单调、done≤total、末次 done=total（Review Focus #5）；④ stop 后新 submit 不启动任务。

- [ ] **Step 4: 实现 EnrichmentService 跑绿**

内部两个 MediaQueue（directConcurrency 默认 4、raw 默认 2），worker 调 enrichPhoto；submit 先经 findUnenrichedPhotoIds 语义过滤（单条查 width IS NULL）再按 ext 入对应队列，队列 isKnown 承担在途去重；settle 计数后回调 onProgress。

- [ ] **Step 5: typecheck + 提交**

`git commit -m "feat: add singleton enrichment service with bounded pools and progress"`。

---

### Task 4: MediaQueue.prioritize 越级语义修复

**Files:**
- Modify: `electron/media/queue.ts`
- Test: `tests/media/queue.test.ts`

**Interfaces:**
- Produces: `prioritize(ids: number[]): void` 新语义——active 中的 id 跳过；已在 queued 的 id 移动到队首（按传入相对顺序）；全新 id 插入队首；每次都触发 pump。

- [ ] **Step 1: 改测试表达新语义（RED）**

现有 `inserts fresh ids at the front and skips ids already queued or running` 用例改期望：`prioritize([1,2,5])` 在 pending=[2,3]、1 active 时，新 pending 为 [2,5,3]（2 越级到最前，1 不动）；补一个用例：重复 prioritize 同一批已排队 id 会把它们整体提到队首。

- [ ] **Step 2: 跑失败**

Expected: FAIL（旧实现 isKnown 过滤，2 留在原位）。

- [ ] **Step 3: 实现并跑绿**

prioritize 内先过滤 active，再对 queued 做 splice 移除后 unshift 合并，保持 enqueue 的 pump 调用。

- [ ] **Step 4: 全量 queue 测试 + 提交**

`npx vitest run tests/media/queue.test.ts` 全绿后 `git commit -m "fix: let prioritize re-rank ids already waiting in the queue"`。

---

### Task 5: 协议 404 入队、缩略图就绪事件与 RAW 自愈

**Files:**
- Modify: `electron/media/resolve.ts`（判别联合返回）
- Modify: `electron/media/protocol.ts`（签名换 onThumbMissing，清理一期 M6 死参数）
- Modify: `electron/media/thumbnails.ts`（createThumbnailQueue 加 onReady，worker 内 RAW 自愈）
- Modify: `electron/main.ts`（protocol 第三参接 thumbQueue.enqueue；queue 加 onReady 发送占位，Task 6 接真事件）
- Test: `tests/media/protocol.test.ts`、`tests/media/thumbnails.test.ts`

**Interfaces:**
- Produces:
  - `type ResolveResult = { ok: true; file: string } | { ok: false; reason: 'forbidden' } | { ok: false; reason: 'not-generated'; id: number }`
  - `registerMediaProtocol(db, roots, onThumbMissing: (id: number) => void): void`
  - `createThumbnailQueue(db, roots, reader?, onReady?: (id: number, ok: boolean) => void): MediaQueue`

- [ ] **Step 1: 改 protocol.test 为判别联合（RED）**

现有 null 断言拆成 forbidden（坏 id、missing、逃逸）与 not-generated（行存在但缓存缺失，带 id）两类；补 Review Focus #3：连续三次对同一未生成 id 解析，onThumbMissing 被调三次但接真实 MediaQueue 时 worker 只执行一次（用真队列 + 假 worker 计数）。

- [ ] **Step 2: 实现 resolve/protocol**

resolveMediaPath 改返回 ResolveResult；protocol 仅在 hostname==='thumb' 且 not-generated 时调 onThumbMissing 后返回 404，forbidden 返回 403；photo 路由逻辑本期不变（仍直出原图/RAW 预览缓存）。main.ts 更新调用点。

- [ ] **Step 3: 写 RAW 自愈顺序测试（RED，Review Focus #4）**

thumbnails.test.ts 加用例：width NULL 的 .arw 行 + fake reader（readImageMeta 与 ensureRawPreview 各为 spy），跑 queue worker 后断言 readImageMeta 先于 ensureRawPreview 被调用、行 width 非 NULL、输出无 sidecar。

- [ ] **Step 4: 实现 queue worker 自愈与 onReady**

worker 查行后：RAW 且 width IS NULL 先 `enrichPhoto(db,id,reader)`；ensureThumbnail settle 后 onReady(id, result.placeholder===false)。createThumbnailQueue 的 reader 类型扩为含 readImageMeta（main 传完整 ExiftoolReader 天然满足）。

- [ ] **Step 5: main.ts 临时 onReady 占位 + build 验证**

本任务先传 `() => {}` 占位保持类型绿，Task 6 换 webContents.send。Run: `npm run typecheck && npm run build`，PASS。

- [ ] **Step 6: 提交**

`git commit -m "feat: enqueue missing thumbnails on 404 and emit readiness with RAW self-heal"`。

---

### Task 6: IPC 事件通道、富化接线与 openBatch 补偿

**Files:**
- Modify: `electron/shared/api.ts`（两个 channel 与事件类型、SelightApi 两个订阅）
- Modify: `electron/preload.ts`（onEnrichProgress、onMediaReady）
- Modify: `electron/ipc.ts`（去占位，接真 EnrichmentService；openBatch 补偿）
- Modify: `electron/main.ts`（创建 service、两个 webContents.send、will-quit stop）
- Test: `tests/ipc.contract.test.ts`、`tests/renderer/store.test.ts`

**Interfaces:**
- Produces: `IPC_CHANNELS.enrichProgress='selight:enrich:progress'`、`IPC_CHANNELS.mediaReady='selight:media:ready'`；`EnrichProgressEvent { done:number; total:number }`、`MediaReadyEvent { id:number; kind:'thumb'; ok:boolean }`；SelightApi 增 `onEnrichProgress(cb): () => void`、`onMediaReady(cb): () => void`。

- [ ] **Step 1: contract 测试先写补偿与提交（RED）**

openBatch 用例：预置 width NULL 行，断言 handler 调 enrichment.submit 且参数含这些 id；importDirectory 用例断言新导入 id 进 enrichment 而非 thumbQueue。

- [ ] **Step 2: 实现 api/preload/ipc/main**

HandlerDeps 的 enrichment 占位换 `Pick<EnrichmentService,'submit'|'stop'>`；openBatch 在组装 BatchState 前 submit(findUnenrichedPhotoIds)。main 创建 service 时 onProgress 转发 enrichProgress；thumbQueue 的 onReady 转发 mediaReady（kind 固定 'thumb'）；will-quit 调 enrichment.stop()。preload 两个订阅仿 onExportProgress 的退订写法。

- [ ] **Step 3: store.test 假 API 同步**

makeApi 补 onEnrichProgress/onMediaReady（vi.fn(() => () => {})），与 onDbRecovered 同列；缺这俩时类型必须报错，以此防漏。

- [ ] **Step 4: typecheck + build + 受影响测试**

Run: `npm run typecheck && npm run build && npx vitest run tests/ipc.contract.test.ts tests/renderer/store.test.ts`，全绿。

- [ ] **Step 5: 提交**

`git commit -m "feat: wire enrichment service, open-batch catch-up and media progress events"`。

---

### Task 7: 渲染层就绪重载、导入禁用/进度与 smoke 回归

**Files:**
- Create: `src/state/mediaReady.ts`（纯函数）
- Modify: `src/hooks/useMediaUrl.ts`（nonce 重载）
- Modify: `src/state/store.ts`（enrichProgress state + 订阅 + reducer）
- Modify: `src/components/Toolbar.tsx`（导入 in-flight 禁用、富化进度文案）
- Modify: `tests/smoke/fullflow.test.ts`、`tests/smoke/raw-samples.test.ts`、`tests/smoke/media-harness.entry.ts`（新签名与富化断言）
- Modify: `README.md`、`docs/superpowers/specs/2026-11-16-post-mvp-backlog.md`
- Test: `tests/renderer/mediaReady.test.ts`、`tests/renderer/store.test.ts`

**Interfaces:**
- Consumes: Task 6 的两个订阅 API。
- Produces: `shouldReloadMedia(event: MediaReadyEvent, id: number, kind: 'thumb'): boolean`（id 相等且 kind 相等且 ok）；AppState 增 `enrichProgress: EnrichProgressEvent | null`。

- [ ] **Step 1: 写 mediaReady 纯函数测试（RED）**

匹配 id/kind 返回 true，错 id、错 kind、ok:false 三种返回 false（ok:false 不触发重载，占位图由 sidecar 缓存路径自行呈现）。

- [ ] **Step 2: 实现纯函数与 useMediaUrl nonce**

hook 内 useEffect 订阅 onMediaReady，shouldReloadMedia 命中时 setNonce+1；URL 输出 `${base}?v=${nonce}`，urlCache 继续只存基础 URL；卸载退订。

- [ ] **Step 3: store 富化进度（RED → GREEN）**

store.test 加 reducer 用例：enrich-progress action 更新 state、null  clears；AppStoreProvider 订阅逻辑靠假 API 被调用一次断言（仿现有订阅测试模式，若无则只测 reducer 与 thunk）。

- [ ] **Step 4: Toolbar 禁用与进度**

handleImport 外包 importing 本地态，期间导入按钮 disabled；enrichProgress 非 null 且 done<total 时在 tb-progress 区显示中文文案"正在处理 {done}/{total}"。纯展示三元，不抽函数。

- [ ] **Step 5: smoke 适配与真机证据**

fullflow/raw-samples 的 scanDirectory 去 reader 第二参；fullflow 导入后构造 EnrichmentService 排空，断言抽样行 width 非 NULL、竖图 width<height；media-harness 补一条 RAW 自愈断言（width NULL 起始，ensureThumbnail 后被填充）。Run: `npm test`，再 `npm run build && node tests/smoke/electron-media-harness.cjs && node tests/smoke/electron-raw-samples-harness.cjs`，两 harness ok:true、WMI 0。

- [ ] **Step 6: 文档与最终提交**

README 导入/缩略图描述更新；backlog #1 标注二期完成与实测关键路径耗时（harness 计时回填）、#7 标注。最终 `npm run typecheck && npm test && npm run build` 全绿后 `git commit -m "feat: reload thumbnails on ready events and show import/enrichment progress"`。

---

## 后续路线（三期、四期，各自再开独立计划）

### 三期 `feat/preview-2048`（本计划合并后启动）

- 目标：渲染进程不再接收原图字节，PreviewPane 只消费长边 2048 的预览副本。
- 关键改动：新增 `ensurePreview(photo)`（sharp fit-inside 2048、q85、rotate 烘焙，写 previews/<id>.jpg）；resolve 的 photo 路由从直出原图改解析预览缓存，未生成走与 thumb 同构的 404 入队 + media:ready（事件 kind 扩 'preview'）；PreviewPane 三态重构（生成中灰底 / missing 文案 / 永久失败点击重试），三态判定抽 src/state 纯函数走 node 测试；MetaBar 展示态尺寸接二期入库的 width/height。
- 验收：1 亿像素 JPEG/webp 夹具的进程 RSS 对比（回填一期 M4 欠账与 backlog #2，#2 届时才能关闭）；selight://photo 不再可能返回源文件字节的安全断言；两真机 harness 扩 preview 路由。

### 四期 `feat/thumb-backfill-gc`（可选，发版前评估）

- 目标：空闲回填与缓存卫生，对标 darktable-generate-cache 与 backlog #9。
- 关键改动：MediaQueue onIdle 低优先级 backfill（全部 width 非 NULL 但无缩略图的行，限速不抢视口任务）；导入主动取消（AbortSignal 贯通 scanner 与 EnrichmentService）；缓存 GC（missing 占位死产物、孤儿 id、过期 sidecar 的清理策略与手动入口）。
- 验收：回填不影响视口 prioritize 越级的时序测试；GC 后数据库与缓存目录一致性校验；取消后无孤儿任务/无泄漏句柄。

## Self-Review 记录

- **Spec 覆盖**：5.1（fs-only、EnrichmentService、未富化标记、尺寸口径、进度、openBatch 补偿）→ Task 1/2/3/6；5.3（prioritize 修复、404 入队、media:ready、RAW 自愈、useMediaUrl nonce）→ Task 4/5/7；5.5（禁按钮、聚合进度、不做取消）→ Task 6/7，取消明确挂四期。三期 2048、四期 backfill 仅路线图。
- **类型一致性**：enrichPhoto/EnrichmentService/readImageMeta/orientDimensions/ResolveResult/两个事件名在各任务 Interfaces 块逐一对齐；MediaReadyEvent.kind 二期固定 'thumb'，三期扩联合，避免预留未用字段。
- **每提交可构建**：Task 1 的 enrichment 占位、Task 5 的 onReady 占位都在同任务内接通 main.ts，不存在中间类型断裂提交。
- **测试纪律**：queue 旧语义测试在 Task 4 先改期望再改实现（表征→新契约）；smoke 签名漂移集中在 Task 7 一次改完，避免中间提交拖红真机套件。
