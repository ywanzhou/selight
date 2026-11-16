# 择影 MVP 后事项 Backlog

来源：2026-11-16 最终全分支总审（d2e5643..4b35497，38 commits）对全部延期 Minor 与新发现 Important 的逐项 triage。合并门事项（I1、gridGeometry 注释）在 MVP 内修复，不在此列。

## 高优先（第二批，小改动高回报）

1. **I3 单实例锁 + busy_timeout**：加 `app.requestSingleInstanceLock()` 与 `PRAGMA busy_timeout=5000`，防双实例 SQLITE_BUSY 与缓存 .tmp 竞争。
2. **I2 键盘导航滚动跟随**：react-window Grid ref 接 `scrollToItem`，方向键/分配后锚点保持在视口内（键盘过快片是核心工作流）。
3. **I4 文件夹名领域校验**：领域层加 `FolderNameInvalidError`（拒绝 `? * | < > " / \`、CON/NUL 保留名、`.`/`..`），InlineNameInput 前置中文提示；当前导出侧 containment 已封死安全面，代价是非法名文件夹必然导出失败。
4. **I6 assignToFolder 归属断言**：校验 folderId 属于当前批次且未软删，与 IPC 边界运行时参数校验同一轮做。

## 中优先

5. **I5 照片宽高入库**：exiftool read() 已返回 ImageWidth/ImageHeight，扫描期写入 photos.width/height，补全 spec §4.3 信息条的尺寸项（当前该条件恒假）。
6. **I7 占位缩略图重试**：提供"重试生成"动作（删 `<id>.jpg`+sidecar 后重新 enqueue），并顺手把 sidecar 写序调整为"先 marker 后图、先删 marker 后 rename"。
7. **exiftool 扫描耗时优化**：现状 52.2s/1874（stay-open 单例串行 read 往返，后台不阻塞 UI）。webp 可免 exiftool（Blink imageOrientation:'from-image' 自带方向），jpg 仍需；优化后预期降幅明显。
8. **IPC 错误通知组件**：统一 window.alert/confirm 为 macOS 风格通知；错误原文直显改中文映射（FolderNameConflictError 等已有分支）。
9. **缓存 GC**：missing 占位死产物、长期失效缓存的清理策略。

## 低优先 / 整洁度

- listBatches 加 `, id DESC` 全序兜底；renameFolder 未知 id 静默 no-op 补钉死测试；openBatch 未知 id 改专属错误名。
- openDatabase catch 收窄到 SQLITE_NOTADB/SQLITE_CORRUPT；user_version 并入建表事务；损坏备份内容断言补强。
- isAllowedAbsPath 死导出接入生产白名单或删除；jpeg-js 提为显式 devDependency（当前是 jpeg-autorotate 传递依赖，harness 直接 import）。
- Blink helper：连续超时后 destroy 重建；helper 路由 containment node 负向测试；dev 模式 helper URL 首次 dev 联调手工关；卡死窗口回收。
- Harness 债：两个 launcher 加 `child.on('error')`；app.exit 前显式清理 %TEMP% 目录或改 app.quit；空样本加 `--strict` 开关；samples 不可读时按 failures 语义 skip；SUPPORTED_EXT 从 formats.ts 同源导出；harness 进 release checklist。
- 渲染层：RecoveryDialog onClose useCallback；右键菜单 focus trap；重命名切换丢草稿；回收站拖到文件夹加 toast；showError 抽公共模块；saveSession 恢复视图一帧 inbox 闪烁；ExportDialog aria-valuemax 首帧与 progress 首事件时序；failures 字符串结构化；文件大小 KB/MB 自适应；未消费图标（Grid/List/Search）清理；selection 只写镜像清理；HANDLER_NAMES 由 IPC_CHANNELS 派生。
- 预览尺寸互换断言随 samples/ 激活自动闭环（harness 已写好）。

## 发行前必做

- build/icon.ico 应用图标（当前 Electron 默认图标）。
- 代码签名（未签名会触发 SmartScreen）。
- 离线可复现打包文档化（electron zip + SHASUMS256.txt 缓存）。
- README/操作手册 + 发布 checklist（含三个 smoke harness 的手工关卡）。
- ~~用户放入 samples/ 激活 skip 测试~~（2026-11-16 已部分完成）：samples/ 现有 3 个真实 ARW（DSC04571 方向 1 + DSC04572/4573 方向 8，均自素材复制、gitignored），RAW harness 全绿（314 passed/1 skipped），EXIF 8 竖拍端到端转正已实证。剩余：补一个带 EXIF Orientation 的普通 JPG 激活最后 1 个 skip；有 EXIF 6 的 ARW 时再放入以补 6 号方向真实证据。

## 总审 wontfix 记录（接受现状）

ext NOT NULL、status/orientation 无 CHECK、备份毫秒冲突、getFolder 私有约定、索引兜底错误翻译、markMissing 分块上限、自转移审计行、from_status 可空类型、migrate 无 else、upsertSource 竞态、exiftool.end 超时、stat EACCES 可移植性、并发双写、双重缩放、TOCTOU/符号链接、固定 .tmp 名、react-window 滚动指标、undone 死选取、stateRef 时序、missing 冗余 mediaUrl、Esc 拖拽 hover、fan-out 计数（Ruling 16 实测关闭）、session 形状校验、harness 不进安装包、thumb/preview_path 预留列、EXIF-6 注释已在。
