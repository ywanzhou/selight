import { useEffect, useRef, type KeyboardEvent } from 'react'

// Plain <input> on purpose: isInputTarget recognizes INPUT so the global
// shortcut hook stands down while a folder name is being edited.
const MAX_NAME_LENGTH = 64

interface InlineNameInputProps {
  initialValue?: string
  placeholder?: string
  onCommit(name: string): void
  onCancel(): void
}

export default function InlineNameInput({
  initialValue = '',
  placeholder,
  onCommit,
  onCancel
}: InlineNameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  // Blur fires after Enter/Esc unmounts the input; the settled guard makes
  // sure a commit and its follow-up blur never invoke both callbacks.
  const settledRef = useRef(false)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  function commit(): void {
    if (settledRef.current) return
    const name = (inputRef.current?.value ?? '').trim()
    settledRef.current = true
    // A blank name is a cancel, never an IPC call with an empty string.
    if (name === '') onCancel()
    else onCommit(name)
  }

  function cancel(): void {
    if (settledRef.current) return
    settledRef.current = true
    onCancel()
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  return (
    <input
      ref={inputRef}
      className="inline-name-input"
      defaultValue={initialValue}
      placeholder={placeholder}
      maxLength={MAX_NAME_LENGTH}
      onKeyDown={handleKeyDown}
      onBlur={commit}
    />
  )
}
