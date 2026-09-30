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
