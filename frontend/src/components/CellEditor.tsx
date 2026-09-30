import { useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../store'

interface Props {
  /** What the editor opens with: the staged value, else the loaded one. */
  text: string
  left: number
  width: number
  /** The row height — the editor starts this tall and grows with its text. */
  height: number
}

const MAX_ROWS = 8

/**
 * The inline editor for one cell, laid over it.
 *
 * Enter stages the text, Shift+Enter is a newline, Esc throws the edit away.
 * Leaving the field stages as well, as a spreadsheet does — staging is not
 * saving, and Ctrl+Z takes it back.
 *
 * Opening it and closing it without typing changes nothing. That is what keeps
 * F2 then Enter on a NULL cell from quietly turning it into an empty string:
 * the field starts empty for both, so only having typed can tell them apart.
 */
export function CellEditor({ text, left, width, height }: Props) {
  const [value, setValue] = useState(text)
  const typed = useRef(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // Grown to fit, capped: a long document belongs in the cell viewer.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, height), height * MAX_ROWS)}px`
  }, [value, height])

  const finish = () => {
    const s = useStore.getState()
    if (typed.current) s.commitEdit(value)
    else s.cancelEdit()
  }

  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      spellCheck={false}
      aria-label="Edit cell"
      onChange={(e) => {
        typed.current = true
        setValue(e.target.value)
      }}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          useStore.getState().cancelEdit()
        } else if (
          (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) ||
          e.key === 'Tab'
        ) {
          e.preventDefault()
          finish()
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          // Staged first; the window's Ctrl+S then reviews what includes it.
          finish()
        }
      }}
      // The grid's row menu would otherwise replace the field's own copy/paste.
      onContextMenu={(e) => e.stopPropagation()}
      className="absolute top-0 z-[5] resize-none rounded-sm bg-[var(--color-elevated)] px-2 text-[var(--color-text)] ring-2 ring-[var(--color-accent)] outline-none"
      style={{
        left,
        width: Math.max(width, 224),
        minHeight: height,
        font: 'inherit',
        lineHeight: 1.4,
        // Centres one line in the row's height; more lines just grow the box.
        paddingBlock: `calc((${height}px - 1.4em) / 2)`,
        overflowWrap: 'anywhere',
      }}
    />
  )
}
