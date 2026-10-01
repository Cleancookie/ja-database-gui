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
  EMPTY_EDITS,
  EMPTY_STAGED,
  addInsert,
  blockReason,
  cellInputText,
  commit,
  editsFor,
  keyIndexes,
  keyedRow,
  removeInsert,
  removeTable,
  scopeClash,
  setCell,
  setInsertCell,
  tableKey,
  toChangesRequest,
  toggleDelete,
  totalOf,
  undo,
  type Counts,
  type EditSet,
  rowKeyOf,
  type Keyed,
  type Staged,
  type TableKey,
} from './edits'
import { wantsLarge } from './bigEdit'
import { rectOf } from './selection'
import type { State } from './store'
import type { Cell, CellInput, ChangesRequest, Statement } from './types'

/** The cell being typed into. Not staged until Enter. */
export interface Editing {
  row: number
  col: number
  column: string
  /** `dbType` and the catalogue's type joined, for deciding how to edit and validate. */
  dataType: string
  /** The inline field, or the large modal editor. */
  mode: 'inline' | 'large'
  /** What the editor opens with: the staged value if there is one, else the loaded one. */
  text: string
  /** The loaded value as text, for "Revert to original"; empty for NULL and new rows. */
  original: string
  /** The large editor is waiting for the whole value of a capped cell. */
  loading?: boolean
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

/** What the status bar needs: a value that keeps its identity until a count moves. */
export type StagedSummary = Counts & { tables: number }

const NO_SUMMARY: StagedSummary = { updates: 0, inserts: 0, deletes: 0, total: 0, tables: 0 }
const NO_TABLES: ReadonlySet<TableKey> = new Set()

export interface EditState {
  /** Columns that address a row; empty means the table on screen is read-only. */
  editKey: string[]
  readOnlyReason: string
  staged: Staged
  /**
   * Derived from `staged` whenever it changes, and kept as the same object while
   * its values are the same. The status bar and the sidebar's table markers
   * subscribe to these rather than to `staged`, so typing in a cell re-renders
   * neither.
   */
  stagedSummary: StagedSummary
  dirtyTables: ReadonlySet<TableKey>
  editing: Editing | null
  review: ReviewState | null
}

export interface EditActions {
  /**
   * F2: edit the focused cell, inline or in the large editor by what it holds;
   * Shift+F2 (`large`) always uses the large one. A capped cell fetches its whole
   * value first.
   */
  startEdit: (large?: boolean) => Promise<void>
  commitEdit: (text: string) => void
  cancelEdit: () => void
  /** Ctrl+Backspace: stage NULL over the selected cells. */
  setSelectionNull: () => void
  setSelectionDefault: () => void
  insertRow: () => void
  deleteRows: () => void
  undoEdit: () => void
  /** Opens the next table with staged changes after the one on screen, wrapping round. */
  goToChangedTable: () => Promise<void>
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
  stagedSummary: NO_SUMMARY,
  dirtyTables: NO_TABLES,
  editing: null,
  review: null,
}

/** Above this many staged changes, Discard asks. Fewer are a Ctrl+Z away anyway. */
const DISCARD_CONFIRM_AT = 5

const CLEARED = {
  staged: EMPTY_STAGED,
  stagedSummary: NO_SUMMARY,
  dirtyTables: NO_TABLES,
  editing: null,
  review: null,
} as const

/** The table on screen, as a key into the staged set. */
export function activeTableKey(
  s: Pick<State, 'activeConnectionId' | 'activeRef'>,
): TableKey | null {
  return s.activeConnectionId && s.activeRef ? tableKey(s.activeConnectionId, s.activeRef) : null
}

/** What the table on screen has staged. */
export function activeEdits(s: State): EditSet {
  const key = activeTableKey(s)
  return key ? editsFor(s.staged, key) : EMPTY_EDITS
}

/**
 * The state that goes with a new `staged`: its derived summary and table set,
 * each reused when unchanged so a subscriber only wakes for a real difference.
 */
export function withStaged(
  prev: Pick<State, 'stagedSummary' | 'dirtyTables'>,
  staged: Staged,
): Pick<State, 'staged' | 'stagedSummary' | 'dirtyTables'> {
  const sum = totalOf(staged)
  const p = prev.stagedSummary
  const same =
    p.updates === sum.updates &&
    p.inserts === sum.inserts &&
    p.deletes === sum.deletes &&
    p.tables === sum.tables
  const keys = staged.order
  const old = prev.dirtyTables
  const sameTables = old.size === keys.length && keys.every((k) => old.has(k))
  return {
    staged,
    stagedSummary: same ? p : sum.total === 0 ? NO_SUMMARY : sum,
    dirtyTables: sameTables ? old : keys.length === 0 ? NO_TABLES : new Set(keys),
  }
}

/** Forgets a table's staged changes: it was dropped or emptied under them. */
export function forgetTable(s: State, ref: State['activeRef'] & object): Partial<State> {
  if (!s.activeConnectionId) return {}
  return {
    ...withStaged(s, removeTable(s.staged, tableKey(s.activeConnectionId, ref))),
    editing: null,
  }
}

interface Io {
  tracked: <T>(fn: () => Promise<T>) => Promise<T>
  fetchRows: () => Promise<void>
}

export function createEditSlice(set: (p: Partial<State>) => void, get: () => State, io: Io) {
  const toast = (kind: 'error' | 'info', msg: string) => get().pushToast(kind, msg)

  /** Rows on screen: the page, then the rows staged for insert. */
  const rowCount = (s: State) => (s.result?.rows.length ?? 0) + activeEdits(s).inserts.length

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
      return { input: activeEdits(s).inserts[row - rs.rows.length]?.set[name], original: null }
    }
    const k = keyedAt(s, row)
    return {
      input: k ? activeEdits(s).updates[k.key]?.set[name] : undefined,
      original: rs.rows[row][col],
    }
  }

  /** Puts `input` on one cell of the current page or of an insert row. */
  function stageOne(
    s: State,
    e: EditSet,
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
   * Only for actions that make staged edits meaningless, such as disconnecting
   * the connection they belong to. A page turn, sort or refresh does not: edits
   * are keyed by row, not position, and survive a reload.
   */
  function holdForDiscard(retry: () => Promise<void>): boolean {
    const count = totalOf(get().staged).total
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

  /** Where the staged set lives, for a message: "conn/db". */
  function scopeLabel(s: State, scope: { connectionId: string; database: string }) {
    const name = s.connections.find((c) => c.id === scope.connectionId)?.name ?? scope.connectionId
    return scope.database ? `${name}/${scope.database}` : name
  }

  /**
   * Whether the table on screen may take an edit. A change set is one
   * transaction, so it cannot span connections or databases: a second one is
   * refused with the way out, not quietly started as a separate set.
   */
  function clashMessage(s: State): string | null {
    if (!s.activeConnectionId || !s.activeRef) return null
    const held = scopeClash(s.staged, {
      connectionId: s.activeConnectionId,
      database: s.activeRef.database,
    })
    if (!held) return null
    const n = s.stagedSummary.total
    return `Apply or discard ${n} staged change${n === 1 ? '' : 's'} in ${scopeLabel(s, held)} first`
  }

  /** Stages a change on the table on screen; null, after saying why, if it cannot be. */
  function stage(s: State, change: (e: EditSet) => EditSet): Partial<State> | null {
    const clash = clashMessage(s)
    if (clash) {
      toast('error', clash)
      return null
    }
    const next = commit(
      s.staged,
      { connectionId: s.activeConnectionId!, database: s.activeRef!.database },
      s.activeRef!,
      change,
    )
    return withStaged(s, next)
  }

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
      if (k && activeEdits(s).deletes[k.key]) continue
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
    const patch = stage(s, (e) =>
      cells.reduce((acc, c) => {
        const { original } = currentInput(s, c.row, c.col)
        return stageOne(s, acc, c.row, c.col, input, original)
      }, e),
    )
    if (!patch) return
    set(patch)
    if (skipped) toast('info', `Some cells were left alone — ${skipped}`)
  }

  const actions: EditActions = {
    async startEdit(large = false) {
      const s = get()
      const sel = browseSelection(s)
      if (!sel || s.view !== 'data') return
      const rs = s.result!
      const { row, col } = sel.focus
      const column = columnAt(s, col)
      const name = rs.columns[col]?.name ?? 'This cell'
      const why = blockReason(s, column)
      if (why) return toast('info', `${name} cannot be edited: ${why}`)
      const clash = clashMessage(s)
      if (clash) return toast('error', clash)

      const isInsert = row >= rs.rows.length
      if (!isInsert) {
        const k = keyedAt(s, row)
        if (!k) return toast('info', 'This row cannot be addressed by its key')
        if (activeEdits(s).deletes[k.key]) {
          return toast('info', 'This row is staged for deletion — undo that to edit it')
        }
      }

      const dataType = `${rs.columns[col].dbType} ${column?.dataType ?? ''}`
      const { input } = currentInput(s, row, col)
      const loaded = isInsert ? null : rs.rows[row][col]
      const base = { row, col, column: name, dataType }

      // A capped value must never be edited as shown: saving it would overwrite
      // the real one with its first 1024 characters. A capped cell therefore
      // always opens the large editor, in a loading state, and only takes text
      // once the whole value has arrived.
      if (!input && !isInsert && isCellTruncated(rs, row, col)) {
        const pending: Editing = {
          ...base,
          mode: 'large',
          loading: true,
          text: '',
          original: '',
        }
        set({ editing: pending })
        let full: string
        try {
          const res = await io.tracked(() =>
            api.readCell({
              connectionId: s.activeConnectionId!,
              ref: s.activeRef!,
              column: name,
              filter: s.filter,
              orderBy: s.orderBy,
              applyDefaultSort: !s.sortChosen,
              rowOffset: absoluteRowOffset(row, {
                // Infinite scroll stacks every page from the top, so the index is
                // already absolute (and `page` only counts what is loaded).
                enabled: s.paginationEnabled && !s.settings.infiniteScroll,
                page: s.page,
                pageSize: s.pageSize,
              }),
              ...keyFor(rs, row, s.editKey),
            }),
          )
          if (res.truncated) {
            if (get().editing === pending) set({ editing: null })
            return toast('error', `${name} is too large to edit here`)
          }
          full = res.value ?? ''
        } catch (e) {
          if (get().editing === pending) set({ editing: null })
          return toast('error', errorMessage(e))
        }
        // Cancelled, or the page replaced, while this was in flight.
        if (get().editing !== pending || get().result !== rs) return
        set({ editing: { ...base, mode: 'large', text: full, original: full, full } })
        return
      }

      const original = cellInputText(loaded)
      const text = input ? (input.kind === 'value' ? (input.value ?? '') : '') : original
      const mode = large || wantsLarge(text, dataType) ? 'large' : 'inline'
      set({ editing: { ...base, mode, text, original } })
    },

    commitEdit(text) {
      const s = get()
      const ed = s.editing
      if (!ed || !s.result) return
      const { original } = currentInput(s, ed.row, ed.col)
      const input: CellInput = { kind: 'value', value: text }
      const patch = stage(s, (e) =>
        stageOne(s, e, ed.row, ed.col, input, ed.full !== undefined ? ed.full : original),
      )
      set({ ...patch, editing: null })
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
      const patch = stage(s, addInsert)
      if (!patch) return
      set({ ...patch, selection: { source: 'browse', anchor: pos, focus: pos } })
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
          inserts.push(activeEdits(s).inserts[row - base].id)
        }
      }
      const patch = stage(s, (e) => inserts.reduce(removeInsert, toggleDelete(e, existing)))
      if (!patch) return
      const left = editsFor(patch.staged!, activeTableKey(s)!).inserts.length
      set({ ...patch, ...clampedSelection(s, base + left) })
    },

    undoEdit() {
      const s = get()
      if (s.staged.past.length === 0) return
      const staged = undo(s.staged)
      const key = activeTableKey(s)
      const inserts = key ? editsFor(staged, key).inserts.length : 0
      set({
        ...withStaged(s, staged),
        editing: null,
        ...clampedSelection(s, (s.result?.rows.length ?? 0) + inserts),
      })
    },

    async goToChangedTable() {
      const s = get()
      const { order, tables, scope } = s.staged
      if (!scope || order.length === 0) return toast('info', 'No table has staged changes')
      const at = order.indexOf(activeTableKey(s) ?? '')
      const { ref } = tables[order[(at + 1) % order.length]]
      // The set is one connection and database, but the screen may be elsewhere.
      if (s.activeConnectionId !== scope.connectionId) await get().connect(scope.connectionId)
      if (get().activeDatabase !== ref.database) await get().selectDatabase(ref.database)
      await get().openObject({ schema: ref.schema, name: ref.name, type: 'table' })
    },

    discardChanges() {
      const count = totalOf(get().staged).total
      if (count === 0) return
      if (count < DISCARD_CONFIRM_AT) return clearStaged()
      set({ dialog: { kind: 'confirmDiscard', count, proceed: async () => clearStaged() } })
    },

    async reviewChanges() {
      const s = get()
      const request = toChangesRequest(s.staged)
      if (!request) return toast('info', 'No staged changes to accept')
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
      // The grid on screen may be one of the tables just written.
      const s = get()
      const touched = review.request.changes.some(
        (c) =>
          s.activeConnectionId === review.request.connectionId &&
          s.activeRef?.database === c.ref.database &&
          s.activeRef.schema === c.ref.schema &&
          s.activeRef.name === c.ref.name,
      )
      if (touched) await io.fetchRows()
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
    if (get().stagedSummary.total === 0) return
    e.preventDefault()
    e.returnValue = ''
  })
}

/** The row's key for ReadCell, as a spread: empty when the table has none. */
function keyFor(
  rs: Parameters<typeof rowKeyOf>[0],
  row: number,
  editKey: string[],
): { key?: Record<string, Cell> } {
  const key = rowKeyOf(rs, row, editKey)
  return key ? { key } : {}
}
