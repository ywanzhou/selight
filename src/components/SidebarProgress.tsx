import { useAppStore } from '../state/store'

// Bottom-pinned batch progress inside the left thumbnail sidebar. Self-contained
// store consumer like TrashCard: it renders in every ThumbPane view (inbox,
// folder, trash) because the numbers describe the whole batch, not the view.
export default function SidebarProgress() {
  const { state } = useAppStore()
  const { counts, enrichProgress } = state

  // counts is null until the first batch refresh lands; render zeros rather than crashing.
  const total = counts?.total ?? 0
  const classified = total - (counts?.inbox ?? 0)
  const percent = total > 0 ? (classified / total) * 100 : 0

  return (
    <div className="side-progress">
      {enrichProgress !== null && (
        <div className="sp-enrich" role="status">
          正在处理 {enrichProgress.done}/{enrichProgress.total}
        </div>
      )}
      <div className="sp-count">
        <span>
          已分 {classified} / 共 {total}
        </span>
        <span>{Math.round(percent)}%</span>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={classified}
      >
        <i style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
