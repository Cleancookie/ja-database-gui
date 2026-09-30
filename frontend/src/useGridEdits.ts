import { useMemo } from 'react'
import { EMPTY_EDITS, keyIndexes, keyedRow } from './edits'
import { useStore, type ResultSource } from './store'
import { activeEdits, type Editing } from './storeEdits'
import type { Cell, ResultSet } from './types'

/** How the grid should draw one cell. */
export type CellState = 'clean' | 'dirty' | 'deleted' | 'new'

export interface CellView {
  value: Cell
  /** Shown as DEFAULT: staged as such, or a cell of a new row nobody filled in. */
  isDefault: boolean
  state: CellState
  /** The loaded value, for a dirty cell's tooltip. */
  was?: Cell
}

/** What a row carries, for the dot in its gutter. */
export type RowMark = 'update' | 'delete' | 'insert' | null

export interface GridEdits {
  /** Rows to draw: the page, then the rows staged for insert. */
  rowCount: number
  isNewRow: (row: number) => boolean
  editing: Editing | null
  cell: (row: number, col: number) => CellView
  rowMark: (row: number) => RowMark
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

  return useMemo(() => {
    const base = result.rows.length
    const idx = browse ? keyIndexes(result.columns, editKey) : null
    const rowKeys: (string | undefined)[] = []
    const keyOf = (row: number) => (rowKeys[row] ??= keyedRow(result.rows[row], editKey, idx!).key)
    const touched = Object.keys(edits.updates).length > 0 || Object.keys(edits.deletes).length > 0

    const cell = (row: number, col: number): CellView => {
      if (row >= base) {
        const input = edits.inserts[row - base]?.set[result.columns[col].name]
        if (input?.kind === 'value')
          return { value: input.value ?? '', isDefault: false, state: 'new' }
        if (input?.kind === 'null') return { value: null, isDefault: false, state: 'new' }
        return { value: null, isDefault: true, state: 'new' }
      }
      const value = result.rows[row][col]
      if (!idx || !touched) return { value, isDefault: false, state: 'clean' }
      const key = keyOf(row)
      if (edits.deletes[key]) return { value, isDefault: false, state: 'deleted' }
      const input = edits.updates[key]?.set[result.columns[col].name]
      if (!input) return { value, isDefault: false, state: 'clean' }
      if (input.kind === 'default')
        return { value: null, isDefault: true, state: 'dirty', was: value }
      return {
        value: input.kind === 'null' ? null : (input.value ?? ''),
        isDefault: false,
        state: 'dirty',
        was: value,
      }
    }

    const rowMark = (row: number): RowMark => {
      if (row >= base) return 'insert'
      if (!idx || !touched) return null
      const key = keyOf(row)
      return edits.deletes[key] ? 'delete' : edits.updates[key] ? 'update' : null
    }

    return {
      rowMark,
      rowCount: base + edits.inserts.length,
      isNewRow: (row: number) => row >= base,
      editing,
      cell,
    }
  }, [browse, result, edits, editing, editKey])
}

/**
 * The colour a cell takes from its state. A focused or range-selected cell
 * keeps the selection's own wash — two backgrounds at equal specificity would
 * be decided by stylesheet order — and still shows its state in the edge bar
 * and the text.
 */
export function editCellClass(state: CellState, selected: boolean): string {
  switch (state) {
    case 'dirty':
      return `shadow-[inset_3px_0_0_var(--color-warn)] ${selected ? '' : 'bg-[var(--color-warn-dim)]'}`
    case 'new':
      return `shadow-[inset_3px_0_0_var(--color-success)] ${selected ? '' : 'bg-[var(--color-success)]/15'}`
    case 'deleted':
      return `text-[var(--color-danger)] line-through decoration-[var(--color-danger)] ${
        selected ? '' : 'bg-[var(--color-danger-dim)]'
      }`
    default:
      return ''
  }
}
