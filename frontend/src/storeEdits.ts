/**
 * The store's half of row editing: what is staged, what is being typed, and the
 * review that precedes a write.
 *
 * Split from store.ts only because that file is already the largest in the app.
 * It is not a second store — `createEditSlice` is handed the real `set` and
 * `get`, and its actions sit beside the others on `useStore`.
 *
 * The one rule this file exists to keep: SQL that changes rows runs from exactly
 * one place, `applyStaged`, and `applyStaged` is reachable only from the review
 * dialog's Run button. Preview, Accept and Ctrl+S all end at `reviewChanges`,
 * which runs nothing. `invariants.test.ts` fails if a second caller appears.
 */

import { api, errorMessage } from './api'
import { absoluteRowOffset, isCellTruncated } from './cells'
import {
  EMPTY_STAGED,
  addInsert,
  blockReason,
  cellInputText,
  commit,
  countOf,
  keyIndexes,
  keyedRow,
  removeInsert,
  setCell,
  setInsertCell,
  toChangesRequest,
  toggleDelete,
  undo,
  type Keyed,
  type Staged,
} from './edits'
import { rectOf } from './selection'
import type { State } from './store'
import type { Cell, CellInput, ChangesRequest, Statement } from './types'

/** The cell being typed into. Not staged until Enter. */
export interface Editing {
  row: number
  col: number
  text: string
  /** The whole value of a cell the grid only holds a capped copy of. */
  full?: string
}

export interface ReviewState {
  /** Exactly what was previewed, and exactly what Run will send. */
  request: ChangesRequest
  status: 'loading' | 'ready' | 'applying' | 'failed'
  statements: Statement[]
  error?: string
  /** Into `statements`, which are one per change in order. */
  failedIndex?: number
}

export interface EditState {
  /** Columns that address a row; empty means the table on screen is read-only. */
  editKey: string[]
  readOnlyReason: string
  staged: Staged
  editing: Editing | null
  review: ReviewState | null
}

export interface EditActions {
  /** F2: edit the focused cell. Fetches the whole value first if it was capped. */
  startEdit: () => Promise<void>
  commitEdit: (text: string) => void
  cancelEdit: () => void
  /** Ctrl+Backspace: stage NULL over the selected cells. */
  setSelectionNull: () => void
  setSelectionDefault: () => void
  insertRow: () => void
  deleteRows: () => void
  undoEdit: () => void
  /** Drops every staged edit, asking first when there are many. */
  discardChanges: () => void
  /**
   * Accept, Preview and Ctrl+S: builds the SQL and shows it. Runs nothing that
   * changes data.
   */
  reviewChanges: () => Promise<void>
  cancelReview: () => void
  /** Sends the reviewed change set. Only the review dialog may call this. */
  applyStaged: () => Promise<void>
}

export const INITIAL_EDIT_STATE: EditState = {
  editKey: [],
  readOnlyReason: '',
  staged: EMPTY_STAGED,
  editing: null,
  review: null,
}

/** Above this many staged changes, Discard asks. Fewer are a Ctrl+Z away anyway. */
const DISCARD_CONFIRM_AT = 5

const CLEARED = { staged: EMPTY_STAGED, editing: null, review: null } as const

interface Io {
  tracked: <T>(fn: () => Promise<T>) => Promise<T>
  fetchRows: () => Promise<void>
}

export function createEditSlice(set: (p: Partial<State>) => void, get: () => State, io: Io) {
  const toast = (kind: 'error' | 'info', msg: string) => get().pushToast(kind, msg)

  /** Rows on screen: the page, then the rows staged for insert. */
  const rowCount = (s: State) => (s.result?.rows.length ?? 0) + s.staged.edits.inserts.length

  /** The browse grid's selection, when there is a table to edit behind it. */
  function browseSelection(s: State) {
    const sel = s.selection
    if (!sel || sel.source !== 'browse' || !s.result || !s.activeRef || !s.activeConnectionId) {
      return null
    }
    return sel
  }

  function columnAt(s: State, col: number) {
    const name = s.result?.columns[col]?.name
    return s.columns.find((c) => c.name === name)
  }

  /** The row's identity, for a row that came from the database. */
  function keyedAt(s: State, row: number): Keyed | null {
    const rs = s.result
    if (!rs || row >= rs.rows.length) return null
    const idx = keyIndexes(rs.columns, s.editKey)
    return idx ? keyedRow(rs.rows[row], s.editKey, idx) : null
  }

  /** What the cell says now: the staged value if there is one, else the loaded one. */
  function currentInput(s: State, row: number, col: number): { input?: CellInput; original: Cell } {
    const rs = s.result!
    const name = rs.columns[col].name
    if (row >= rs.rows.length) {
      return { input: s.staged.edits.inserts[row - rs.rows.length]?.set[name], original: null }
    }
    const k = keyedAt(s, row)
    return {
      input: k ? s.staged.edits.updates[k.key]?.set[name] : undefined,
      original: rs.rows[row][col],
    }
  }

  /** Puts `input` on one cell of the current page or of an insert row. */
  function stageOne(
    s: State,
    e: Staged['edits'],
    row: number,
    col: number,
    input: CellInput,
    original: Cell,
  ) {
    const rs = s.result!
    const name = rs.columns[col].name
    if (row >= rs.rows.length) {
      const ins = e.inserts[row - rs.rows.length]
      return ins ? setInsertCell(e, ins.id, name, input) : e
    }
    const k = keyedAt(s, row)
    return k ? setCell(e, k, name, input, original) : e
  }

  /** After rows vanish (undo, discard, delete of an insert) the selection may point past the end. */
  function clampedSelection(s: State, count: number): Partial<State> {
    const sel = s.selection
    if (!sel || sel.source !== 'browse') return {}
    if (count === 0) return { selection: null }
    const last = count - 1
    const fit = (p: { row: number; col: number }) => ({ ...p, row: Math.min(p.row, last) })
    return { selection: { ...sel, anchor: fit(sel.anchor), focus: fit(sel.focus) } }
  }

  function clearStaged() {
    const s = get()
    set({ ...CLEARED, ...clampedSelection(s, s.result?.rows.length ?? 0) })
  }

  /**
   * True when the caller must stop because edits are staged: the user is asked
   * whether to lose them, and if they agree the staged edits are cleared and
   * `retry` is run — the same action again, which now finds nothing staged.
   *
   * Every action that replaces the rows on screen starts with this, so a page
   * turn or a re-sort can never quietly throw away work.
   */
  function holdForDiscard(retry: () => Promise<void>): boolean {
    const count = countOf(get().staged.edits).total
    if (count === 0) return false
    set({
      dialog: {
        kind: 'confirmDiscard',
        count,
        proceed: () => {
          set(CLEARED)
          return retry()
        },
      },
    })
    return true
  }

  /** Reason the table on screen cannot be edited at all, or ''. */
  const tableBlock = (s: State) => blockReason(s, { editable: true })

  function stageKind(kind: 'null' | 'default') {
    const s = get()
    const sel = browseSelection(s)
    if (!sel || s.view !== 'data') return
    const why = tableBlock(s)
    if (why) return toast('info', `Cannot edit: ${why}`)

    const r = rectOf(sel)
    const cells: { row: number; col: number }[] = []
    let skipped = ''
    for (let row = r.top; row <= Math.min(r.bottom, rowCount(s) - 1); row++) {
      const k = keyedAt(s, row)
      if (k && s.staged.edits.deletes[k.key]) continue
      for (let col = r.left; col <= r.right; col++) {
        const column = columnAt(s, col)
        const block = blockReason(s, column)
        if (block) skipped ||= `${column?.name ?? 'column'} is read-only: ${block}`
        else if (kind === 'null' && column?.nullable === false)
          skipped ||= `${column.name} is NOT NULL`
        else cells.push({ row, col })
      }
    }
    if (cells.length === 0)
      return skipped ? toast('info', `Nothing to set — ${skipped}`) : undefined
    const input: CellInput = { kind }
    set({
      staged: commit(s.staged, (e) =>
        cells.reduce((acc, c) => {
          const { original } = currentInput(s, c.row, c.col)
          return stageOne(s, acc, c.row, c.col, input, original)
        }, e),
      ),
    })
    if (skipped) toast('info', `Some cells were left alone — ${skipped}`)
  }

  const actions: EditActions = {
    async startEdit() {
      const s = get()
      const sel = browseSelection(s)
      if (!sel || s.view !== 'data') return
      const rs = s.result!
      const { row, col } = sel.focus
      const column = columnAt(s, col)
      const why = blockReason(s, column)
      if (why)
        return toast('info', `${rs.columns[col]?.name ?? 'This cell'} cannot be edited: ${why}`)

      const isInsert = row >= rs.rows.length
      if (!isInsert) {
        const k = keyedAt(s, row)
        if (!k) return toast('info', 'This row cannot be addressed by its key')
        if (s.staged.edits.deletes[k.key]) {
          return toast('info', 'This row is staged for deletion — undo that to edit it')
        }
      }

      const { input } = currentInput(s, row, col)
      // A cell that already holds a staged value, or one in a new row, has
      // nothing to fetch: what is being edited is what is staged.
      if (input || isInsert) {
        set({ editing: { row, col, text: input?.kind === 'value' ? (input.value ?? '') : '' } })
        return
      }

      // A capped value must never be edited as shown: saving it would overwrite
      // the real one with its first 1024 characters. The cell stays put until the
      // whole value has arrived.
      if (isCellTruncated(rs, row, col)) {
        let full: string
        try {
          const res = await io.tracked(() =>
            api.readCell({
              connectionId: s.activeConnectionId!,
              ref: s.activeRef!,
              column: rs.columns[col].name,
              filter: s.filter,
              orderBy: s.orderBy,
              applyDefaultSort: !s.sortChosen,
              rowOffset: absoluteRowOffset(row, {
                enabled: s.paginationEnabled,
                page: s.page,
                pageSize: s.pageSize,
              }),
            }),
          )
          if (res.truncated) {
            return toast('error', `${rs.columns[col].name} is too large to edit here`)
          }
          full = res.value ?? ''
        } catch (e) {
          return toast('error', errorMessage(e))
        }
        // Whatever was on screen may have been replaced while this was in flight.
        if (get().result !== rs) return
        set({ editing: { row, col, text: full, full } })
        return
      }

      set({ editing: { row, col, text: cellInputText(rs.rows[row][col]) } })
    },

    commitEdit(text) {
      const s = get()
      const ed = s.editing
      if (!ed || !s.result) return
      const { original } = currentInput(s, ed.row, ed.col)
      const input: CellInput = { kind: 'value', value: text }
      set({
        editing: null,
        staged: commit(s.staged, (e) =>
          stageOne(s, e, ed.row, ed.col, input, ed.full !== undefined ? ed.full : original),
        ),
      })
    },

    cancelEdit() {
      if (get().editing) set({ editing: null })
    },

    setSelectionNull: () => stageKind('null'),
    setSelectionDefault: () => stageKind('default'),

    insertRow() {
      const s = get()
      if (!s.result || !s.activeRef || s.view !== 'data') return
      const why = tableBlock(s)
      if (why) return toast('info', `Cannot insert: ${why}`)
      const row = rowCount(s)
      const col = Math.max(
        0,
        s.result.columns.findIndex((rc) => s.columns.find((c) => c.name === rc.name)?.editable),
      )
      const pos = { row, col }
      set({
        staged: commit(s.staged, addInsert),
        selection: { source: 'browse', anchor: pos, focus: pos },
      })
    },

    deleteRows() {
      const s = get()
      const sel = browseSelection(s)
      if (!sel || s.view !== 'data') return
      const why = tableBlock(s)
      if (why) return toast('info', `Cannot delete: ${why}`)
      const base = s.result!.rows.length
      const r = rectOf(sel)
      const existing: Keyed[] = []
      const inserts: number[] = []
      for (let row = r.top; row <= Math.min(r.bottom, rowCount(s) - 1); row++) {
        if (row < base) {
          const k = keyedAt(s, row)
          if (k) existing.push(k)
        } else {
          inserts.push(s.staged.edits.inserts[row - base].id)
        }
      }
      const staged = commit(s.staged, (e) =>
        inserts.reduce(removeInsert, toggleDelete(e, existing)),
      )
      set({ staged, ...clampedSelection({ ...s, staged }, base + staged.edits.inserts.length) })
    },

    undoEdit() {
      const s = get()
      if (s.staged.past.length === 0) return
      const staged = undo(s.staged)
      set({
        staged,
        editing: null,
        ...clampedSelection(s, (s.result?.rows.length ?? 0) + staged.edits.inserts.length),
      })
    },

    discardChanges() {
      const count = countOf(get().staged.edits).total
      if (count === 0) return
      if (count < DISCARD_CONFIRM_AT) return clearStaged()
      set({ dialog: { kind: 'confirmDiscard', count, proceed: async () => clearStaged() } })
    },

    async reviewChanges() {
      const s = get()
      if (!s.activeConnectionId || !s.activeRef) return
      if (countOf(s.staged.edits).total === 0) return toast('info', 'No staged changes to accept')
      const request = toChangesRequest(s.staged.edits, s.activeConnectionId, s.activeRef)
      set({
        review: { request, status: 'loading', statements: [] },
        dialog: { kind: 'reviewChanges' },
      })
      try {
        const preview = await io.tracked(() => api.previewChanges(request))
        if (get().review?.request !== request) return
        set({ review: { request, status: 'ready', statements: preview.statements } })
      } catch (e) {
        if (get().review?.request !== request) return
        set({ review: { request, status: 'failed', statements: [], error: errorMessage(e) } })
      }
    },

    cancelReview() {
      if (get().review?.status === 'applying') return
      set({ review: null, dialog: { kind: 'none' } })
    },

    async applyStaged() {
      const review = get().review
      if (!review || review.status !== 'ready') return
      set({ review: { ...review, status: 'applying' } })
      try {
        const res = await io.tracked(() => api.applyChanges(review.request))
        if (res.conflict) {
          set({
            review: {
              ...review,
              status: 'failed',
              error: res.conflict.message,
              failedIndex: res.conflict.index,
            },
          })
          return
        }
      } catch (e) {
        set({ review: { ...review, status: 'failed', error: errorMessage(e) } })
        return
      }
      const n = review.request.changes.length
      set({ ...CLEARED, dialog: { kind: 'none' } })
      toast('info', `Applied ${n} change${n === 1 ? '' : 's'}`)
      await io.fetchRows()
    },
  }

  return { actions, holdForDiscard }
}

let unloadGuarded = false

/** Asks the browser to confirm before a reload or close drops staged edits. */
export function guardUnload(get: () => State) {
  if (unloadGuarded || typeof window === 'undefined') return
  unloadGuarded = true
  window.addEventListener('beforeunload', (e) => {
    if (countOf(get().staged.edits).total === 0) return
    e.preventDefault()
    e.returnValue = ''
  })
}
