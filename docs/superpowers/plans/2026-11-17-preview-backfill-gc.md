# Preview 2048 + Backfill/GC Implementation Plan（三期、四期连续执行）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans。两个阶段各自开分支、各自 `--no-ff` 合并回 main，本会话连续执行不停顿。Steps use checkbox (`- [ ]`)。

**Goal:** 三期让渲染进程永远拿不到原图字节（2048 预览副本 + PreviewPane 三态）；四期补齐空闲回填、导入取消与缓存 GC，关闭 backlog #2/#9/I7。

**Spec:** `docs/superpowers/specs/2026-11-17-media-pipeline-sharp-design.md`（5.4/5.5、第 8 节三/四期、第 9 节风险）。一期 sharp、二期富化/队列均已合并 main。

## Global Constraints

- 只读原则不变；源文件永不写入，测试夹具落 `os.tmpdir()`，`素材/`、`samples/` 只读。
- 不改 schema；`width IS NULL` 富化不变量继续生效。
- 工厂纪律：`createHandlers` 保持 electron-free，新依赖走 `HandlerDeps`；`SelightApi` 每加方法，preload/main/`tests/renderer/store.test.ts` 三处同步，禁 `as any`。
- 常量：预览长边 `PREVIEW_LONG_EDGE = 2048`、`JPEG_QUALITY = 85`、resize `{ fit:'inside', withoutEnlargement:true }`、sharp `concurrency(1)` + `cache({files:0})`。
- 命名对齐：`MediaReadyEvent.kind` 与 `MediaKind` 同为 `'thumb' | 'photo'`（二期只有 thumb，三期加 photo；二期测试里的 `'preview' as never` 改正式联合）。
- 验证：每任务 typecheck + 受影响测试；阶段末 `npm test` + `npm run build` + 两个 Electron harness。
- 提交英文 conventional commits + Co-Authored-By；管道不吞退出码，测试命令一律重定向看真实 exit。

## Review Focus（两阶段共五个，测试须显式覆盖）

1. **photo 路由零源字节**：任何在册 id（含直读 jpg/png/webp）经 `selight://photo/<id>` 都只能拿到 previews 缓存 JPEG，测试断言与源文件字节不相等且为 JPEG SOI。
2. **三态判定**：missing=1 永远走 missing 文案而非无限 loading；ok:false 永久失败可重试且重试后能恢复；404 生成中是 loading 灰底不报错。
3. **GC 安全性**：只删缓存目录内、id 不在 photos 表或 missing=1 的产物，绝不动源文件；删除计数与实际文件一致。
4. **backfill 不抢视口**：backfill 用普通 enqueue，视口 prioritize 仍能越级到队首（二期语义回归保护）。
5. **取消无泄漏**：cancel 后排队任务不再启动、在跑任务自然完成、无 orphan 句柄，再次 submit 仍可工作（服务不被 cancel 销毁）。

---

# 三期 `feat/preview-2048`

### Task P3-1: ensurePreview 2048 管线（TDD）

**Files:** Create `electron/media/previews.ts`、`tests/media/previews.test.ts`
**Interfaces:**
- `ensurePreview(photo: ThumbnailPhoto, roots: ThumbnailRoots, deps?: ThumbnailDeps): Promise<ThumbnailResult>`（复用 thumbnails 的类型，输出 `previews/<id>.jpg`，sidecar 同目录）
- 直读：`sharp(absPath,{failOn:'none'}).rotate().resize(2048,2048,{fit:'inside',withoutEnlargement:true}).jpeg({quality:85})`
- RAW：`reader.ensureRawPreview` 取已旋转内嵌 JPEG，再过同一 2048 resize（内嵌通常 <2048，withoutEnlargement 保原尺寸）
- 缓存 access / missing 短路 / atomicWrite / sidecar / fallbackPlaceholder 契约与 ensureThumbnail 同构。

- [ ] 写失败测试：健康 jpg 输出长边≤2048 且 SOI、无 sidecar、二次调用 mtime 不变；orientation 6/8 物理竖图；RAW fake reader 路径；零字节/截断落 placeholder+sidecar；missing=1 短路。
- [ ] 跑 RED（模块不存在）。
- [ ] 实现 previews.ts（共享常量从 thumbnails 导出或本文件定义，避免循环依赖：PREVIEW 常量本文件自持）。
- [ ] GREEN + typecheck，提交 `feat: add 2048px preview generation pipeline`。

### Task P3-2: preview 队列、photo 路由切缓存、media:ready 扩 photo

**Files:** Modify `electron/media/resolve.ts`、`protocol.ts`、`main.ts`、`shared/api.ts`、`thumbnails.ts`（抽 RAW 自愈为共享 helper 或在 preview 队列内复制最小版）、`tests/media/protocol.test.ts`、两个 harness
**Interfaces:**
- `createPreviewQueue(db, roots, reader?, onReady?:(id,ok)=>void): MediaQueue`（previews.ts），worker 含与 thumb 队列相同的 RAW width-NULL 自愈（抽 `selfHealRaw(db, reader, row): Promise<ThumbnailPhoto|null>` 到共享位置，null 表示自愈失败）。
- `registerMediaProtocol(db, roots, onThumbMissing:(id)=>void, onPhotoMissing:(id)=>void)`。
- resolve photo 分支：删除直读源文件直出，统一 `previews/<id>.jpg` exists ? ok : not-generated。
- `MediaReadyEvent.kind: 'thumb'|'photo'`，两队列 onReady 分别带 kind。

- [ ] protocol.test 先改：直读 jpg 的 photo 请求未生成时 not-generated；生成后返回的字节 ≠ 源文件字节且 SOI（Review Focus #1）；photo not-generated 触发 onPhotoMissing；连续 404 经真 MediaQueue 只跑一次。
- [ ] RED → 改 resolve/protocol（两回调）→ 实现 createPreviewQueue 与共享 selfHealRaw，thumb 队列改为调用共享 helper（行为不变，既有测试守护）。
- [ ] main.ts 建 previewQueue，protocol 接两个 enqueue，两个 onReady 转发对应 kind。
- [ ] raw-harness photo 断言更新：直读格式不再 bytesEqualSource，统一断言 JPEG + 方向；media-harness 加 preview 路由抽样。
- [ ] GREEN + build，提交 `feat: serve 2048 previews through the photo route with on-demand queue`。

### Task P3-3: retryMedia IPC（关闭 backlog I7）

**Files:** Modify `shared/api.ts`、`preload.ts`、`ipc.ts`、`main.ts`、`tests/ipc.contract.test.ts`、`tests/renderer/store.test.ts`
**Interfaces:** `retryMedia(photoId: number, kind: MediaKind): Promise<void>`；handler 删对应 `<id>.jpg` 与 sidecar 后向对应队列 enqueue。HandlerDeps 加 `retry: { retryThumb(id):void; retryPreview(id):void }`（main 用两队列实现，封装删文件逻辑）。

- [ ] contract RED：retry 后占位/sidecar 被删且队列收到 id；对不存在 id 不抛。
- [ ] 实现 + preload + store.test 假 API；typecheck。
- [ ] 提交 `feat: add manual media regeneration retry for placeholders`。

### Task P3-4: PreviewPane 三态重构 + 纯函数

**Files:** Create `src/state/previewState.ts`、`tests/renderer/previewState.test.ts`；Modify `src/components/PreviewPane.tsx`
**Interfaces:**
- `type PreviewState = 'loading'|'missing'|'failed'|'ready'`
- `derivePreviewState(input:{ missing:boolean; loadFailed:boolean; loaded:boolean }): PreviewState`（missing 优先；loadFailed→failed；loaded→ready；否则 loading）。
- StageImage 去 failed 锁存：ready/loading/failed 由 props 驱动；failed 显示"重试"按钮，点击调 `retryMedia(id,'photo')` 并通过本地 reloadKey 重置 hook（hook 加可选 reloadToken 参数或复用 nonce 外部递增）。
- useMediaUrl 的 onMediaReady 过滤改用 MediaKind（'photo'），删除二期 `'preview' as never`。

- [ ] 纯函数表驱动测试先行（RED→GREEN）。
- [ ] 重构 PreviewPane：missing 文案、failed 重试按钮、loading 灰底；MetaBar 尺寸在富化后自然有值（二期已写 width/height），补一条断言 width/height 展示。
- [ ] typecheck + renderer 测试，提交 `refactor: rebuild preview pane with explicit loading/missing/failed states`。

### Task P3-5: 超大图 RSS harness 与 backlog #2 收尾

**Files:** Modify `tests/smoke/media-harness.entry.ts`、`docs/superpowers/specs/2026-11-16-post-mvp-backlog.md`、README
- [ ] harness 用 sharp 生成 8000×6000（或内存允许的最大）JPEG 夹具到 tmpdir，跑 ensurePreview，记录 `resourceUsage().maxRSS` 与输出尺寸，断言长边 2048、RSS 数字写入 summary。
- [ ] 真机跑两 harness，RSS 回填 backlog #2 并标注关闭（三管线全尺寸解码已全部消除）；README 预览层描述更新。
- [ ] 全量 `typecheck && npm test && build`，三期分支 `--no-ff` 合并 main，删分支。

---

# 四期 `feat/thumb-backfill-gc`（三期合并后从最新 main 切）

### Task P4-1: backfill 选择器与 onIdle 回填

**Files:** Modify `electron/domain/photos.ts`（新增查询）、`electron/main.ts` 或新 `electron/media/backfill.ts`、`tests/domain/photos.test.ts`、`tests/media/queue.test.ts`
**Interfaces:**
- `findPhotosMissingThumbnails(db: Database, limit: number): number[]`——`width IS NOT NULL` 且 id 不在已有缓存文件集合（调用方传 existingIds  Set，或函数接收 roots 自行 fs 比对；选纯 SQL+fs 分离：domain 函数只返回 width 非 NULL 的候选 id，fs 过滤放 backfill.ts）。
- backfill.ts：`scheduleBackfill(db, queue, roots, batchSize=50)`，queue.onIdle 时取一批未生成 id 普通 enqueue（Review Focus #4：测试 prioritize 仍能越级）。

- [ ] domain 测试 RED→GREEN（只选 width 非 NULL、按 id、limit）。
- [ ] queue 测试：onIdle backfill 入队后，prioritize 的 id 排到其前。
- [ ] main.ts 接线（thumbQueue.onIdle），提交 `feat: backfill missing thumbnails during queue idle without blocking viewport`。

### Task P4-2: 导入取消（AbortSignal + EnrichmentService.cancel）

**Files:** Modify `electron/scanner.ts`、`electron/media/queue.ts`、`electron/media/enrich.ts`、`electron/ipc.ts`、`shared/api.ts`、`preload.ts`、`src/components/Toolbar.tsx`、`tests/scanner.test.ts`、`tests/media/enrich.test.ts`、`tests/ipc.contract.test.ts`
**Interfaces:**
- `scanDirectory(root, signal?: AbortSignal)`：每个 walk 循环开头 `signal?.throwIfAborted()`，abort 抛 DOMException AbortError。
- `MediaQueue.cancel()`：stopped=true 且 `queued.length=0`（在跑任务完成，排队丢弃）；与 stop（保留 queued 供退出）区分。
- `EnrichmentService.cancel()`：两队列 cancel，服务实例仍可再 submit（Review Focus #5）。
- IPC `cancelImport(): Promise<void>`：handler 持有当前 scan AbortController，cancel 时 controller.abort() + enrichment.cancel()；importDirectory 的 AbortError 静默返回空结果。
- Toolbar：导入中按钮变"取消"，点击 cancelImport。

- [ ] scanner 测试：aborted signal 下 scanDirectory reject 且 failures 不含半截假成功。
- [ ] enrich 测试：cancel 后排队 id 不启动、再 submit 新 id 正常处理。
- [ ] contract + preload + store.test 三处同步；typecheck/build。
- [ ] 提交 `feat: make discovery and enrichment cancellable without leaking queued work`。

### Task P4-3: 缓存 GC 纯函数与 IPC

**Files:** Create `electron/media/cacheGc.ts`、`tests/media/cacheGc.test.ts`；Modify `ipc.ts`、`shared/api.ts`、`preload.ts`、`main.ts`、`tests/ipc.contract.test.ts`、`tests/renderer/store.test.ts`、Toolbar（最小入口）
**Interfaces:**
- `planCacheCleanup(db, roots): { thumbFiles: string[]; previewFiles: string[] }`——扫描两个缓存目录，保留 id 在 photos 表且 missing=0 的 `<id>.jpg`（含其 sidecar：sidecar 仅在对应主图被判定清理时一起删；孤立 sidecar 主图缺失即清）。纯函数只读不删，返回待删绝对路径，全部限定在 roots 内（Review Focus #3）。
- `runCacheCleanup(db, roots): Promise<{ removed: number }>`——执行计划删除。
- IPC `cleanupMediaCache(): Promise<{ removed:number }>`；Toolbar 加次要按钮"清理缓存"（title 提示），结果 alert 中文。

- [ ] cacheGc 测试：孤儿 id、missing=1 占位、孤立 sidecar 入选；正常在册产物不入选；所有路径在 roots 内（逃逸夹具）。
- [ ] contract：cleanup 后文件真实删除、计数正确、源目录零改动。
- [ ] 三处 SelightApi 同步 + UI，提交 `feat: add safe media cache garbage collection with manual entry point`。

### Task P4-4: 全量回归、harness、backlog #9 关闭

- [ ] `npm run typecheck && npm test && npm run build` 全绿；两个 Electron harness ok:true WMI 0。
- [ ] backlog #9 标注完成（GC 策略+手动入口）、I7 标注完成（retryMedia）；四期路线图项回填实际做法；README 同步。
- [ ] 四期分支 `--no-ff` 合并 main，删分支，删 SDD 工作区。

## Self-Review

- Spec 覆盖：5.4（ensurePreview、photo 切缓存、三态、MetaBar、RSS）→ P3-1/2/4/5；5.5（取消、聚合进度二期已做）→ P4-2；四期 backfill/GC → P4-1/3；I7 重试 → P3-3。
- 接口一致：ensurePreview/createPreviewQueue/retryMedia/derivePreviewState/findPhotosMissingThumbnails/planCacheCleanup 命名跨任务统一；MediaReadyEvent.kind 全链路 'thumb'|'photo'。
- 每提交可构建：队列/协议/IPC 的签名变更同任务内接通 main 与测试，不留中间断裂提交。
- 已知留白：macOS arm64 打包仍无环境；CMYK 等冷门色彩不硬断言；GC 自动周期调度不做（仅手动+onIdle 间接回收），YAGNI。
