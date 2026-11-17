# 择影 MVP 后事项 Backlog

来源：2026-11-16 最终全分支总审（d2e5643..4b35497，38 commits）对全部延期 Minor 与新发现 Important 的逐项 triage。合并门事项（I1、gridGeometry 注释）在 MVP 内修复，不在此列。

## 高优先（第二批，小改动高回报）

1. **I3 单实例锁 + busy_timeout**：加 `app.requestSingleInstanceLock()` 与 `PRAGMA busy_timeout=5000`，防双实例 SQLITE_BUSY 与缓存 .tmp 竞争。
2. **I2 键盘导航滚动跟随**：react-window Grid ref 接 `scrollToItem`，方向键/分配后锚点保持在视口内（键盘过快片是核心工作流）。
3. **I4 文件夹名领域校验**：领域层加 `FolderNameInvalidError`（拒绝 `? * | < > " / \`、CON/NUL 保留名、`.`/`..`），InlineNameInput 前置中文提示；当前导出侧 containment 已封死安全面，代价是非法名文件夹必然导出失败。
4. **I6 assignToFolder 归属断言**：校验 folderId 属于当前批次且未软删，与 IPC 边界运行时参数校验同一轮做。

## 中优先

5. **I5 照片宽高入库**：exiftool read() 已返回 ImageWidth/ImageHeight，扫描期写入 photos.width/height，补全 spec §4.3 信息条的尺寸项（当前该条件恒假）。**（2026-11-17 二期完成：EnrichmentService 富化写入展示态宽高（6/8 交换），MetaBar 条件已生效。）**
6. **I7 占位缩略图重试**：提供"重试生成"动作（删 `<id>.jpg`+sidecar 后重新 enqueue），并顺手把 sidecar 写序调整为"先 marker 后图、先删 marker 后 rename"。**（2026-11-17 三期完成：`retryMedia(id, kind)` IPC 经 `retryMediaGeneration` 删缓存+sidecar 后重新入对应队列，PreviewPane 失败态提供重试按钮，缩略图与预览同函数覆盖。）**
7. **exiftool 扫描耗时优化**：现状 52.2s/1874（stay-open 单例串行 read 往返，后台不阻塞 UI）。webp 可免 exiftool（Blink imageOrientation:'from-image' 自带方向），jpg 仍需；优化后预期降幅明显。**（2026-11-17 二期完成并关闭：直读格式统一走 sharp.metadata 读方向与尺寸，exiftool 只服务 RAW；fs-only 发现 + EnrichmentService 有界并发池，实测见高优先 #1 二期条目。）**
8. **IPC 错误通知组件**：统一 window.alert/confirm 为 macOS 风格通知；错误原文直显改中文映射（FolderNameConflictError 等已有分支）。
9. **缓存 GC**：missing 占位死产物、长期失效缓存的清理策略。**（2026-11-17 四期完成：`planCacheCleanup` 纯函数只读选出孤儿 id、missing=1 死产物、孤立 sidecar（严格限定缓存根内数字命名文件），`runCacheCleanup` 执行并计数，`cleanupMediaCache` IPC + 工具栏手动入口，源文件零触碰。）**

## 低优先 / 整洁度

- listBatches 加 `, id DESC` 全序兜底；renameFolder 未知 id 静默 no-op 补钉死测试；openBatch 未知 id 改专属错误名。
- openDatabase catch 收窄到 SQLITE_NOTADB/SQLITE_CORRUPT；user_version 并入建表事务；损坏备份内容断言补强。
- isAllowedAbsPath 死导出接入生产白名单或删除；jpeg-js 提为显式 devDependency（当前是 jpeg-autorotate 传递依赖，harness 直接 import）。**（2026-11-17 随 Blink 子系统删除而失效：isAllowedAbsPath 所在的 blinkProtocol.ts 已删，jpeg-js/jpeg-autorotate 已移出依赖树。）**
- Blink helper：连续超时后 destroy 重建；helper 路由 containment node 负向测试；dev 模式 helper URL 首次 dev 联调手工关；卡死窗口回收。**（2026-11-17 整体 wontfix→已消除：Blink helper 被 sharp 管线取代，相关文件全部删除。）**
- Harness 债：两个 launcher 加 `child.on('error')`；app.exit 前显式清理 %TEMP% 目录或改 app.quit；空样本加 `--strict` 开关；samples 不可读时按 failures 语义 skip；SUPPORTED_EXT 从 formats.ts 同源导出；harness 进 release checklist。
- 渲染层：RecoveryDialog onClose useCallback；右键菜单 focus trap；重命名切换丢草稿；回收站拖到文件夹加 toast；showError 抽公共模块；saveSession 恢复视图一帧 inbox 闪烁；ExportDialog aria-valuemax 首帧与 progress 首事件时序；failures 字符串结构化；文件大小 KB/MB 自适应；未消费图标（Grid/List/Search）清理；selection 只写镜像清理；HANDLER_NAMES 由 IPC_CHANNELS 派生。
- 预览尺寸互换断言随 samples/ 激活自动闭环（harness 已写好）。

## 发行前必做

- build/icon.ico 应用图标（当前 Electron 默认图标）。
- 代码签名（未签名会触发 SmartScreen）。
- 离线可复现打包文档化（electron zip + SHASUMS256.txt 缓存）。
- README/操作手册 + 发布 checklist（含三个 smoke harness 的手工关卡）。
- ~~用户放入 samples/ 激活 skip 测试~~（2026-11-16 已部分完成）：samples/ 现有 3 个真实 ARW（DSC04571 方向 1 + DSC04572/4573 方向 8，均自素材复制、gitignored），RAW harness 全绿（314 passed/1 skipped），EXIF 8 竖拍端到端转正已实证。剩余：补一个带 EXIF Orientation 的普通 JPG 激活最后 1 个 skip；有 EXIF 6 的 ARW 时再放入以补 6 号方向真实证据。

## macOS 适配（计划在 Mac 上使用，2026-11-16 评估）

现状结论：无 Windows 专属硬编码混入生产代码（路径全用 path.join/resolve；main.ts 已有 window-all-closed、helper 窗生命周期两个正确的 darwin 分支；better-sqlite3 prebuilds 含 darwin-arm64/x64；exiftool-vendored 靠 optionalDependencies 自动切换 .pl 包）。属适配而非移植，无模块需重写。

### 阻断级（不做无法在 Mac 打包/分发）

1. **electron-builder mac 配置**：当前只有 nsis target。加 `mac` 段（dmg+zip、category、arm64/x64 双架构或 universal）、`pack:mac` 脚本、`build/icon.icns`。
2. **asarUnpack 平台 glob**：现仅解包 `exiftool-vendored.exe/**`；Mac 的 `exiftool-vendored.pl`（Perl 脚本+执行位）必须同样解包，否则 exiftool 无法运行。better-sqlite3 的 glob 通用，无需改。
3. **签名与公证**：Gatekeeper 对未签名应用直接拦截。正式分发需 Apple Developer ID + hardenedRuntime + notarize；内测可先 ad-hoc 签名（用户需 xattr 解除隔离）。
4. **harness darwin 进程管理**：tests/smoke 两个 .cjs 启动器用 taskkill /T /F + WMI，Mac 不适用；加 process.kill 进程树 + pgrep/ps 零残留校验的平台分支，否则自动化验证在 Mac 上失效。

### 功能/体验级

5. **红绿灯与工具栏重叠**：原生标题栏下 Mac 红绿灯占左上角约 70px，与批次下拉撞车。用 `titleBarStyle:'hiddenInset'` + 工具栏左侧安全区 padding。
6. **I4 文件夹名校验平台化**：Windows 禁 `? * | < > " / \` + CON/NUL 保留名；macOS(APFS) 实际只禁 `/`（Finder 里 `:` 有历史遗留）。校验规则按 process.platform 分流，不能共用一套黑名单。
7. **TCC 权限**：扫描 ~/Documents、桌面、外接盘可能触发系统授权弹窗；NSOpenPanel 选择的目录自动授权，递归未授权区域的错误要进现有 failures 清单而不是崩溃。
8. **性能重测**：52s/1874 扫描耗时是 Windows exe 版 exiftool 数据；Mac 上 .pl 版与 Apple Silicon/Intel 差异需实测，exiftool 优化（webp 免 exiftool）优先级可能提高。
9. **userData 路径验证**：Mac 上为 `~/Library/Application Support/择影/`，确认中文目录名与 session.json/缓存读写正常。

### 建议顺序

mac build 配置+解包 glob+icns（能出未签名 dmg）→ hiddenInset 布局走查 → harness darwin 分支并在真机跑通 314 测试与 RAW harness → I4 平台化 → 签名公证流水线。预估总工作量 3–5 人日（不含账号/CI 等待）。

## 用户实测问题（2026-11-16 macOS 真机走查）

1. **大批量导入卡死（900+ 张，无分页）**：`listPhotos`（electron/domain/photos.ts:134）无 LIMIT，整个视图一次性经 IPC 全量进渲染层 state；react-window 只虚拟化了 DOM，缩略图任务仍按全量入队（MediaQueue 并发 2，JPG 走整文件读取+jpeg-js 解码旋转，webp 走 Blink helper IPC 往返），导入扫描本身 exiftool stay-open 串行约 28ms/张（900 张约 25s 主进程繁忙）。方向：查询分页/窗口化 + 缩略图按需生成（仅视口附近 enqueue）+ 导入进度可取消；先 profile 确认卡点是 IPC 全量、主进程解码还是 exiftool 扫描。与中优先 #8 相关。**（2026-11-17 profile 实测更新，见 `2026-11-17-media-pipeline-sharp-design.md`：1874 文件实测 fs 遍历仅 136ms（隔离探针，热缓存），exiftool 串行扫描 52.6s 占 99%（JS 层 for-await 把 exiftool 多进程池饿死成单任务，并发 4 可降到 10s）；IPC 全量下发仅 713KB/5ms，排除分页必要性。同日完成一期：sharp 替换三管线，缩略图真机 p50 15.8ms/p95 21.5ms（旧 Blink p50 26ms）。二期：发现/富化分离 + 按需队列；三期：2048 预览层。）**
**（2026-11-17 二期完成：scanner 改 fs-only，`EnrichmentService` 单例双池（直读 4/RAW 2）后台富化，openBatch 按 `width IS NULL` 补偿；MediaQueue.prioritize 支持已排队 id 越级，协议 404 自动入队 + media:ready 事件驱动渲染层 nonce 重载。fullflow 真机实测关键路径 fs 扫描 3205ms + 入库 250ms（旧链路 52.6s 阻塞），1874 行富化后台 9773ms 不挡 UI；缩略图改为视口按需生成，不再全量入队。剩余三期：2048 预览层（含超大图 RSS 专项）。）**
2. **单张超大尺寸照片内存卡死**：两处全尺寸解码均无尺寸护栏——(a) 主进程 `rotateJpegBuffer`（media/orientation.ts:17）调 jpeg-autorotate 的 rotateBuffer，jpeg-js 把整张 JPEG 解码成 RGBA 裸缓冲（1 亿像素约 400MB+），随后 nativeImage 再解码一遍，队列并发 2 可叠加 OOM；(b) 渲染层 PreviewPane 的 `<img src=selight://photo/id>` 由 resolve.ts 直接返回**原文件**全尺寸字节，Blink 解码同样吃满渲染进程内存，webp 走 Blink helper 的 createImageBitmap 同理。方向：导入期读 width/height（本 backlog I5 已是前置）、超阈值走降采样/分区解码、预览改为受限尺寸的 preview 副本而非原图。**（2026-11-17 一期部分缓解：jpeg-autorotate/jpeg-js、nativeImage、Blink 全尺寸 createImageBitmap 三条路径已全部删除，缩略图改 libvips shrink-on-load（resize 在解码期生效，不再持有全尺寸 RGBA）；harness 实测进程 maxRSS ≈ 320MB（20 张样本，并发 1，超大图专项 RSS 仍待三期用 1 亿像素夹具补测）。渲染层原图直出未变，三期 2048 预览副本完成后本条才能关闭。）**
**（2026-11-17 三期完成并关闭：photo 路由统一只返回 previews 缓存的长边 2048 副本（`ensurePreview`，fit-inside + withoutEnlargement + shrink-on-load），渲染层再也拿不到源文件全尺寸字节，直读格式与 RAW 同构。media-harness 用 8000×6000 源（全尺寸 RGBA 约 192MB）实测输出 2048×1536 且该步 maxRSS 增量为 0、进程总 maxRSS ≈ 413MB；PreviewPane 三态（loading/missing/failed 可重试）。全尺寸无界解码路径至此全部消除。）**
3. **"导出的是配置文件而非分类产物"（待复现，与代码现状不符）**：现 `exportBatch`（electron/exporter.ts:69）实际是 `copyFile` 真实拷贝——按文件夹名在输出目录建子目录，只导出 status='folder' 的照片，inbox/回收站不导出，带进度与 failures。用户观察到的"配置文件"疑似：(a) userData 下自动保存的 session.json 被误认为导出物；(b) 没有任何已入文件夹的照片时导出结果为空目录。需与用户复现确认实际操作路径后再定方案（若诉求是"导出清单/配置"则是新需求，若为空目录则属 UX 提示问题：导出前应提示将拷贝 0 张）。**（2026-11-17 部分完成：空导出路径已封死——`counts.folder === 0` 时工具栏导出按钮禁用，外层 span 挂 title 说明原因；"配置文件"复现疑问仍待用户确认操作路径。）**
4. **新建批次支持自定义命名**：后端已就绪——`createBatch(db, name?)`（domain/batches.ts:36）与 IPC batchCreate 都透传可选 name，缺省才回退 `localDate()`。缺口纯在 UI：App.tsx:30 与 store.ts:143 的 `createBatch()` 均未传参。方向：复用 InlineNameInput 做命名输入（允许留空走日期默认），store/preload 签名补可选 name 参数。**（2026-11-17 已完成：新增 CreateBatchButton（工具栏与空状态页复用），InlineNameInput 加 allowBlank 支持留空走日期默认，store thunk 透传可选 name；preload/domain 本已就绪。同日补齐批次重命名：renameBatch 全链路 + 工具栏铅笔按钮原位内联编辑，不碰 last_opened_at 以保下拉排序；批次名无唯一约束（日期默认名允许重复），故不做冲突校验。）**

## 计划外完成项（2026-11-17）

- **批次硬删除**：用户确认采用硬删而非软删（软删需 schema v3 迁移与恢复入口，成本不匹配）。`deleteBatch` 单事务按 FK 顺序删 actions → photos → folders → sources → batches，返回照片 id 由 IPC 层尽力清理 thumbnails/previews 缓存（单个文件失败不影响已提交删除）；工具栏确认弹窗明示不可撤销、原文件不动；删后自动打开最近批次或回到空工作区。已知残留：删除瞬间在写的缩略图任务可能留孤儿缓存，AUTOINCREMENT id 不复用故无正确性问题，归缓存 GC（中优先 #9）兜底。
- **预览大图可拖拽 + 拖拽后自动预览下一张**：预览舞台成为 HTML5 拖拽源（载荷契约与缩略图网格一致）；FolderCard/TrashCard 的 drop 处理改用 pinSelection/nextSelectionId，替代原来的 selection.clear()，拖放后锚点自动落到下一张剩余照片。
- **回收站改为底部固定横条**：TrashCard 移出滚动的 .cards 网格，文件夹再多也无需滚动即可拖放。
- **0 键移回待分类**：moveToInbox 领域动作（单动作组、可 Ctrl+Z），仅文件夹视图响应，避免给 inbox/trash 照片写无意义动作行污染撤销栈。

## 总审 wontfix 记录（接受现状）

ext NOT NULL、status/orientation 无 CHECK、备份毫秒冲突、getFolder 私有约定、索引兜底错误翻译、markMissing 分块上限、自转移审计行、from_status 可空类型、migrate 无 else、upsertSource 竞态、exiftool.end 超时、stat EACCES 可移植性、并发双写、双重缩放、TOCTOU/符号链接、固定 .tmp 名、react-window 滚动指标、undone 死选取、stateRef 时序、missing 冗余 mediaUrl、Esc 拖拽 hover、fan-out 计数（Ruling 16 实测关闭）、session 形状校验、harness 不进安装包、thumb/preview_path 预留列、EXIF-6 注释已在。
