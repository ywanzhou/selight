# 工具栏重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把顶部混合行重构为图标分组的真正工具栏，批次选择器换成自定义 popover，两块进度下沉到左栏底部，并去掉右栏重复的新建入口。

**Architecture:** 纯表现层重构，不动 IPC/domain/schema。可测逻辑（键盘循环导航、日期格式化）下沉到 `src/state/batchPicker.ts` 走 bare-node 测试；浮层组件复用 `FolderContextMenu` 的关闭/定位模式；进度组件自包含消费 store，与 `TrashCard` 同构。

**Tech Stack:** React 19 + TypeScript strict、Vitest（node 环境，无 jsdom）、现有 CSS token 与 `.context-menu`/`.icon-btn`/`.bar` 类，无新依赖。

**Spec:** `docs/superpowers/specs/2026-11-18-toolbar-redesign-design.md`

## Global Constraints

- 不执行 `git add/commit/push`：用户未明确发话前所有改动留在工作区，计划不含 commit 步骤；开工前先与用户确认是否开 `feat/toolbar-redesign` 分支。
- 代码标识符与注释用英文，用户可见文案用中文；不新增运行时依赖、不引入 DOM 测试库。
- 不改 `electron/`、`electron/shared/api.ts`、preload；`SelightHandlers` 无变化，无需重建 preload。
- 验证顺序：`npm run typecheck` → 受影响测试 → `npm test`；本计划纯渲染层改动，最后一个任务跑一次 `npm run build` 兜底。
- 磁盘只读原则与本计划无关，不触碰任何文件系统写逻辑。

## File Structure

- Create: `src/state/batchPicker.ts` — DOM-free 纯逻辑：`moveActiveIndex`、`formatBatchDate`
- Create: `src/components/BatchPicker.tsx` — 自定义批次 popover（listbox 语义、键盘导航、外部点击/Esc 关闭）
- Create: `src/components/SidebarProgress.tsx` — 左栏底部进度区，自包含消费 `useAppStore`
- Create: `tests/renderer/batchPicker.test.ts` — 纯函数表驱动测试
- Modify: `src/components/icons.tsx` — 新增 `BroomIcon`、`XmarkIcon`（SF Symbols 风格线性 SVG，stroke 1.7/2、currentColor）
- Modify: `src/components/Toolbar.tsx` — BatchPicker 替换 select；动作全部图标化 + `.tb-divider` 分组；删除 enrich/进度标记
- Modify: `src/components/CreateBatchButton.tsx` — 新增可选 `icon?: boolean` 变体
- Modify: `src/components/ThumbPane.tsx` — 侧栏末尾挂载 `SidebarProgress`
- Modify: `src/components/FolderCards.tsx` — 删除 `side-head` 里的 ＋ 按钮（保留 `.new-card`）
- Modify: `src/styles/global.css` — 新增 divider/picker/side-progress 样式；删除 `.tb-select`、`.tb-progress` 规则

## Review Focus

1. 日期格式化的同日/同年/跨年三档与月末边界 → Task 1 的 `formatBatchDate` 表测试固定。
2. 键盘导航在单批次、空批次列表下不越界 → Task 1 的 `moveActiveIndex` 边界测试固定。
3. 零批次或 `loading` 时 BatchPicker 触发器禁用且点击不弹面板 → 无 DOM 测试设施，Task 2 步骤写明守卫条件，Task 5 真机清单核对。
4. `counts === null`（首刷中）进度区按 0 渲染不崩 → Task 4 用 `?? 0` 守卫，Task 5 真机清单核对加载瞬间。
5. 超长批次名在触发器与菜单中都 ellipsis、菜单在窗口右边缘不溢出 → 纯 CSS/定位行为，Task 2 实现 clamp，Task 5 真机清单核对。

---

### Task 1: batchPicker 纯逻辑与测试

**Files:**
- Create: `src/state/batchPicker.ts`
- Test: `tests/renderer/batchPicker.test.ts`

**Interfaces:**
- Consumes: 无（DOM-free，仅 `Date`  getter）
- Produces:
  - `export type PickerDirection = 1 | -1`
  - `export function moveActiveIndex(current: number, length: number, direction: PickerDirection): number`
  - `export function formatBatchDate(createdAt: number, now: number = Date.now()): string`

- [ ] **Step 1: 写失败测试** `tests/renderer/batchPicker.test.ts`，仿 `tests/renderer/gridGeometry.test.ts` 的 describe/it 风格，固定 `now = new Date(2026, 10, 18, 15, 0).getTime()`（2026-11-18 下午 3 点）：
  - `moveActiveIndex`：前进 `(0,3,1)→1`、`(2,3,1)→0` 循环；后退 `(0,3,-1)→2`、`(2,3,-1)→1`；单元素 `(0,1,±1)→0`；空列表 `(0,0,±1)→0`；越界 current 收敛 `(-1,3,1)→0`、`(5,3,-1)→2`。
  - `formatBatchDate`：同日 9 点 → `'今天创建'`；同年 `new Date(2026, 10, 12)` → `'11 月 12 日创建'`；跨年 `new Date(2025, 4, 30)` → `'2025 年 5 月 30 日创建'`。
- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/renderer/batchPicker.test.ts`
Expected: FAIL，模块不存在。
- [ ] **Step 3: 实现 `src/state/batchPicker.ts`**
  - `moveActiveIndex`：`length <= 0` 返回 0；current 越界时 direction=1 收敛到 0、-1 收敛到 `length-1`；否则 `(current + direction + length) % length`。
  - `formatBatchDate`：对 `createdAt` 与 `now` 各建 `Date`，比较 `getFullYear/getMonth/getDate`：日相同 → `今天创建`；年相同 → `M 月 D 日创建`；否则 `YYYY 年 M 月 D 日创建`。月份/日期直接取 getter 原值（1 起的月要 +1）。
- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/renderer/batchPicker.test.ts`
Expected: PASS（全部用例）。
- [ ] **Step 5: 类型检查**

Run: `npm run typecheck`
Expected: 零错误。

---

### Task 2: BatchPicker 组件替换原生 select

**Files:**
- Create: `src/components/BatchPicker.tsx`
- Modify: `src/components/Toolbar.tsx`（select 节点与重命名分支）
- Modify: `src/styles/global.css`（新增 picker 系列、删 `.tb-select`）

**Interfaces:**
- Consumes: Task 1 的 `moveActiveIndex`、`formatBatchDate`；`BatchRow`（`electron/shared/api.ts`，字段 `id/name/createdAt/lastOpenedAt`）；`CheckIcon`、现有 `useAppStore` 的 `openBatch`
- Produces:
  - `interface BatchPickerProps { batches: BatchRow[]; batchId: number | null; loading: boolean; onOpen: (batchId: number) => void }`
  - `export default function BatchPicker(props: BatchPickerProps): JSX.Element`

- [ ] **Step 1: 实现 `BatchPicker.tsx`**
  - 触发器 `button.tb-picker-btn`：`aria-haspopup="listbox"`、`aria-expanded` 跟随 open 态；`disabled = batches.length === 0 || loading`，禁用时文字「无批次」，否则显示当前批次名（`batches.find(b => b.id === batchId)?.name ?? ''`）+ 12px chevron（内联 SVG，与原型同路径 `M6 9l6 6 6-6`）。
  - 面板 `div.batch-menu[role="listbox"]`，绝对定位于触发器下方；选项 `button.batch-option[role="option"][aria-selected]`，每行：`CheckIcon`（选中项原色，其余加占位 class 保持等宽）+ `.bo-text` 内 `.bo-name` 与 `.bo-date`（`formatBatchDate(batch.createdAt)`）。
  - 状态：`open`、`activeIndex`。打开时 active 初始化为当前 `batchId` 的下标（找不到则 0），并 focus 对应选项；关闭规则照搬 `FolderCards.tsx` 的 `FolderContextMenu`：window `pointerdown` 外部关闭、`keydown` capture 阶段 Esc 关闭、`resize`/`scroll` 关闭。
  - 键盘：面板内 `ArrowDown/ArrowUp` 调 `moveActiveIndex` 并 focus；`Enter` 选当前 active 项 → `onOpen(batch.id)`、关闭、焦点回触发器；触发器上 `ArrowDown/Enter/Space` 打开。
  - 定位 clamp：面板 `style.left = min(0px, calc(100vw - 触发器右缘 - 248px))` 思路同 `FolderContextMenu` 的 viewport clamp（菜单 min-width 230 + 边距），保证不溢出右边缘。
- [ ] **Step 2: 接入 Toolbar**
  - 删除原生 `<select className="tb-select">` 节点，重命名分支保持原样（`renaming === true` 时渲染 `InlineNameInput`，否则渲染 `<BatchPicker batches={batches} batchId={batchId} loading={loading} onOpen={(id) => void openBatch(id).catch(showError)} />`）。
  - 先 grep 确认 `.tb-select` 无其他使用方：`Grep "tb-select" src`，然后删除 `global.css` 的 `.tb-select` 规则。
- [ ] **Step 3: 新增 CSS**（值对齐原型与 `.context-menu` 语言）
  - `.batch-picker{position:relative}`；`.tb-picker-btn` 28px 高、渐变底、阴影与原 `.tb-select` 一致，含 `.bp-label`（ellipsis）与 `.bp-chev`（12px、tertiary 色）。
  - `.batch-menu`：`position:absolute; top:calc(100% + 6px); z-index:120; min-width:230px; padding:4px`，毛玻璃/圆角/阴影照抄 `.context-menu`；`.batch-option` 两行布局、hover/active 用 `--bg-control`；`.bo-check` 14px 蓝色，`.bo-check.placeholder{visibility:hidden}`；`.bo-name` 13px ellipsis，`.bo-date` 11px tertiary。
- [ ] **Step 4: 验证**

Run: `npm run typecheck`
Expected: 零错误。组件无单元测试（无 jsdom），行为留 Task 5 真机清单。

---

### Task 3: 工具栏图标化与分组

**Files:**
- Modify: `src/components/icons.tsx`
- Modify: `src/components/Toolbar.tsx`
- Modify: `src/components/CreateBatchButton.tsx`
- Modify: `src/styles/global.css`

**Interfaces:**
- Consumes: 现有 `PencilIcon/TrashIcon/ImportIcon/ExportIcon/PlusIcon`；Task 2 的 BatchPicker
- Produces: `CreateBatchButton` 新增可选 prop `icon?: boolean`（默认 false，空状态页行为不变）

- [ ] **Step 1: 新增两个图标** `icons.tsx`
  - `XmarkIcon`：路径 `M6 6l12 12M18 6 6 18`，stroke-width 2、round cap（取消导入用）。
  - `BroomIcon`：与原型同路径的扫帚造型，stroke-width 1.7、round cap/join（清缓存用，刻意区别于 TrashIcon）。
- [ ] **Step 2: `CreateBatchButton` 加 icon 变体**
  - `icon === true` 且非 naming 态时渲染 `button.icon-btn`（title/aria-label「新建批次」，内嵌 `PlusIcon`），disabled 条件不变；naming 态仍渲染原 `batch-name-input` 插槽；默认分支保持现有 `.tb-btn` 文字按钮。
- [ ] **Step 3: 重构 Toolbar 布局**（顺序与分隔线按设计稿 3.1）
  - `BatchPicker` → `.tb-divider` → 重命名/删除/`CreateBatchButton icon` 三个 `.icon-btn` → `.tb-divider` → 清缓存 `.icon-btn`（BroomIcon）→ `.tb-divider` → 导入按钮 + 导出按钮。
  - 所有按钮保留现有 `title`/`aria-label` 中文文案与现有 disabled 条件；删除按钮加 `danger` 修饰 class（hover 变红，样式加到 `.icon-btn.danger:hover`）。
  - 导入中：按钮图标在 `ImportIcon`/`XmarkIcon` 间切换，title 在「导入文件夹」/「取消导入」间切换，点击处理函数不变；`importing` 本地 state 与防重复提交逻辑保留。
  - 导出：保留 `.tb-btn-wrap` span 承载禁用 tooltip 的模式，内部按钮换 `.icon-btn`。
  - 删除 `tb-enrich`、`tb-progress` 两块 JSX 及 `total/classified/percent` 计算（`nothingToExport` 保留）。
- [ ] **Step 4: CSS**
  - 新增 `.tb-divider`（0.5px 宽、20px 高、`--color-separator`、左右 margin 6px）；`.toolbar` gap 改 8px。
  - 新增 `.icon-btn.danger:hover:not(:disabled){color:var(--color-red)}`；`.icon-btn` 尺寸从 22px 提到 28px 以匹配新工具栏密度（同步检查 `.side-head` 内 icon-btn 不受影响——给侧栏 header 的按钮保留 22px，作用域写法 `.side-head .icon-btn{width:22px;height:22px}`）。
  - 删除 `.tb-progress` 规则；确认 `.tb-enrich` 本就无 CSS 规则。
- [ ] **Step 5: 验证**

Run: `npm run typecheck && npx vitest run tests/renderer/store.test.ts`
Expected: 零类型错误；store 测试全过（state 形状未动）。

---

### Task 4: 左栏底部进度区

**Files:**
- Create: `src/components/SidebarProgress.tsx`
- Modify: `src/components/ThumbPane.tsx`
- Modify: `src/styles/global.css`

**Interfaces:**
- Consumes: `useAppStore()` 的 `state.counts: Counts | null`、`state.enrichProgress: EnrichProgressEvent | null`；现有 `.bar` 类
- Produces: 无对外接口；默认导出组件，无 props

- [ ] **Step 1: 实现 `SidebarProgress.tsx`**
  - 自包含 `useAppStore()`，与 `TrashCard` 同构，无 props。
  - `const total = counts?.total ?? 0`、`const classified = total - (counts?.inbox ?? 0)`、`const percent = total > 0 ? (classified / total) * 100 : 0`（逻辑搬自旧 Toolbar）。
  - JSX：`div.side-progress`；`enrichProgress !== null` 时渲染 `div.sp-enrich[role="status"]`，文案 `正在处理 {done}/{total}`；其下 `div.sp-count` 左 `已分 {classified} / 共 {total}` 右 `{Math.round(percent)}%`；再下 `div.bar[role="progressbar"]`（aria 三件套照抄旧实现）内含 `i`，width 用 `percent%`。
- [ ] **Step 2: 挂载到 `ThumbPane.tsx`**
  - 在 `<aside>` 内、空态 `<p className="pane-empty">` 或 `.thumbs-wrap` 之后渲染 `<SidebarProgress />`（两种视图分支汇合处，保证空态也显示）。
- [ ] **Step 3: CSS**
  - `.side-progress`：`flex-shrink:0`、顶部 `border-top: var(--hairline)`、padding `10px 14px 12px`、flex 列 gap 6px、12px secondary 字色。
  - `.sp-enrich` 蓝色 + tabular-nums；`.sp-count` flex 两端对齐 + tabular-nums；`.side-progress .bar{width:auto;flex:1}` 覆盖基类 130px 固定宽（不动 `.bar` 基类，`.export-bar` 同样依赖该模式）。
- [ ] **Step 4: 验证**

Run: `npm run typecheck && npx vitest run tests/renderer`
Expected: 零类型错误；renderer 全部测试通过。

---

### Task 5: 右栏去重与全量验证

**Files:**
- Modify: `src/components/FolderCards.tsx`
- Modify: `src/styles/global.css`（仅在出现死规则时清理）

**Interfaces:**
- Consumes: 无新接口
- Produces: 无

- [ ] **Step 1: 删除 `FolderCards.tsx` 中 `side-head` 里的 ＋ `icon-btn`**（含 import 中随之失去唯一引用的 `PlusIcon`——注意 `.new-card` 仍用 `PlusIcon`，所以 import 保留）；`startCreate` 与 `.new-card` 按钮原样保留。
- [ ] **Step 2: 死代码检查**：grep `tb-select|tb-progress|tb-enrich`，确认源码与 CSS 中无残留引用。
- [ ] **Step 3: 全量验证**

Run: `npm run typecheck && npm test && npm run build`
Expected: 类型零错误；全部 Vitest 通过（含新 batchPicker 用例，总数相应增加）；build 成功产出 `out/`。
- [ ] **Step 4: 真机目检清单**（`npm run dev`，逐项核对并记录结果）
  - 工具栏三组图标与分隔线对齐 52px 栏高；每个按钮 hover tooltip 中文正确；删除按钮 hover 变红。
  - BatchPicker：点击开关、外部点击/Esc/选中后关闭；↑↓ 循环 + Enter 确认 + 焦点回触发器；零批次与 loading 时禁用不弹面板；超长名称 ellipsis；窗口缩窄后菜单不溢出右边缘。
  - 导入中按钮变 ✕、tooltip「取消导入」、点击可取消；导出禁用态 wrap tooltip 仍出现。
  - 左栏底部：enrich 行显隐、进度百分比与条宽随分类动作变化；切到文件夹/回收站视图仍常驻；首刷瞬间（counts null）不崩。
  - 右栏 header 无 ＋，底部虚线卡片新建/输入态正常；空状态页（无批次）的文字版「新建批次」按钮不变。
  - 制造 15+ 批次：菜单出现内部滚动条且底部选项可达；滚动菜单本身不关闭 popover，滚动菜单外部（缩略图网格）才关闭。
  - 菜单展开时确认浮层盖在左栏缩略图之上（toolbar z-index 修复项），且导出/恢复弹窗仍盖在菜单之上。
