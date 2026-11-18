import { useState } from 'react'
import { useAppStore } from '../state/store'
import InlineNameInput from './InlineNameInput'
import { PlusIcon } from './icons'

function showError(e: unknown): void {
  window.alert(e instanceof Error ? e.message : String(e))
}

interface CreateBatchButtonProps {
  // Toolbar renders the bare icon form; the empty state keeps the labeled CTA.
  icon?: boolean
}

// One control for both the toolbar and the empty state: click swaps the button
// for an inline input. A blank entry falls through to the backend date name;
// Esc cancels before anything is created.
export default function CreateBatchButton({ icon = false }: CreateBatchButtonProps = {}) {
  const { state, createBatch } = useAppStore()
  const [naming, setNaming] = useState(false)

  if (naming) {
    return (
      <span className="batch-name-input">
        <InlineNameInput
          allowBlank
          placeholder="留空则以日期命名"
          onCommit={(name) => {
            setNaming(false)
            void createBatch(name === '' ? undefined : name).catch(showError)
          }}
          onCancel={() => setNaming(false)}
        />
      </span>
    )
  }

  if (icon) {
    return (
      <button
        type="button"
        className="icon-btn"
        title="新建批次"
        aria-label="新建批次"
        disabled={state.loading}
        onClick={() => setNaming(true)}
      >
        <PlusIcon />
      </button>
    )
  }

  return (
    <button
      type="button"
      className="tb-btn"
      disabled={state.loading}
      onClick={() => setNaming(true)}
    >
      <PlusIcon />
      新建批次
    </button>
  )
}
