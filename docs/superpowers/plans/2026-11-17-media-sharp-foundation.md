# Media Pipeline Sharp Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 sharp 一条管线替换 nativeImage / Blink helper / jpeg-autorotate 三套解码机制，覆盖全部直读格式与 RAW 内嵌预览的缩略图生成。

**Architecture:** `ensureThumbnail` / `createThumbnailQueue` / `ExiftoolReader.ensureRawPreview` 的对外签名全部保持不变，只换内部实现：直读格式走 `sharp(path).rotate().resize(320, fit:inside)`，RAW 仍由 exiftool 抽内嵌 JPEG 后交 sharp 旋转。占位图 + sidecar、tmp+rename 原子写、MediaQueue 调度契约原样保留。Blink 隐藏窗口子系统整体删除。

**Tech Stack:** sharp 0.35.x（libvips 预编译二进制，N-API v9，Electron 44 免重编译）、Electron 44、TypeScript strict、Vitest（bare node）、exiftool-vendored（仅 RAW）

**Spec:** `docs/superpowers/specs/2026-11-17-media-pipeline-sharp-design.md`（本计划只实施第 8 节一期；scanner/富化/ready 事件/2048 预览均不在本期）

## Global Constraints

- 从最新 main 切分支 `feat/media-sharp-foundation`，完成后 `--no-ff` 合回，合并信息中文摘要。
- 只读原则：源照片文件自始至终只读；测试夹具一律在 `os.tmpdir()` 生成，禁止写 `素材/`、`samples/`。
- 常量钉死：`THUMB_WIDTH = 320`、`JPEG_QUALITY = 85`、resize `{ fit: 'inside', withoutEnlargement: true }`、进程级 `sharp.concurrency(1)` 与 `sharp.cache({ files: 0 })`。
- 依赖面：本期只允许新增 sharp 一个运行时依赖，同时删除 jpeg-autorotate；不引入其他包。
- 代码标识符与注释英文，用户可见文案与 docs 中文；禁止 `as any`，禁止弱化断言。
- 每个任务的验证顺序：`npm run typecheck` → 受影响测试文件 → 相关全量子集；最后一个任务跑全量 `npm test` 与 `npm run build`。
- 提交信息英文 conventional commits，结尾带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`；一个任务一个内聚提交。
- 不手改 `out/`、`dist/`；不 commit `node_modules`、`samples/`、`素材/`、本地 db。
- 一期不新增 IPC 通道、不改 `SelightApi`/preload、不改 scanner、不改 `resolve.ts` 的 photo 路由（仍直出原图，三期再切预览副本）。

## Review Focus

1. **损坏输入**（零字节、截断 JPEG、扩展名是图片但内容不是）：sharp reject 时必须落占位图 + sidecar 且 MediaQueue 不中断——Task 2 的占位测试用零字节与截断缓冲钉死。
2. **大写扩展名**（`.JPG`、`.WEBP`）：现有 `ext.toLowerCase()` 归一不能回退——Task 2 夹具含大写扩展名用例。
3. **竖拍方向 6/8 的物理正确性**：直读格式靠 `.rotate()` 烘焙、RAW 靠 `orientationToRotate` 显式角度，两条路径输出都必须 width < height——Task 2 与 Task 3 分别断言。
4. **并发下的内存峰值**：MediaQueue 并发 2 跑真实素材的 RSS 由 Task 5 harness 观测并把数字写进 backlog，不拍脑袋写阈值。
5. **中文/空格/深层嵌套路径**：Task 5 harness 直接跑 `素材/` 真实目录树（现有素材全是中文目录名），覆盖路径编码与长路径。

---

### Task 1: 接入 sharp 依赖与打包配置（spike 闸门）

**Files:**
- Modify: `package.json`（dependencies、build.asarUnpack）
- Modify: `package-lock.json`（npm install 生成）

**Interfaces:**
- Produces: `import sharp from 'sharp'` 在主进程 bundle 中以外部 require 解析（electron-vite 默认 externalizeDeps，不进 out/ 产物）；平台二进制经 optionalDependencies 安装（`@img/sharp-win32-x64`、`@img/sharp-darwin-arm64`）。

- [ ] **Step 1: 开分支并安装依赖**

```bash
git checkout main && git pull --ff-only
git checkout -b feat/media-sharp-foundation
npm install sharp@^0.35.5
```

检查 `package-lock.json` 中 sharp 系包的 resolved URL 主机是 `registry.npmjs.org`（参考 commit 3bb0e5e 的 registry 纪律；若出现 npmmirror 地址，重新 `npm install --registry=https://registry.npmjs.org` 刷新）。

- [ ] **Step 2: spike——bare node 真实 webp 出图（失败则整期回退，不进后续任务）**

在仓库根用 `素材/` 中任一真实 webp 跑一次性命令（不写入仓库）：

```bash
node -e "const sharp=require('sharp');const fs=require('fs');const f=fs.readdirSync('素材/02_出阁宴_1025/photobooth原图').filter(x=>x.endsWith('.webp'))[0];sharp('素材/02_出阁宴_1025/photobooth原图/'+f).rotate().resize(320,320,{fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer().then(b=>console.log('ok',b.length,b[0].toString(16),b[1].toString(16),b[2].toString(16)))"
```

Expected: 打印 `ok <正数> ff d8 ff`。报错即 spike 失败，停止本计划并回报。

- [ ] **Step 3: 配置 asarUnpack**

`package.json` 的 `build.asarUnpack` 数组追加两条：`**/node_modules/sharp/**`、`**/node_modules/@img/**`。

- [ ] **Step 4: 验证构建外部化**

Run: `npm run build`
Expected: 成功；`out/main/index.js` 中 sharp 以 require 外部依赖存在（构建日志无 sharp 打包警告，`grep -c "sharp" out/main/index.js` 有少量运行时 require 字符串而非整段 libvips 代码）。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add sharp with prebuilt libvips and asar unpack config"
```

---

### Task 2: sharp 重写 ensureThumbnail（直读格式 + 占位契约，TDD）

**Files:**
- Modify: `electron/media/thumbnails.ts`（整体重写实现，导出签名不变）
- Test: `tests/media/thumbnails.test.ts`（整体重写，删 electron/blink mock，改真实 sharp 夹具）

**Interfaces:**
- Consumes: Task 1 的 sharp；现有 `ThumbnailPhoto`（`Pick<PhotoRow,'id'|'absPath'|'ext'|'orientation'|'missing'>`）、`ThumbnailResult { path; placeholder }`、`ThumbnailDeps { previewDir; reader? }`、`PLACEHOLDER_JPEG_BYTES`。
- Produces: 同名同签名的 `ensureThumbnail`、`createThumbnailQueue`、`PLACEHOLDER_JPEG_BYTES`、`ThumbnailPhoto`、`ThumbnailResult`，Task 4/5 与 main.ts 装配无需改调用方。
- RAW 分支本期仍调 `deps.reader.ensureRawPreview`（Task 3 才换其内部实现），本任务用 fake reader 测。

- [ ] **Step 1: 写失败测试——真实 sharp 夹具版 thumbnails.test.ts**

删除文件顶部两个 `vi.mock`（electron、blinkThumbnail）与全部 nativeImage/blink 断言，新建夹具辅助（同文件内）：

```ts
import sharp from 'sharp'

// 640x480 的真实编码缓冲；orientation 写进 EXIF，.jpeg/.webp 各一份。
async function makeImage(opts: { ext: '.jpg' | '.webp'; orientation?: number }): Promise<Buffer>
// 实现要点：sharp({ create: { width: 640, height: 480, channels: 3, background: {...} } })
//   .withMetadata(opts.orientation ? { orientation: opts.orientation } : undefined)
//   .toFormat(ext === '.jpg' ? 'jpeg' : 'webp').toBuffer()
```

测试用例（文件名即断言意图，全部落 tmpdir）：

1. `writes a real 320-long-edge JPEG for a healthy jpg, no sidecar, cache hit skips re-generation`：首轮断言文件存在、SOI 三字节、`sharp(out).metadata()` 长边 ≤320 且 width=320（横图）、sidecar 不存在；记录 mtimeMs，二次调用后 mtimeMs 不变且返回 `placeholder:false`。
2. `bakes EXIF orientation 6/8 into a physically vertical thumbnail`：orientation 6 与 8 两个夹具，输出 metadata 满足 width < height。
3. `decodes webp through sharp without any helper boundary`：webp 夹具成功出图、SOI、无 sidecar。
4. `accepts upper-case extensions (.JPG, .WEBP)`：写盘文件名用大写扩展，行内 ext 同样大写，成功出图。
5. `degrades zero-byte and truncated files to placeholder + sidecar and never retries`：两个用例（零字节文件；合法 JPEG 截断到前 50 字节），首轮 `placeholder:true` + sidecar 存在 + 输出字节等于 `PLACEHOLDER_JPEG_BYTES`；二次调用后用 `vi.spyOn(fs, 'writeFile')` 或 mtime 不变证明无重试。
6. `marks a missing=1 photo with placeholder without touching the source`：断言 sidecar、`placeholder:true`，且源路径不存在时不抛错。
7. `wraps a RAW ensureRawPreview rejection (RawPreviewError) into placeholder + sidecar`：保留现有 fake reader 注入写法。
8. `clears a stale sidecar when a later generation succeeds`：预置 sidecar 后成功生成，sidecar 被删除。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/media/thumbnails.test.ts`
Expected: FAIL（旧实现依赖被移除的 mock 或 sharp 行为尚未接入；模块解析/断言失败均可，不能是编译通过全绿）。

- [ ] **Step 3: 重写 `electron/media/thumbnails.ts`**

保留：`THUMB_WIDTH=320`、`JPEG_QUALITY=85`、`PLACEHOLDER_JPEG_*`、`atomicWrite`、sidecar 三函数、`fallbackPlaceholder`、`ThumbnailPhoto/ThumbnailResult/ThumbnailDeps/ThumbnailRoots` 类型、`createThumbnailQueue`（worker 内 SQL 与调用不变）。

模块顶层执行一次 `sharp.concurrency(1)` 与 `sharp.cache({ files: 0 })`（附一行注释说明：并发由 MediaQueue 承担，避免 libvips 线程过订阅；Immich 同款配置）。

新 `ensureThumbnail` 主体：缓存 access 检查与 missing 短路逻辑不变；缓存未命中时——

- webp/jpg/jpeg/png 统一：`sharp(photo.absPath, { failOn: 'none' }).rotate().resize(THUMB_WIDTH, THUMB_WIDTH, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: JPEG_QUALITY }).toBuffer()`，交给现有 `atomicWrite`。
- RAW（`RAW_EXTENSIONS.has(ext)`）：校验 `deps.previewDir`，`const preview = await reader.ensureRawPreview(photo, deps.previewDir)` 后 `sharp(await fs.readFile(preview)).resize(...).jpeg(...)`（RAW 预览已在 Task 3 的 ensureRawPreview 内完成旋转，此处不重复 rotate）。
- try/catch 整体包进 `fallbackPlaceholder`，契约与旧实现一致。
- 删除 `electron` nativeImage import 与 `blinkThumbnail` import。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/media/thumbnails.test.ts`
Expected: 8 组用例全 PASS。

- [ ] **Step 5: 类型检查与提交**

Run: `npm run typecheck && npx vitest run tests/media/thumbnails.test.ts tests/media/queue.test.ts`
Expected: 全绿。此刻 blinkThumbnail.ts 仍存在、main.ts/fullflow 的引用未动，只是 thumbnails 内部换了实现，没有断裂的 import。

```bash
git add electron/media/thumbnails.ts tests/media/thumbnails.test.ts
git commit -m "feat: generate thumbnails with sharp for all direct-read formats"
```

---

### Task 3: RAW 预览旋转切换到 sharp，删除 jpeg-autorotate

**Files:**
- Modify: `electron/media/orientation.ts`（删 rotateJpegBuffer，留 orientationToRotate）
- Delete: `electron/media/jpeg-autorotate.d.ts`
- Modify: `electron/media/rawPreview.ts`（ensureRawPreview 用 sharp 旋转）
- Modify: `tests/media/orientation.test.ts`（删 rotateJpegBuffer describe）
- Modify: `tests/media/rawPreview.test.ts`（旋转断言改 sharp metadata）
- Modify: `tests/smoke/raw-samples.test.ts`（jpeg-js 解码换 sharp metadata）
- Delete: `tests/smoke/jpeg-js.d.ts`
- Modify: `package.json`、`package-lock.json`（卸载 jpeg-autorotate）

**Interfaces:**
- Consumes: Task 2 保留的 `orientationToRotate(orientation: number): 0|90|180|270`。
- Produces: `ExiftoolReader.ensureRawPreview(photo: { id; absPath; orientation }, cacheDir: string): Promise<string>` 签名与缓存路径约定（`previews/<id>.jpg`、tmp+rename）不变；`rotateJpegBuffer` 被删除，全仓 grep 无残留引用。

- [ ] **Step 1: 改失败测试**

- `orientation.test.ts`：删除整个 `describe('rotateJpegBuffer')`，保留 orientationToRotate 六个映射用例。
- `rawPreview.test.ts`：`ensureRawPreview` 两个用例的断言改为——输出文件存在且 SOI；orientation 6 用例用 `sharp(out).metadata()` 断言 `width! < height!`（tinyJpeg 是 8x4，旋转 90° 后 4x8）；缓存命中第二次调用 `fake.extract` 仍只 1 次。extractPreview 三个用例与 readOrientation 五个用例不动。
- `raw-samples.test.ts`：删除 `import jpeg from 'jpeg-js'` 与 `JPEG_DECODE_OPTS`，两处 `jpeg.decode(bytes)` 断言换 `const m = await sharp(bytes).metadata()`，竖拍断言 `m.width! < m.height!` 保持原意图；文件头注释中"jpeg-autorotate/jpeg-js"措辞改述为 sharp。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/media/orientation.test.ts tests/media/rawPreview.test.ts`
Expected: FAIL（rotateJpegBuffer 仍存在但测试已不引用；新断言在旧 jpeg-autorotate 产物上可能恰好通过——若全绿，确认 rawPreview 断言确实换成了 sharp metadata 且竖图断言有效，不允许假绿）。

- [ ] **Step 3: 实现**

- `orientation.ts`：只留 `ROTATE_BY_ORIENTATION` 与 `orientationToRotate`，删 jpeg-autorotate import 与 rotateJpegBuffer。
- `rawPreview.ts`：删 `rotateJpegBuffer` import，新增 `import sharp from 'sharp'` 与 `orientationToRotate` import；ensureRawPreview 抽取后：
  `const rotated = await sharp(extracted).rotate(orientationToRotate(photo.orientation)).toBuffer()`（angle=0 时 sharp rotate 无参语义不同——这里显式传 0 等于不旋转，保留统一调用）；tmp+rename 写盘逻辑不变。
- 删除 `electron/media/jpeg-autorotate.d.ts` 与 `tests/smoke/jpeg-js.d.ts`。

- [ ] **Step 4: 卸载依赖并验证传递依赖清理**

```bash
npm uninstall jpeg-autorotate
npm ls jpeg-js   # Expected: empty/Extraneous 报错消失，jpeg-js 不再出现在依赖树
```

- [ ] **Step 5: 跑受影响测试**

Run: `npx vitest run tests/media/orientation.test.ts tests/media/rawPreview.test.ts tests/smoke/raw-samples.test.ts`
Expected: 前两个全 PASS；raw-samples 在无 `samples/` 时整组 skip（现有 skip 机制），有样本时全 PASS。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: rotate RAW previews with sharp and drop jpeg-autorotate"
```

---

### Task 4: 删除 Blink 隐藏窗口子系统，fullflow 切换到真实 sharp

**Files:**
- Delete: `electron/media/blinkThumbnail.ts`、`electron/helper-preload.ts`、`src/helper.ts`、`src/helper.html`、`electron/shared/blinkProtocol.ts`、`tests/media/blinkProtocol.test.ts`
- Modify: `electron/main.ts`（删 configure/close 装配与两个生命周期钩子、import）
- Modify: `electron/media/protocol.ts`（删 helper 主机分支、corsHeadersFor 引用与响应头改写）
- Modify: `src/env.d.ts`（删 selightBlink 全局声明，文件可只剩 vite/client reference）
- Modify: `electron.vite.config.ts`（删 preload 的 helper 输入与 renderer 的 helper.html 输入）
- Modify: `tests/smoke/fullflow.test.ts`（删两个 vi.mock，缩略图段落改真实 sharp 断言；必须与删除同批，否则 mock 指向已删模块会整文件挂掉）

**Interfaces:**
- Consumes: Task 2 已让 thumbnails.ts 不引用 blinkThumbnail。
- Produces: 全仓 grep `blink|Blink|selightBlink|helper.html|helper-preload` 零命中（docs 与 git 历史除外）；`selight://` 协议只剩 thumb/photo 两个主机；vitest 全量套件不依赖任何已删模块。

- [ ] **Step 1: 先 grep 确认引用面**

Run: `grep -rn "blinkThumbnail\|blinkProtocol\|selightBlink\|helper-preload\|helper.html" electron src tests --include="*.ts" --include="*.tsx" --include="*.html"`
Expected: 命中文件与本任务 Files 清单一致；出现清单外文件先停下评估，不自行扩面。

- [ ] **Step 2: 删除六个文件**

按 Files 清单 Delete；其中 `tests/media/blinkProtocol.test.ts` 的纯契约覆盖随子系统一起退役（安全边界仍由 `tests/media/protocol.test.ts` 的 id 校验/路径逃逸用例保障）。

- [ ] **Step 3: 清理 main.ts**

删 import（configureBlinkThumbnail、closeBlinkHelper）、whenReady 内的 `configureBlinkThumbnail({...})` 整块、`win.on('closed')` 中的 closeBlinkHelper 调用（保留 mainWindow=null）、will-quit 中的 closeBlinkHelper 行（thumbQueue.stop、exiftool.end 保留）。

- [ ] **Step 4: 清理 protocol.ts 与构建入口**

- protocol.ts：删 `url.hostname === 'helper'` 分支、`corsHeadersFor` import 与 headers 改写循环，响应直接 `new Response(served.body, { status: served.status })`（保留外层 try/catch 403 兜底）。
- electron.vite.config.ts：preload.rollupOptions.input 只留 index；renderer.input 只留 index.html；main 的 harness 输入本任务不动（Task 5 处理）。
- env.d.ts：删 BlinkDecodeRequest import 与 Window 增强声明。

- [ ] **Step 5: fullflow.test.ts 去 mock 化（与删除同批，不可拆）**

删除顶部 electron 与 blinkThumbnail 两个 `vi.mock` 及 `decodeWebpThumbnail` import；缩略图测试段落改造：

- 删掉 `mockedBlink` 编排与全部调用次数断言。
- 20 个真实 webp 经 `createThumbnailQueue` 排队后，逐文件断言 SOI、sidecar 缺席、`sharp(file).metadata()` 长边 320。
- 缓存命中改用 mtimeMs：首轮记录每个产物 mtimeMs，二次 drain 后逐个比对不变，替代旧的 mock 调用计数。
- missing 占位段（直接 UPDATE missing=1）保留，断言 placeholder + sidecar。
- 旧的"mock reject 制造失败再恢复"段无法对只读 corpus 注入坏文件，改为：新建独立 DB 行指向 tmpdir 零字节文件，断言 `ensureThumbnail` 返回 placeholder + sidecar；再向同路径写入 sharp 生成的合法小 JPEG，删除其 sidecar 与产物后重跑，断言 `placeholder:false` 且 sidecar 消失。corpus 行与文件全程不动。
- `queue.stop()` 与其他六个测试段（import/classify/计时/restart/导出）不动。

- [ ] **Step 6: 全量验证**

Run: `npm run typecheck && npm test`
Expected: 全 PASS（本机素材存在时 fullflow 真实执行 sharp 解码；无 corpus 的机器该文件 describe.skip），无找不到模块残留。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove Blink helper window subsystem replaced by sharp"
```

---

### Task 5: smoke harness 与 fullflow 改造、文档收尾、全量回归

**Files:**
- Rename/rewrite: `tests/smoke/blink-harness.entry.ts` → `tests/smoke/media-harness.entry.ts`
- Rename/rewrite: `tests/smoke/electron-blink-harness.cjs` → `tests/smoke/electron-media-harness.cjs`
- Delete: `tests/smoke/electron-thumb-harness.cjs`（nativeImage webp 探针，使命结束）
- Modify: `electron.vite.config.ts`（main 输入 key `harness` → `media-harness`，输出 out/main/media-harness.js；raw-harness 保留）
- Modify: `tests/smoke/raw-samples-harness.entry.ts`（nativeImage.getSize 换 sharp metadata，注释更新）
- Modify: `README.md:73`（架构表缩略图行）
- Modify: `docs/superpowers/specs/2026-11-16-post-mvp-backlog.md`（登记一期证据与 RSS 数字）

**Interfaces:**
- Consumes: Task 2–4 的 sharp 管线与无 Blink 环境、Task 4 已全绿的 vitest 套件。
- Produces: 手动 harness 命令 `node tests/smoke/electron-media-harness.cjs`（build 后）与现有 raw harness 两条真机证据链；`npm test` 与 `npm run build` 全绿。

- [ ] **Step 1: 重写 media harness（原 blink harness 入口）**

保留：corpus 遍历、20 个等距采样、temp 目录清理、taskkill/WMI 零残留校验（cjs 外壳只改 harness 路径为 `out/main/media-harness.js` 与日志前缀）。

entry 新断言（真实 sharp 端到端，不再需要 helper 窗口/协议注册/白名单用例）：
- 控制 JPEG 用 sharp 生成（替代 jpeg-js/nativeImage control）。
- 20 个真实 webp 逐个 `ensureThumbnail`：`placeholder === false`、文件 SOI、`sharp(file).metadata()` width=320、无 sidecar、字节 ≠ PLACEHOLDER 常量；记录 p50/p95/max 耗时。
- 保留 vanished 源降级用例（注册行指向不存在文件 → placeholder + sidecar）。
- 输出 JSON 增加 `rss: { maxRssBytes: process.resourceUsage().maxRSS, peakHeapBytes: process.memoryUsage().heapUsed }` 与 `sharpConcurrency: 1`。
- 顶部注释改写为 sharp 管线说明。

- [ ] **Step 2: 删除 electron-thumb-harness.cjs 并改 vite 输入**

删文件；electron.vite.config.ts 的 main input 把 `harness: resolve('tests/smoke/blink-harness.entry.ts')` 换成 `'media-harness': resolve('tests/smoke/media-harness.entry.ts')`；同步 cjs 内的路径引用。

- [ ] **Step 3: raw-samples harness 去 nativeImage**

`import { nativeImage } from 'electron'` 与 `net` 中仅 nativeImage 部分替换：三处 `nativeImage.createFromBuffer(x).getSize()` 换 `await sharp(x).metadata()`；selight:// 协议 fetch 与路由断言保留（一期 photo 路由行为不变）；文件头注释"nativeImage 像素解码"改述为 sharp metadata。

- [ ] **Step 4: build + 两个 Electron harness 真机证据**

```bash
npm run build
node tests/smoke/electron-media-harness.cjs
node tests/smoke/electron-raw-samples-harness.cjs
```

Expected: 两个进程退出码 0、JSON `"ok":true`、WMI remainder 0；raw harness 无 samples 时 skipped 退出 0。把 media harness 的 decodeMs 与 rss 数字记到 backlog 一期条目。

- [ ] **Step 5: 更新文档**

- README:73 改为：`| 缩略图 | sharp(libvips) 统一解码，EXIF 方向烘焙，RAW 走 exiftool 内嵌预览 |`（与表格现有列对齐）。
- backlog 高优先 #1 下追加一期小节：日期、做法（sharp 替换三管线、Blink 删除）、harness 实测 decodeMs/RSS、安装包体积增量（`npm run pack:win` 后对比 dist 安装包大小，若本轮不打包则标注待补）。

- [ ] **Step 6: 最终验证与提交**

Run: `npm run typecheck && npm test && npm run build`
Expected: 全绿后提交。

```bash
git add -A
git commit -m "test: rebuild smoke harnesses on sharp and document phase-one metrics"
```

---

## Self-Review 记录

- **Spec 覆盖**：一期范围（sharp 接入、全格式缩略图、删三机制、harness/RSS）对应 Task 1–5；二期内容（scanner fs-only、EnrichmentService、media:ready、prioritize 修复、按需入队）明确不在本计划；三期 2048 预览不在；四期 backfill 不在。
- **接口稳定性**：ensureThumbnail/createThumbnailQueue/ensureRawPreview/orientationToRotate 签名均不变，main.ts 装配除 Blink 删除外无改动，preload/shared/api 零改动，SelightApi 表面稳定故 store.test.ts 无需动。
- **删除完整性**：Blink 六文件 + jpeg-autorotate 两文件 + 两个过时 harness/声明，每个删除点都有 Task 4 Step 1 的 grep 闸门兜底。
- **测试迁移**：jpeg-js 的两个直接使用者（raw-samples.test、electron-thumb-harness）已分别在 Task 3/5 处理；传递依赖卸载后 `npm ls jpeg-js` 验证无残留。
- **未覆盖的已知留白**：CMYK/1-bit 等冷门色彩模式未写硬断言（sharp 行为待真机偶遇）；macOS arm64 打包未验证；安装包体积增量需 pack 后回填——三项均在 spec 第 9 节风险清单内。
