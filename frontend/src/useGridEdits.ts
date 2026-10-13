import { useMemo } from 'react'
import { EMPTY_EDITS } from './edits'
import { gridView, type CellState, type GridView } from './gridView'
import { useStore, type ResultSource } from './store'
import { activeEdits, type Editing } from './storeEdits'
import type { ResultSet } from './types'

export type { CellState, CellView, RowMark } from './gridView'

export interface GridEdits extends GridView {
  editing: Editing | null
}

/**
 * The staged edits as the grid draws them: a cell's effective value and whether
 * it is changed, struck out or new.
 *
 * The grid subscribes here, never the app shell — a keystroke that stages an
 * edit re-renders the grid and the pending bar and nothing else. The loaded
 * `result` is left exactly as the server sent it, so sizing, selection and
 * copy all keep working on it; edits are an overlay on top.
 */
export function useGridEdits(source: ResultSource, result: ResultSet): GridEdits {
  const browse = source === 'browse'
  const edits = useStore((s) => (browse ? activeEdits(s) : EMPTY_EDITS))
  const editing = useStore((s) => (browse ? s.editing : null))
  const editKey = useStore((s) => s.editKey)

  return useMemo(
    () => ({ ...gridView(result, edits, editKey, browse), editing }),
    [browse, result, edits, editing, editKey],
  )
}

/**
 * The colour a cell takes from its state. A focused or range-selected cell
 * keeps the selection's own wash — two backgrounds at equal specificity would
 * be decided by stylesheet order — and still shows its state in the text: bold
 * for an edit, struck through for a delete. A new row's gutter says `+`.
 */
export function editCellClass(state: CellState, selected: boolean): string {
  switch (state) {
    case 'dirty':
      return `font-bold ${selected ? '' : 'bg-[var(--color-warn-dim)]'}`
    case 'new':
      return selected ? '' : 'bg-[var(--color-success)]/15'
    case 'deleted':
      return `text-[var(--color-danger)] line-through decoration-[var(--color-danger)] ${
        selected ? '' : 'bg-[var(--color-danger-dim)]'
      }`
    default:
      return ''
  }
}
