# 导出改为 JSON 清单设计（2026-11-18）

## 1. 背景与目标

现状导出（`electron/exporter.ts`）把已分类照片按文件夹 `copyFile` 原文件到选定目录。婚礼 RAW 单场几十 GB，复制慢且占双份空间；实际工作流是：择影只负责出「分类清单」，精修同事用自己的 Python 脚本按清单从共享存储/挂载盘取片。

目标：

- 导出产物从「照片目录」替换为**一个 JSON 清单文件**，描述每个文件夹包含哪些照片及其定位信息。
- 复制照片能力整体下线（含进度事件、选目录对话框、复制引擎与相关测试），不保留双模式。
- 「读 JSON 还原真实文件」的小工具本期不做，登记 backlog。

非目标：

- 不做清单的回导/在另一台机器恢复分类（那是会话/备份范畴，另议）。
- 不做导出模板、CSV 等其他格式。
- 不做读清单还原真实文件的取片小工具与 Python 示例脚本（用户明确后置，登记 backlog）。
- 不改任何分类领域逻辑与磁盘只读原则；清单写入只发生在用户选定的目标文件。

## 2. 清单格式

UTF-8、无 BOM、2 空格缩进、末尾换行的 JSON：

```json
{
  "kind": "selight-manifest",
  "version": 1,
  "batch": { "id": 3, "name": "2026-11-18 婚礼跟拍", "exportedAt": "2026-11-18T18:30:00.000Z" },
  "sources": [
    { "id": 1, "root": "E:/婚礼/原片" }
  ],
  "folders": [
    {
      "id": 7,
      "name": "全家福",
      "photos": [
        {
          "sourceId": 1,
          "path": "仪式/IMG_0231.ARW",
          "absPath": "E:/婚礼/原片/仪式/IMG_0231.ARW",
          "filename": "IMG_0231.ARW",
          "sizeBytes": 64172800,
          "missing": false
        }
      ]
    }
  ]
}
```

字段约定：

- `sources[].root`：导入根目录（`sources.abs_path`），正斜杠归一化。同事脚本把 root 替换成本机挂载点后，`root + path` 即取片路径。
- `photos[].path`：相对 source root 的路径，`path.relative(root, absPath)` 计算后把 `path.sep` 统一替换为 `/`，保证 Windows 产出的清单在 Mac/Linux 脚本里可用。递归导入的子目录结构完整保留——纯 filename 会在不同子目录重名时冲突，不能作为定位键。
- `absPath` 保留备查；`filename` 给同事做日志/重命名方便；`sizeBytes` 供脚本校验拷贝完整性。
- `missing: true`（源文件已不存在的记录）照常列入清单，由脚本决定跳过并告警，而不是悄悄少片。
- 只含 `status='folder'` 照片：待分类、回收站天然排除（回收站行保留 folder_id 但 status 不是 folder，`listPhotos(kind:'folder')` 已保证）；空文件夹不输出。
- `kind` 常量与 `version` 整数让未来的取片工具能识别和演进格式。

## 3. 方案选择

| 方案 | 取舍 |
|---|---|
| **A. 保存文件对话框 + 单 JSON（选定）** | 产物是「一个文件」，showSaveDialog 让用户控制文件名与位置；新增一个 dialog IPC，preload 需 build+重启 |
| B. 沿用选目录、固定文件名写入 | 不加 dialog IPC，但用户控制不了文件名，清单与目录内其他文件混杂，重名要自己做 `(1)` 逻辑 |
| C. 复制与清单双模式并存 | 被用户否决：本期只要清单，复制能力由未来的独立小工具承担，保留双模式只会留下两条要维护的导出链路 |

## 4. 详细设计

### 4.1 领域层（新 `electron/manifest.ts`，electron-free）

照 `exporter.ts` 的纯工厂模式，只依赖 node:fs/path 与 better-sqlite3 句柄，可在 bare Node 测试：

- `buildManifest(db, batchId, now = Date.now()): Manifest`：查批次名、sources、非空文件夹与其 folder 视图照片（复用 `listFolders`/`listPhotos`），组装 §2 结构。纯数据、不写盘。
- `writeManifest(targetPath, manifest): Promise<void>`：同目录 sibling `.tmp` 写入后 rename（沿用 sessionStore/媒体缓存的防半截模式），`JSON.stringify(manifest, null, 2) + '\n'`。
- `exportManifest(db, batchId, targetPath, now?): Promise<ManifestResult>`：组合两者，返回 `{ targetPath, folderCount, photoCount, missingCount }` 供结果弹窗展示。
- 路径归一化抽成纯函数 `toPosix(p: string): string`，单测覆盖。
- 安全文件名 `safeFileName(name)`：批次名中 `\\ / : * ? " < > |` 替换为 `_`，trim 后为空回退 `manifest`，用于保存对话框默认名。

### 4.2 IPC 与 preload

删除：`exportBatch`、`onExportProgress`/`exportProgress` 通道、`pickExportDirectory`/`dialogPickExportDirectory`、`HandlerDeps.onExportProgress` 注入、`ExportResult`/`ExportProgressEvent` 类型。

新增（`electron/shared/api.ts` 常量与类型同步）：

- `pickExportFile(suggestedName: string): Promise<string | null>` → 通道 `selight:dialog:pick-export-file`。main 侧 `showSaveDialog`，filters 为 `[{ name: 'JSON', extensions: ['json'] }]`；用户未输入 `.json` 后缀时代码补全（Electron 不自动补）；取消返回 null。
- `exportManifest(batchId: number, targetPath: string): Promise<ManifestResult>` → 通道 `selight:export:manifest`，handler 工厂内实现，无 Electron 依赖。
- `openPath` 守卫保留：`lastExportDir` 改记 targetPath 的 `dirname`，「打开所在目录」行为与安全边界不变。

preload、main 注册、`tests/renderer/store.test.ts` 的 `HANDLER_NAMES` 假 API 表三处同步（CLAUDE.md §3 强约束，类型强转会掩盖漏改）。本改动涉及 preload，交付前必须 `npm run build` 并完全重启应用验证。

### 4.3 渲染层

- `store.ts`：thunk `exportManifest(deps, targetPath)`，无打开批次时返回 null（照现有 exportBatch 的 no-op 模式）；删旧 thunk。
- `App.tsx`：流程改为 `pickExportFile(safeFileName(批次名))` → 取消则结束 → `exportManifest`；`ExportRun` 简化为 `{ targetPath, result: ManifestResult | null }`。
- `ExportDialog.tsx` 保留文件名、改造内容：去掉进度条与 `onExportProgress` 订阅；进行态为简单 loading；结果态显示文件夹数、照片数、missing 数（>0 时红色提示）、目标路径与「打开所在目录」。
- `Toolbar.tsx`：按钮与 `nothingToExport` 禁用逻辑不动，导出按钮 tooltip 文案改为「导出分类清单」。

### 4.4 测试

- 删 `tests/exporter.test.ts`；新建 `tests/manifest.test.ts`（真实临时 sqlite，照 domain 测试模式）：
  - 结构断言：kind/version/batch/sources 形状与计数
  - 递归子目录照片的 `path` 为正斜杠相对路径、`sourceId` 正确关联（多 source 夹具）
  - inbox/trash 排除、空文件夹排除、missing 标记保留
  - `safeFileName` 非法字符与空名回退；`writeManifest` 落盘可重新 parse 且无 `.tmp` 残留
- `tests/ipc.contract.test.ts`：export 段重写为 `exportManifest` 计数契约与新通道探针；删除 `onExportProgress` 录制桩。
- `tests/renderer/store.test.ts`：HANDLER_NAMES 换名，两个 export thunk 用例改写为 manifest 版。
- `tests/smoke/fullflow.test.ts` 第 7 段（默认 skip）：复制断言改写为 manifest 断言（分组数、各组照片数、回收站不在清单、源语料 size/mtime 不变）。

## 5. 影响面与验证

- 不碰 schema/domain 分类动作/媒体管线；`electron/exporter.ts` 整文件删除。
- 验证顺序：`npm run typecheck` → 受影响测试 → `npm test` → `npm run build`（preload 变更）→ 真机目检（保存/取消/无后缀补全/无权限路径报错/结果弹窗打开目录）。
- backlog 登记一条：「manifest 取片小工具：读 selight-manifest JSON 还原真实文件目录」。
