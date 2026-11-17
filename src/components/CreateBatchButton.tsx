import { useState } from 'react'
import { useAppStore } from '../state/store'
import InlineNameInput from './InlineNameInput'
import { PlusIcon } from './icons'

function showError(e: unknown): void {
  window.alert(e instanceof Error ? e.message : String(e))
}

// One control for both the toolbar and the empty state: click swaps the button
// for an inline input. A blank entry falls through to the backend date name;
// Esc cancels before anything is created.
export default function CreateBatchButton() {
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
