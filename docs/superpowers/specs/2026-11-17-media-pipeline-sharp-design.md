# 媒体管线重构设计：sharp 统一解码 + 发现/富化分离 + 按需缩略图

日期：2026-11-17
状态：待评审
关联：backlog 高优先 #1（大批量导入卡死）、#2（超大尺寸照片内存卡死）、中优先 #9（缓存 GC）

## 1. 背景与实测证据

在真实素材库（`素材/`，1874 个 webp + 3 个 ARW，380MB，本机 20 核）上对现有导入链路做了分边界计时（一次性探针，测完已删）：

| 边界 | 实测耗时 | 结论 |
|---|---|---|
| 纯 fs 遍历（readdir + stat，1874 文件） | 136ms | I/O 不是瓶颈 |
| exiftool 方向扫描（现状逐文件 await） | 52.6s（p50 30.7ms/张） | 占导入总耗时 99% |
| 同素材池化并发 4 / 8 | 10.0s / 7.1s | 瓶颈是 JS 层串行，不是 exiftool 本身 |
| `importScanned` 同步事务（新增/冲突） | 141ms / 261ms | 主线程阻塞可忽略 |
| `listPhotos` + IPC 载荷 | 查询 3ms、structuredClone 5ms、713KB | backlog 怀疑的"IPC 全量下发"不是瓶颈 |
| Blink webp 单张解码（20 样本） | p50 26ms / p95 34ms | 全尺寸 createImageBitmap 后再降采样 |

根因判定：

1. **主因**：`scanner.walk` 在 for 循环里逐个 `await readOrientation`，exiftool-vendored 的进程池（默认 `maxProcs = ceil(核数/4)`，本机 5 进程）全程只有 1 个任务在飞。导入 IPC 53 秒不返回、无进度、按钮无忙态，用户视角即"卡死"。
2. **次因**：导入后 1874 个 id 一次性全量入队，FIFO 并发 2；`MediaQueue.prioritize` 对已排队 id 被 `isKnown` 过滤成 no-op，视口预热失效；缩略图未生成时协议返回 403，`img` 隐藏且无重试，滚动看到一片灰。
3. **内存隐患（backlog #2）**：JPEG 走 jpeg-autorotate/jpeg-js 全尺寸 RGBA 解码、webp 走 Blink 全尺寸 createImageBitmap，均无尺寸护栏，并发 2 可叠加 OOM。

## 2. 开源调研结论（一手文档/源码）

- **darktable**：导入时不预生成全部缩略图，浏览到哪生成到哪（lazy），另有 `darktable-generate-cache` 离线批量工具；RAW 优先抽相机内嵌 JPEG，进暗房才完整解码；两级缓存（内存 + 磁盘后端，磁盘后端不自动淘汰）；缓存过小会反复重生成、闪烁——与本项目 403 无重试的灰图问题同构。
- **PhotoPrism**：libvips 全格式统一管线；小尺寸（≤720p）索引时预生成，大尺寸按需生成，超限请求静默降级到最近尺寸；RAW 靠外部转换器（darktable-cli/RawTherapee），不做 LibRaw 绑定。
- **Immich（Node/TS，栈最接近）**：生产用 sharp，`sharp.concurrency(0)` + `sharp.cache({ files: 0 })`，EXIF 方向在解码期 `.rotate()` 处理；RAW 用 `exiftool.extractBinaryTagToBuffer('JpgFromRaw'/'PreviewImage')` 抽内嵌预览——与本项目 ARW 路线是同一个 API，现有 RAW 路线正确，错在后面接了 jpeg-js。
- **Tropy（Electron 桌面照片应用）**：Electron + sharp 0.35 生产背书，打包只需 asarUnpack。
- **exiftool-vendored README**：无数组批量 read API，官方推荐自建 `ExifTool({ maxProcs })` + `Promise.all` 扇出，标称全核 500 files/sec。

四个项目收敛到同一模式：**发现与富化分离、内嵌预览优先、视口驱动按需生成 + 可越级队列 + 就绪事件、解码期降采样的多级缓存**。

## 3. 已确认的决策（2026-11-17 与用户确认）

1. **引入 sharp 作为唯一解码引擎**，推翻 `2026-11-13-zeying-design.md:179` "不引入 sharp 等额外原生依赖"的旧决策（旧决策的背景是 MVP 控依赖，现状是三条解码管线已成为主要复杂度与 OOM 来源）。
2. **预览只做屏幕适配层（长边 2048）**，原图字节永远不再进入渲染进程；不支持 100% 像素查看。
3. **先出完整设计文档，分四个阶段在独立分支实施**，每期可独立验证、独立回退。

## 4. 目标、非目标、反目标

### 目标

- 1874 张规模导入：发现 + 入库 2 秒内返回，UI 不卡死，富化后台化且有进度。
- 视口内缩略图秒级出现，滚动驱动的优先级真正能越级。
- 任何单张图片的解码内存有界（libvips shrink-on-load），消除 backlog #2 的 OOM 路径。
- 全格式一条解码管线，删除 Blink helper、nativeImage、jpeg-autorotate 三套机制。
- 只读原则不变：源文件仍然只读，所有产物落在 userData 缓存。

### 非目标

- 不做 RAW 完整解码（继续只用相机内嵌 JPEG）。
- 不做 100% 像素查看、不做原图导出通道（导出仍走 `copyFile` 原文件，不经渲染进程）。
- 不做云端、AI、人脸、视频转码。
- 不做 schema 迁移（v2 的 `orientation DEFAULT 1`、可空 `width/height`、未使用的 `thumb_path/preview_path` 已够用）。

### 反目标

- 不为类型通过 `as any`，不弱化测试断言。
- 不保留第二套解码路径做"兜底"（失败统一落占位图 + sidecar，沿用现有降级契约）。
- 不在发现阶段做任何 EXIF/解码工作，避免重蹈 53 秒覆辙。

## 5. 目标架构

### 5.1 阶段化导入：发现与富化分离

**发现（同步关键路径，秒回）**：

- `scanDirectory` 瘦身为纯 fs 遍历：readdir + stat + 扩展名过滤，不再读 orientation。`ScannedFile` 移除 `orientation` 字段。
- `importScanned` 入库时 orientation 走列默认值 1，width/height 保持 NULL。
- `importDirectory` IPC 在发现 + 入库后立即返回 `ImportResult`，契约形状不变。

**富化（后台任务，新模块 `electron/media/enrich.ts`，进程级单例 EnrichmentService）**：

- 服务形态：main 装配期创建一个单例，内部一个有界并发池（默认：直读 4、RAW 2，常量集中在 enrich.ts）+ in-flight/seen 去重。多次导入、批次补偿都只是向同一个服务提交 id，不允许出现两个并发池。
- 直读格式（jpg/jpeg/png/webp）：`sharp(absPath).metadata()` 一次头读取拿 orientation + width + height，按 id UPDATE。sharp 头读取只解析文件头，不解码像素，成本接近 stat 量级（具体数字列入一期 spike 验收）。
- RAW：保留 `ExiftoolReader.readOrientation`（exiftool 从此只服务 RAW），width/height 同样可取；内嵌预览抽取仍在缩略图/预览生成时按需做。
- 单文件失败降级 orientation=1 并记 console.error，不阻断批次——与现有扫描失败契约一致。
- **未富化标记**：以 `width IS NULL` 判定（orientation 有 DEFAULT 1 无法区分"未读"和"真值 1"）。新领域查询 `findUnenrichedPhotoIds(db, batchId)`（domain/photos.ts，bare Node 可测）。
- **尺寸口径**：入库的是展示态尺寸，orientation 为 6/8 时交换 width/height——竖拍照片 MetaBar 显示 3000×4500 而不是存储态的 4500×3000。夹具按 1/3/6/8 四种方向断言。
- 进度走新推送通道 `selight:enrich:progress`，payload 为聚合的 `{ done, total }`（整个服务当前队列的进度，不按导入任务区分）；队列排空时 done=total，渲染层清除指示。
- **重启/中断补偿（二期内置，用户已确认）**：`openBatch` 时把该批次所有 `width IS NULL` 的行提交给单例服务。不做全局启动扫描，避免多批次用户开机即狂跑 exiftool；配合导入后提交，覆盖所有正常路径。应用中途退出只影响从未重新打开过的批次，且点用点自愈（见 5.3）仍然兜底。

### 5.2 sharp 统一解码管线（重写 `thumbnails.ts`）

缓存目录与文件约定不变：`thumbnails/<id>.jpg`、`previews/<id>.jpg`、`.placeholder` sidecar、tmp + rename 原子写。

- **jpg/jpeg/png/webp**：`sharp(absPath, { failOn: 'none' }).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 })`。`.rotate()` 无参 = 自动按 EXIF 转正并清掉方向标记，替代 jpeg-autorotate。
- **RAW**：exiftool 抽内嵌 JPEG（现有 `extractPreview` 保留）→ `sharp(buffer).rotate(显式角度)`（内嵌预览无 EXIF，角度由 DB orientation 经纯映射 `orientationToRotate` 得到；该纯函数保留，删掉 jpeg-autorotate import 和依赖）→ resize。RAW 的旋转正确性依赖 DB orientation 已就绪，未富化行的竞争处理统一放在 5.3。
- **占位图**：missing=1 或任何解码失败，沿用现有占位 JPEG 字节 + sidecar 机制与 `placeholder: true` 返回契约。
- 进程级配置：`sharp.concurrency(1)`（每个操作单 libvips 线程，并发靠 MediaQueue 吃多核，避免线程过订阅）+ `sharp.cache({ files: 0 })`（Immich 同款，避免文件句柄缓存堆积）。
- 内存护栏：libvips 对 JPEG 支持解码期 shrink-on-load；webp 支持程度需 spike 实测，若 RSS 峰值过高，兜底手段是队列并发降到 1。验收用 smoke harness 造超大图测 RSS，数字记录进 backlog，不拍脑袋写阈值。

### 5.3 按需生成 + 优先级队列 + 就绪事件

- 导入不再全量 enqueue。
- `ThumbPane` 的 `onCellsRendered → markSelection(ids)` 保留，作为视口信号；handler 调 `queue.prioritize(ids)`。
- **修复 MediaQueue**：`prioritize` 对已在 pending 中的 id 也要移动到队首（当前 `isKnown` 直接过滤导致 no-op）；active 中的任务不动。纯队列模块，bare Node 单测覆盖"已排队 id 被重新插队"。
- 协议层：缩略图/预览未生成时，先 `enqueue([id])`（兜底，防止事件丢失）再返回 404；missing 照片仍返回占位/403 的现有语义。
- 新 IPC 推送通道 `selight:media:ready`，payload `{ id, kind: 'thumb' | 'preview', ok: boolean }`；preload 暴露 `onMediaReady(cb): () => void`，与 `onExportProgress` 同构。
- 渲染层 `useMediaUrl`：订阅 onMediaReady，命中当前 id 时给 URL 追加/递增 `?v=<nonce>` 触发 img 重新请求；404 期间保持现有灰底（onError hide 保留）。
- **点用点自愈（builder check 发现的 RAW 竞争修复）**：worker 生成前检查行的 `width IS NULL` 未富化标记。RAW 若未富化，先同步调一次 `readOrientation`（含尺寸）并 UPDATE 入库，再抽内嵌预览、旋转、出图——否则富化到达前按需生成会把 orientation=1 的错误方向永久缓存（`fs.access` 缓存命中后不会再纠正）。直读格式无需等待：sharp 解码时直接读源文件 EXIF，方向正确性与 DB 无关，富化继续由单例服务异步补齐。
- 队列 worker 现状已按 id 查行、行不存在直接早退，删批次/切批次无需额外失效逻辑。

### 5.4 2048 预览层

- 新 `ensurePreview(photo)`：直读格式 sharp 长边 resize 到 2048（fit inside、不放大）、rotate 转正，写 `previews/<id>.jpg`（q85）；RAW 把内嵌预览同样规整到 2048。
- `resolve.ts` 的 photo 路由改为始终解析 `previews/<id>.jpg`：不存在则 enqueue preview 任务并返回 404，就绪后靠 media:ready 事件重载。**原图 selight 通道关闭**，渲染进程永远拿不到源文件字节（只读原则不变，攻击面更小）。
- **预览三态契约（builder check 修正，PreviewPane 不是小改）**：现有 `failed` 状态在首次 onError 后锁死、只随 photo.id 重置，nonce 变化救不回来，必须重构。新契约——
  - 404 生成中：灰底等待，不报错、不显示文案，靠 `media:ready` 事件触发 nonce 重载；
  - missing（DB `missing=1`，协议 403）：现有"原文件缺失，暂时无法预览"文案；
  - 永久失败（`media:ready ok:false`，如解码损坏文件）：显示"预览生成失败，点击重试"，点击重新 enqueue 并回到生成中态。previews/ 不写假占位图（8×4 占位图放大到 2048 毫无意义）；网格缩略图仍沿用占位 JPEG + sidecar 机制，因为网格需要一个不破裂的 img 元素。
  - img 的 onError 拿不到 HTTP 状态码，404/403 的区分以 DB missing 标志旁路判定，不靠事件猜状态。
- MetaBar 的宽高来自富化入库的展示态 width/height（见 5.1 尺寸口径）；未富化行暂时只显示文件名与大小，富化完成随下次渲染补齐。

### 5.5 进度与交互

- 导入按钮 in-flight 禁用，堵住重复点击导致的并发扫描（发现阶段本身 <2s；返回后再次导入只向同一个 EnrichmentService 追加 id，不存在双池，故不禁用至富化排空）。
- 富化进度经 `selight:enrich:progress` 推送聚合的 done/total，工具栏或侧栏显示"正在处理 x/total"；第二个目录导入时 total 增长、计数继续，不按任务区分。发现阶段 <2s 不做取消。
- 取消能力不进本次设计：富化/backfill 随批次删除自然失效（worker 查行早退），主动取消登记 backlog。

## 6. 文件影响清单

新增：

- `electron/media/enrich.ts`（EnrichmentService 单例）、`tests/media/enrich.test.ts`
- 视情况抽 `electron/media/pipeline.ts` 放 sharp 纯封装（320/2048 两档共用）

删除：

- `electron/media/blinkThumbnail.ts`、`electron/helper-preload.ts`、`src/helper.ts`、`src/helper.html`
- `electron/shared/blinkProtocol.ts`（`corsHeadersFor` 若协议仍需则迁到 protocol 旁；helper 路由与 CORS 通连同删）
- `tests/media/blinkProtocol.test.ts`、`tests/smoke/blink-harness.entry.ts`、`tests/smoke/electron-blink-harness.cjs`
- 依赖 `jpeg-autorotate` 及 `electron/media/jpeg-autorotate.d.ts`

重写/修改：

- `electron/media/thumbnails.ts`（sharp 版）、`rawPreview.ts`（sharp 旋转/缩放）、`orientation.ts`（留纯映射）、`queue.ts`（prioritize 语义）
- `electron/domain/photos.ts`（新增 `findUnenrichedPhotoIds` 等未富化查询）、`electron/scanner.ts`（fs-only）、`electron/ipc.ts`、`main.ts`、`preload.ts`、`shared/api.ts`（enrich/media 新通道、删 Blink 装配）
- `electron/media/protocol.ts`、`resolve.ts`（404 + enqueue、photo→preview）
- `src/hooks/useMediaUrl.ts`（ready 事件 + 版本重试）、`src/components/PreviewPane.tsx`（三态重构）、`Toolbar.tsx`（禁按钮 + 进度）
- `electron.vite.config.ts`（删 helper 构建入口）、`package.json`（加 sharp、asarUnpack、删 jpeg-autorotate）

测试：

- `tests/media/thumbnails.test.ts` 从 mock nativeImage 改为真实 sharp + 夹具图（tiny JPEG 夹具已有；用 sharp 自产 webp/方向夹具覆盖 1/3/6/8）。
- smoke：blink harness 改造为 sharp 全格式 harness，跑真实素材，断言 320 宽、非占位字节、SOI、sidecar 缺席，并输出 RSS 观测。
- `tests/renderer/store.test.ts` 的 `HANDLER_NAMES`/假 API 表同步新事件与新通道（CLAUDE.md 点名的易错处）。
- `tests/scanner.test.ts` 去掉 stub ExifReader，改断言 fs-only 契约。
- `tests/media/enrich.test.ts`：池并发上限、单文件失败降级、单例去重、6/8 方向宽高交换（sharp 自产夹具）。
- `tests/media/queue.test.ts` 补"已排队 id 重新 prioritize 移到队首、active 中不动"的断言。
- 未富化查询进 `tests/domain/photos.test.ts`（NULL/非 NULL 混合行）。
- PreviewPane 三态判定抽成 `src/state/` 纯函数（pending/missing/failed/ready）走 node 测试，遵守项目不引 jsdom 的约束；组件本身只做薄封装。

## 7. 依赖与打包

- sharp 0.35.x：N-API v9 预编译二进制，Electron 44（Node 22）免 ABI 重编译；Windows x64 与 macOS arm64 均有现成包。
- 平台二进制走 optionalDependencies（`@img/sharp-win32-x64`、`@img/sharp-darwin-arm64`），需要刷新 lockfile（参考 commit 3bb0e5e 的 registry 刷新流程）。
- electron-builder `asarUnpack` 增加 `**/node_modules/{sharp,@img}/**`。
- 安装包体积增量待一期 spike 实测记录（预估 15–25MB）。净增运行时依赖只有 sharp 一个，同时删除 jpeg-autorotate 和整套 Blink 子系统，维护面净减少。

## 8. 分期计划

每期一个 `feat/*` 分支，`--no-ff` 合回 main，各自带完整测试与验证输出。

1. **一期 `feat/media-sharp-foundation`**：装 sharp（先 spike 验证主进程加载 + 真实 webp 出图，失败整体回退）；重写缩略图管线全格式走 sharp；删除 Blink/nativeImage/jpeg-autorotate 及关联测试/harness；smoke harness 改造并记录 RSS。验收：typecheck、全量测试、build、真机 smoke 全绿。
2. **二期 `feat/import-discovery-enrich`**：scanner fs-only 化；EnrichmentService 单例（池化富化 + 去重 + 聚合进度通道）；metadata 入库（展示态宽高、6/8 交换）；`findUnenrichedPhotoIds` + openBatch 补偿；MediaQueue prioritize 修复；media:ready 通道 + useMediaUrl 重试；按需入队 + worker 对未富化 RAW 的点用点自愈；导入禁按钮 + 富化进度。验收：1874 素材导入关键路径 <2s（harness 计时），视口滚动缩略图按优先级出现，中断重启后打开批次能补齐元数据。
3. **三期 `feat/preview-2048`**：ensurePreview + photo 路由切换到预览副本，原图通道关闭的安全检查；PreviewPane 三态重构（生成中灰底/missing 文案/失败点击重试），三态判定走 src/state 纯函数与 node 测试；MetaBar 展示态尺寸验证。
4. **四期（可选）`feat/thumb-backfill`**：onIdle 低优先级 backfill（darktable-generate-cache 的自动版）、主动取消、与 backlog #9 缓存 GC 合并设计。

backlog #1、#2 在二期、三期完成后分别标注完成日期与做法。

## 9. 风险与待验证

- **sharp 在 Electron 主进程的加载/打包**：一期第一件事就是 spike（npm i → 主进程 require → 真实 webp/jpg 出图 → build 后重跑），失败则整期回退，不带着不确定性往下写。
- **超大图 RSS 护栏**：libvips shrink-on-load 的实际峰值待 smoke 实测（造 1 亿像素 JPEG/webp 夹具），webp 若不支持解码期降采样，用并发降级兜底。
- **RAW 大批量性能**：素材库仅 3 个 ARW，exiftool 池化后的全 RAW 婚礼场景没有样本，数字留白，待真机样本补充。
- **orientation 一致性**：sharp metadata 与 exiftool 的方向读数必须对齐，夹具覆盖 1/3/6/8 与无 EXIF 两种情况。
- **未富化标记的不变量**：`width IS NULL` 同时承担富化状态、补偿选取、worker 自愈三重职责，任何富化路径（单例服务、点用点自愈）成功后都必须写尺寸，失败行保持 NULL 以便下次补偿重试；该约定在 enrich.ts 与 photos.ts 注释中钉死，测试覆盖"失败后仍可被重新选取"。
- builder check 提出的 RAW 方向竞争、预览 404 锁存、双导入双池三个缺陷已在 5.1/5.3/5.4 设计中消除，实施时按对应契约验收，不重新讨论方案。
- **macOS 打包**：sharp darwin-arm64 二进制未经本项目真机验证，与项目既有的 macOS 适配状态一起登记。
- 安装包体积增量为预估值，以一期实测为准。
