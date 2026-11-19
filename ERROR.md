# 故障记录：ARW 预览左右切换后永久转圈（图片不显示）

日期：2026-11-19　状态：已修复并真机确认

## 现象

- 在预览大图界面，打开一张 ARW（其他格式同理）能正常显示；按左方向键切到上一张、再按右方向键切回来后，该照片**一直停在 loading 转圈，图片不出现**。
- 故障照片的 DOM：`<img src="selight://photo/1119" style="visibility: hidden;">`，同时 `.preview-loading` 转圈元素存在，**没有"重试"按钮**。
- 首次打开不卡，只有"切走再切回看过的照片"才触发，复现稳定。

## 根因

渲染层 `StageImage`（`src/components/PreviewPane.tsx`）是**持久挂载**组件：左右切照片时组件不销毁，只是 `photo` prop 变化。它用一个 `useEffect` 在 src 变化时手动把加载状态重置回 false：

```jsx
const [loaded, setLoaded] = useState(false)
useEffect(() => { setLoaded(false); setLoadFailed(false) }, [src])
// visibility 只有 ready 才可见
style={{ visibility: state === 'ready' ? 'visible' : 'hidden' }}
```

切回**已经看过的同一张照片**时，URL 与之前相同，浏览器对该 URL 极速命中缓存、同步完成解码，于是 `<img>` 的 `onLoad` 在 React 的 passive effect **之前**触发：

```
img onLoad  → setLoaded(true)    图片其实已经加载好
src changed → setLoaded(false)   重置 effect 反手把 true 覆盖回 false
state       → loading            图片不会再触发第二次 onLoad，永久卡死
```

`loaded` 被覆盖成 false 后再也回不到 true：图片已加载完，不会有第二次 `onLoad`；也没有出错，不会有 `onError`。于是 `derivePreviewState` 永远返回 `loading`，img 保持 `visibility: hidden` + 转圈，且因为不是 `failed` 态而不显示重试按钮。

首次打开不卡，是因为 URL 全新、要走真实的网络/文件往返，`onLoad` 必然在 effect 之后才来。缩略图网格不卡，是因为 `ThumbCell` 没有这套 loaded 门控，img 始终可见。

## 修复

给 `StageImage` 加 `key={photo.id}`，让每张照片成为独立的组件实例，`loaded`/`loadFailed` 随挂载天然初始化为 false，并**删除手动重置 effect**（竞态根源）：

```jsx
<StageImage key={photo.id} photo={photo} />
```

组件按 photo.id 重挂载后，state 初始化与 img 加载同属一次挂载，不存在"effect 覆盖先到的 onLoad"的时序窗口。净改动仅 `PreviewPane.tsx` 一个文件。

## 次生回归：删掉重置 effect 后，首次 404 的失败态无法自愈（同日修复）

上面的 key 重挂载修复把 `useEffect(() => { setLoaded(false); setLoadFailed(false) }, [src])` **整个删除**，结果引入新问题：任何照片**首次**预览时缓存尚未生成，协议先回一次 404，img 立刻 `onError` 进入 failed（"预览生成失败"+重试按钮）；主进程随后在后台生成好并通过 `useMediaUrl` 的 nonce 把 src 变成 `?v=1`、img 重新请求到 200，但同一张照片内 `key={photo.id}` 不变、组件不重挂载，`loadFailed` 没有任何地方复位，于是永久卡在失败态。JPG 直读格式生成快，404 与 200 间隔很短，表现为"默认就闪一下预览生成失败"。

最终修法是把两种重置需求明确分开，而不是二选一：

- **跨照片切换**：靠父组件 `key={photo.id}` 重挂载，state 天然初始化，不经过 effect（保留原 loading 竞态修复）。
- **同一照片实例内的 nonce 重载**：恢复 `[src]` effect 来清 `loadFailed`/`loaded`，但用 `useRef` 标记跳过挂载后的首次执行——首次交给 state 初始化，避免缓存命中时 onLoad 抢跑被 effect 覆盖；只在后台生成完成、src 真正变成 `?v=` 时才复位。

教训：修状态时序 bug 时要分清"**跨组件实例**"与"**同一实例内 prop/url 变化**"两类重置。key 重挂载解决前者，但实例内的异步自愈（404→生成→重载）仍需要一次受控的 effect；用"跳过首次"的 ref 守卫让两者共存，而不是把 effect 一刀切删除。

## 排查过程与关键判据

走了三段弯路，前两个修复各自解决了真实但不同的问题，都不是本次主症状的根因：

1. **协议否定缓存（no-store）**：给 `selight://` 全部响应加 `Cache-Control: no-store`，防止 404 被 Chromium 否定缓存后、后台生成完成仍命中旧 404。真实问题，保留。
2. **ARW 跨队列提取竞态（in-flight 去重）**：缩略图 backfill 与预览队列共享 `ExiftoolReader`，并发写同一个 `previews/<id>.jpg.tmp`，败方 ENOENT 被降级成永久占位图。用 25 轮并发回归测试稳定复现并修复。真实问题，保留。
3. **本次真正根因（effect 重置竞态）**：靠运行时日志定位——主进程协议日志显示故障照片的请求**返回 200、3ms 完成**，排除网络/生成层；渲染层 `[diag:stage]` 日志直接打出 `img onLoad` 早于 `src changed` 的时序，实锤 state 被覆盖。

### 可复用的定位信号

- img 是 `visibility: hidden` + 转圈、且**没有重试按钮** ⇒ `derivePreviewState` 处于 `loading` ⇒ `onLoad` 和 `onError` 都没把状态推走。这一条直接把方向锁定在"img 加载事件 vs React state"，而不是文件或协议。
- 主进程协议层对该 URL 返回 200 且耗时正常 ⇒ 问题在渲染层，不要继续在主进程/stream 上找。
- 排查手段：主进程 `protocol.handle` 内打印每个请求的状态与耗时；渲染层在 img 的 `onLoad`/`onError`、state 派生处、url 解析处分别打点，对照时间线即可定位事件先后。

## 经验教训

- **不要用 `useEffect` 去"重置"本可由组件身份天然管理的 state。** passive effect 在 paint 之后执行，而缓存命中的事件回调可能比它更早，effect 里 `setState(false)` 会覆盖先到的正确值。需要随 prop 重置 state 时，优先用 `key` 重挂载，或在 render 期派生（存"上一次的 id"对比），而不是 effect 同步。
- 改协议响应包装方式（stream → ArrayBuffer 之类）前先确认 stream 真是元凶；本次一度怀疑 `new Response(stream)` 的流锁定，加了缓冲改动，后被日志证明无效并回退。**先拿事件时序证据，再动传输层。**
- 项目测试是 bare Node、无 jsdom（见 CLAUDE.md 约定），这类 React 组件挂载时序问题无法自动化，靠真机 + 打点日志确认；纯函数 `derivePreviewState` 本身仍保留单测。
