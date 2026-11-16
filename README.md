# 📸 择影 Selight

### 本地优先的照片筛选与分类桌面工具，为大批量过片而生

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%E8%A7%84%E5%88%92%E4%B8%AD-007AFF)
![electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![react](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)
![typescript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![tests](https://img.shields.io/badge/tests-314%20passed-2ECC71)
![status](https://img.shields.io/badge/status-MVP%20v0.1.0-FF9500)

一场婚礼拍摄留下上千张照片，精修之前总得先过一遍、分好类。**择影** 让你用键盘快速完成这件事：拖拽或按数字键分类、Delete 扔进回收站、Ctrl+Z 随时反悔，分完一键导出——**原文件自始至终只读，永不移动、修改或删除**。

<!-- 界面截图位：建议放一张三栏主界面截图替换此注释 -->

## ✨ 核心特性

- **⚡ 键盘优先，快**：数字键 1–9 一键分配、方向键翻片、Delete 丢弃，支持 Ctrl/Shift 多选与 Ctrl+A 全选，批量操作整批一步撤销
- **🔒 原文件零改动，安全**：分类只是 SQLite 里的映射关系；回收站不是真删除，删文件夹照片也只会回到待分类池，任何操作都可撤销（重启后依然可以）
- **💾 关掉重开接着干，可续**：批次、待分类池、文件夹、回收站、导入来源、当前视图全部持久化，下次打开恢复完整现场
- **🗂️ 批次隔离多场次**：一次拍摄一个批次，互不干扰，历史批次随时切回看
- **📷 RAW 与 EXIF 方向**：直读 JPG/JPEG/PNG/WEBP；ARW/CR2/CR3/NEF/DNG/RAF/RW2/ORF/PEF/SRW 提取内嵌预览，EXIF Orientation 自动烘焙转正，竖拍不会横置
- **🪶 两千张不卡**：react-window 虚拟化网格只渲染可见区域，扫描与缩略图在后台队列按可见优先级生成
- **📤 非破坏式导出**：按文件夹把**原文件复制**到输出目录（RAW 复制原 RAW），回收站不导出，文件名冲突自动加 `(1)` 后缀，绝不覆盖

## ⌨️ 快捷键

| 按键 | 动作 |
| --- | --- |
| `←` `→`（或 `↑` `↓`） | 切换选中照片 |
| `1` – `9` | 分配给第 N 个文件夹 |
| `Delete` / `Backspace` | 扔进回收站 |
| `Ctrl+Z` | 撤销最近一次动作（批量分配整批一步撤） |
| `Esc` | 从文件夹/回收站视图返回待分类 |
| `Ctrl/Shift` + 点击 | 多选；`Ctrl+A` 全选当前视图 |

鼠标拖拽同样可用：照片拖到文件夹卡片即分类，拖到回收站卡片即丢弃。

## 🧭 工作流

1. 新建批次（默认以日期命名），点「导入文件夹」选择源目录，支持多次导入与递归子目录
2. 左栏待分类网格 + 中间大图预览，看图后按数字键或拖拽分类，分完即从待分类池消失
3. 不要的照片进回收站；点文件夹卡片可进入做二次筛选（挪走或丢弃）
4. 全部过完后点「导出」，按文件夹复制原件到输出目录，拿去精修
5. 中途退出无所谓——下次打开，现场原封不动

## 🚀 快速开始

```bash
# 安装依赖（建议 Node.js 20 LTS 或以上）
npm install

# 开发模式启动
npm run dev

# 类型检查 + 单元测试
npm run typecheck
npm test

# 打包 Windows 安装包（输出到 dist/）
npm run pack:win
```

## 🏗️ 技术栈

| 层 | 选型 |
| --- | --- |
| 壳 | Electron 44 + electron-vite |
| 渲染层 | React 19 + TypeScript（strict） |
| 数据 | better-sqlite3，同步事务，库文件位于应用 `userData/selight.db` |
| EXIF / RAW | exiftool-vendored（自带二进制，离线可用） |
| 缩略图 | Electron nativeImage + 隐藏 Blink helper 解码 WebP，jpeg-autorotate 烘焙方向 |
| 虚拟化 | react-window |
| 测试 | Vitest（领域逻辑 / IPC 契约 / 媒体管线 / 真实 ARW 冒烟 harness） |

## 📁 目录结构

```
selight/
├── electron/            主进程
│   ├── db/              SQLite schema 与迁移
│   ├── domain/          批次、分类、文件夹、撤销等纯领域逻辑
│   ├── media/           扫描管线、RAW 预览、缩略图队列、自定义 protocol
│   ├── exporter.ts      按文件夹复制导出
│   └── ipc.ts           渲染进程 IPC 边界
├── src/                 渲染进程（React）
│   ├── components/      Toolbar / ThumbPane / PreviewPane / FolderCards …
│   ├── state/           reducer、选择模型、快捷键、拖拽
│   └── styles/          设计 token 与全局样式（macOS 视觉语言，浅色）
├── tests/               单测 + Electron 真实冒烟 harness
├── samples/             真实 ARW/JPG 样本（gitignored，不打包）
└── docs/superpowers/    设计文档与 backlog
```

## 🛣️ 路线图

当前为 MVP（v0.1.0），已在真实素材上验证全流程（1871 张婚礼素材、真实 ARW 竖拍转正端到端实证）。接下来的重点：

- macOS 适配（dmg 打包、签名公证、红绿灯布局，已评估为适配而非移植）
- 单实例锁、键盘导航滚动跟随、文件夹名校验等发行前加固
- 应用图标、代码签名与发布 checklist

完整清单见 [`docs/superpowers/specs/2026-11-16-post-mvp-backlog.md`](docs/superpowers/specs/2026-11-16-post-mvp-backlog.md)，设计决策记录见 [`docs/superpowers/specs/2026-11-13-zeying-design.md`](docs/superpowers/specs/2026-11-13-zeying-design.md)。

## 🔐 隐私

择影是纯本地应用，没有任何网络请求、账号或云同步。所有数据只存在你自己的机器上：分类关系在 `userData/selight.db`，缩略图与 RAW 预览缓存在 `userData/` 下，原文件永远不会被写入。
