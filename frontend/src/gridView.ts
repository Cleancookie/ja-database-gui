import { keyIndexes, keyedRow, stagedText, type EditSet } from './edits'
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

export interface GridView {
  /** Rows to draw: the page, then the rows staged for insert. */
  rowCount: number
  isNewRow: (row: number) => boolean
  cell: (row: number, col: number) => CellView
  rowMark: (row: number) => RowMark
}

/**
 * The result with the staged edits laid over it: a cell's effective value and
 * whether it is changed, struck out or new. Pure, so the grid draws it and
 * copy reads it — copying an edited cell copies what the grid shows.
 */
export function gridView(
  result: ResultSet,
  edits: EditSet,
  editKey: string[],
  browse: boolean,
): GridView {
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
      value: input.kind === 'null' ? null : stagedText(input, value),
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
    cell,
  }
}
