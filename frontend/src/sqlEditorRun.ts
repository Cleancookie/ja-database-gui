import type { MouseEvent } from 'react'
import { onScrollbar } from './paneClick'
import type { EditorHandle } from './ui'
import { useStore } from './store'

/**
 * The mounted SQL editor, so Run can ask it for its selection at the moment it
 * fires. Button, Ctrl+Enter and the palette all come through here; none of them
 * needs the selection in React state.
 */
export const sqlEditorHandle: { current: EditorHandle | null } = { current: null }

/** Runs the selection if there is one, else the whole buffer. */
export function runSqlFromEditor(): Promise<void> {
  return useStore.getState().runSql(sqlEditorHandle.current?.selectedSql() ?? undefined)
}

/**
 * The editor pane is taller than its text, and CodeMirror only owns the text.
 * A press on the empty remainder lands on the pane itself, so it focuses the
 * editor with the caret at the end. A press inside the editor, or on the pane's
 * scrollbar, is left alone so selection and scrolling keep working.
 */
export function focusEditorFromPane(e: MouseEvent<HTMLElement>): void {
  if (e.button !== 0 || (e.target as HTMLElement).closest('.cm-editor')) return
  const el = e.currentTarget
  if (onScrollbar(el, el.getBoundingClientRect(), e.clientX, e.clientY)) return
  e.preventDefault()
  sqlEditorHandle.current?.focusEnd()
}
