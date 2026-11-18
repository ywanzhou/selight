# 工具栏重构与进度下沉设计（2026-11-18）

## 1. 背景与目标

当前顶部 `.toolbar` 是一条扁平的混合行：批次下拉、重命名/删除图标、新建批次、清缓存、导入/导出文字按钮，外加两块进度（`enrichProgress` 的「正在处理 x/y」与分类进度「已分 x / 共 y」+ 进度条）全部挤在一行，视觉上没有分组，状态信息占用工具栏空间。

目标：

- 顶部改为 macOS 访达/照片语言的**真正工具栏**：动作全部收为图标按钮，按职责用竖分隔线分组，名称靠 hover tooltip（`title` + `aria-label`）。
- 两块进度整体移到**左栏最底部**（缩略图网格之下），顶部不再显示任何状态。左栏在 inbox/文件夹/回收站三个视图都常驻，进度始终可见。
- 工具栏高度保持 52px 不变，窗口纵向空间零损失。

非目标：

- 不改任何状态模型、IPC、领域逻辑；纯表现层重构。
- 不改窗口框架（仍是系统原生标题栏，无应用内假标题栏）。
- 不做暗色模式、不引入新依赖。

## 2. 方案选择

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A. 图标 + 分隔线分组（选定）** | 批次下拉保留，动作全部图标化，分「批次管理 / 维护 / 导入导出」三组 | 最紧凑、最接近原生工具栏；可发现性靠 tooltip 保证，现有按钮本来就都带 `title`/`aria-label` |
| B. 文字按钮 + 分组线 | 保留现有图标+文字按钮，只加分隔线 | 改动最小但观感与现状差别不大，不满足「真正的工具栏」诉求 |
| C. 图标 + 下方小标签 | 垂直布局，工具栏加高到约 68px | macOS 正宗但多占 16px 纵向空间，窗口默认高度仅 670，得不偿失 |

选 A：高度不变、改动集中在组件与 CSS，tooltip 与无障碍标签现有代码已齐备。

## 3. 详细设计

### 3.1 工具栏结构（`src/components/Toolbar.tsx`）

从左到右：

```
[批次下拉 ▾]  │  [✎重命名] [🗑删除] [＋新建批次]  │  [🧹清缓存]  │  [⬇导入] [⬆导出]
```

- 批次选择器不再用原生 `<select>`，改为自定义 `BatchPicker`（见 3.4）；重命名内联输入替换触发器的机制不变。
- 三个分组之间插入新的 `.tb-divider` 竖分隔线（0.5px、高约 20px、`--color-separator`）。
- 所有动作按钮统一用现有 `.icon-btn`（22×22），中文 `title` + `aria-label`，禁用条件与现状完全一致。
- 导入中状态：导入按钮图标切换为新增的 `XmarkIcon`，tooltip 变「取消导入」，点击行为仍是 `cancelImport`（不再需要文字按钮）。
- 导出按钮保留 `.tb-btn-wrap` 包裹 span 承载禁用态 tooltip 的现有模式，内部按钮换 `.icon-btn`。
- 删除：`tb-enrich` 状态块、`tb-progress` 进度块及其计算（`total/classified/percent`）从 Toolbar 移走；`nothingToExport` 等导出禁用逻辑保留。
- 「清缓存」与批次删除的视觉区分原则不变（代码注释已说明），新图标用扫帚而非垃圾桶。

### 3.2 新增图标（`src/components/icons.tsx`）

沿用现有 SF Symbols 风格单色线性 SVG（stroke 1.7、`currentColor`）：

- `BroomIcon`：清缓存。
- `XmarkIcon`：取消导入（两条交叉线）。

### 3.3 CreateBatchButton 图标变体（`src/components/CreateBatchButton.tsx`）

该组件同时服务工具栏与空状态页（`EmptyState`）。新增可选 `icon?: boolean`：

- `icon` 为 true 时渲染 `.icon-btn` + `PlusIcon`，命名态切换 `InlineNameInput` 的行为不变。
- 默认（空状态页）保持现有文字按钮，空状态的引导 CTA 不降级。

### 3.4 批次选择器（新组件 `src/components/BatchPicker.tsx`，替换原生 select）

原生 `<select>` 的下拉面板由操作系统绘制，与应用的毛玻璃视觉语言不一致，且无法展示批次元信息。改为自定义 popover：

- **触发器**：28px 高渐变按钮，沿用原 `.tb-select` 的底色与阴影，内部为当前批次名（ellipsis）+ 12px 线性 chevron；展开时呈按下态。Toolbar 的重命名态仍把整个触发器替换为 `InlineNameInput`，机制不变。
- **面板**：绝对定位于触发器下方 6px，复用 `.context-menu` 的毛玻璃/圆角/阴影语言；每项两行——批次名（13px）+ 创建日期副标题（11px tertiary）；当前批次左侧蓝色 `CheckIcon`，非当前项用等宽隐藏占位防止文字横向跳动；长名称 ellipsis。
- **数据与行为**：列表取 `state.batches`（`BatchRow` 含 `createdAt`），选中 `state.batchId`，切换调 `openBatch`；无批次或 `loading` 时触发器 disabled、显示「无批次」、不弹面板。
- **关闭与定位**：外部 pointerdown、Esc、选中后关闭并把焦点还给触发器；右边缘溢出 clamp 照 `FolderContextMenu` 的 `min(px, calc(100vw - Npx))` 模式。
- **无障碍**：触发器 `aria-haspopup="listbox"` + `aria-expanded`；面板 `role="listbox"`，选项 `role="option"` + `aria-selected`；`↑`/`↓` 循环移动，`Enter` 确认。
- **纯逻辑下沉** `src/state/batchPicker.ts`（bare node 可测）：
  - `moveActiveIndex(current, length, direction)`：循环移动，`length === 0` 时返回 0。
  - `formatBatchDate(createdAt, now = Date.now())`：同一天 →「今天创建」；同年 →「M 月 D 日创建」；跨年 →「YYYY 年 M 月 D 日创建」。`now` 注入保证可测。
- **测试**：新增 `tests/renderer/batchPicker.test.ts`，覆盖循环导航边界与日期三档分支。
- 删除 `.tb-select` 样式规则与 Toolbar 中的原生 select 节点。副标题不显示照片张数：`BatchRow` 无计数字段，新增计数 IPC 超出本次重构范围。

### 3.5 左栏进度区（新组件 `src/components/SidebarProgress.tsx`）

- 组件自己消费 `useAppStore()` 取 `state.counts` 与 `state.enrichProgress`（与 `TrashCard` 同样的自包含模式，不走 props），由 `ThumbPane` 在 `thumbs-wrap`/空态提示之后渲染，成为左栏最底部块；inbox/文件夹/回收站三个视图下都常驻。
- 内容：`enrichProgress` 非空时显示「正在处理 done/total」（`role="status"`）；其下「已分 x / 共 y」+ 进度条；`counts === null`（首刷未完成）时按 0 渲染，不崩。
- 左栏宽 200px：进度条用修饰类 `.side-progress .bar { width: auto; flex: 1; }` 填满行宽（`.bar` 与 `ExportDialog` 共用，后者已有 `.export-bar` 覆盖宽度的先例，不动 `.bar` 基类）。
- 顶部加 0.5px 分隔线与内边距，`flex-shrink: 0` 固定在底部；无批次时整个 Workspace 不渲染，进度本就为 0，无需额外处理。

### 3.6 右栏新建入口去重（`src/components/FolderCards.tsx`）

现状有两个等价的新建文件夹入口：`side-head` 里的 ＋ 图标按钮和卡片网格末尾的「新建文件夹」虚线卡片（`.new-card`）。删除 header 的 ＋，保留 `.new-card`：

- 后者同时是 `creating` 态 `InlineNameInput` 的挂载点，删 header 按钮不牵动创建/改名交互，改动最小。
- 虚线卡片是更强的空态引导；单批次文件夹数量通常个位数，网格滚动导致不可达的问题不成立。
- `startCreate` 等逻辑不变，只删一个按钮节点。

### 3.7 CSS 变动（`src/styles/global.css`）

- 新增 `.tb-divider`、`.side-progress` 及其内部布局。
- 新增 `.batch-picker` / `.tb-picker-btn` / `.batch-menu` / `.batch-option` 系列（面板视觉对齐 `.context-menu`）。
- 删除 `.tb-progress`、`.tb-enrich`（后者本就无样式规则）、`.tb-select`（原生 select 被 BatchPicker 取代）。
- `.toolbar` 的 `gap: 12px` 微调为组内 8px / 组间靠 divider 自身 margin 拉开，避免分隔线两侧间距不均。
- 其余类（`.icon-btn`、`.tb-btn-wrap`、`.bar`）复用，不新增按钮语言。

## 4. 影响面与验证

- 不动 IPC/domain/schema，`SelightHandlers` 无变化，preload 无需重建。
- 渲染层测试是 node 环境纯函数测试，无组件/DOM 测试；`enrichProgress` 的 state 形状不变，`store.test.ts` 不受影响。新增 `tests/renderer/batchPicker.test.ts` 覆盖键盘循环导航与日期格式化分支，组件本身的浮层行为靠真机目检。
- 验证：`npm run typecheck` → 受影响测试 → `npm test` → 真机目检（tooltip、禁用态、导入中取消、BatchPicker 键盘导航/边缘定位、导入大量照片时左栏底部进度、空状态页按钮）。
