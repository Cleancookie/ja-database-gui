import { create } from 'zustand'
import { reuseUnchanged } from './activity'
import { api, errorMessage } from './api'
import { absoluteRowOffset, cellText, isCellTruncated } from './cells'
import { RECENT_LIMIT, refKey } from './recency'
import { downloadText } from './dom'
import { csv, describeCopy, rectOf, selectionText, type CellPos, type Selection } from './selection'
import { startFlushing } from './perf'
import {
  INITIAL_EDIT_STATE,
  createEditSlice,
  forgetTable,
  guardUnload,
  type EditActions,
  type EditState,
} from './storeEdits'
import { mark, reportText } from './startup'
import { applyTheme, DEFAULT_THEME } from './themes'
import type {
  ActivityResult,
  Capabilities,
  Cell,
  Connection,
  CreateTableSpec,
  GridColumn,
  Kind,
  ObjectDetail,
  ObjectRef,
  ObjectType,
  ResultSet,
  SchemaObject,
  Settings,
  Sort,
} from './types'

export const PAGE_SIZES = [50, 100, 200, 500, 1000] as const

export interface Toast {
  id: number
  kind: 'error' | 'info'
  message: string
}

/** One cell, as the viewer needs to see it. */
export interface CellTarget {
  column: string
  dbType: string
  value: Cell
  /** The text cap shortened this value; the whole thing is a fetch away. */
  truncated: boolean
  /**
   * The row's absolute offset in the filtered, sorted result, which is how the
   * full value is fetched. null when there is nothing to fetch from — an
   * ad-hoc SQL result has no table to go back to.
   */
  rowOffset: number | null
}

export type DialogState =
  | { kind: 'none' }
  | { kind: 'connection'; connection: Connection | null }
  | { kind: 'shortcuts' }
  | { kind: 'settings' }
  | { kind: 'confirmDelete'; connection: Connection }
  | { kind: 'cell'; cell: CellTarget }
  | { kind: 'confirmCancel'; queryId: string; sql: string }
  | { kind: 'confirmTruncate'; ref: ObjectRef }
  | { kind: 'confirmDrop'; ref: ObjectRef; type: ObjectType }
  | { kind: 'newTable'; schema: string }
  | { kind: 'reviewChanges' }
  /** Staged edits are about to be lost; `proceed` is what the user asked for. */
  | { kind: 'confirmDiscard'; count: number; proceed: () => void | Promise<void> }

/** Which grid a cell came from, since only the browse grid can re-read it. */
export type ResultSource = 'browse' | 'sql'

/**
 * The two palettes.
 *
 * 'go' navigates — connections, databases, tables. 'do' runs actions —
 * settings, the activity tray, pagination. Splitting them is what lets each be
 * short enough to scan: a single list mixing seventeen tables with twenty
 * commands meant neither could be found by typing two letters.
 */
export type PaletteMode = 'go' | 'do'

/** Which pane fills the main area. */
export type View = 'data' | 'sql' | 'activity' | 'details'

/** Collapsible sidebar sections. */
export type SectionKey = 'connections' | 'databases' | 'objects'

export const DEFAULT_SETTINGS: Settings = {
  theme: DEFAULT_THEME,
  fontSizePx: 16,
  defaultPageSize: 100,
  paginationEnabled: true,
  rowCap: 100_000,
  textCapChars: 1024,
  showSystemObjects: false,
  autoCount: true,
  confirmDestructive: true,
  sidebarWidthPx: 256,
  trayHeightPx: 260,
}

export interface State extends EditState, EditActions {
  // catalogue
  drivers: Record<Kind, Capabilities> | null
  connections: Connection[]
  connectedIds: string[]

  // active connection
  activeConnectionId: string | null
  capabilities: Capabilities | null
  databases: string[]
  activeDatabase: string
  objects: SchemaObject[]

  // active object
  activeRef: ObjectRef | null
  /**
   * Objects opened this session, most recent first, as refKey strings.
   *
   * There are no tabs in this app — deliberately — so switching back and forth
   * happens through the palette, and the palette is only as good as its
   * ordering. Alphabetical is useless for that: the two tables being compared
   * are rarely neighbours in the alphabet.
   *
   * Session-only. Persisting it would mean a list of table names in the config
   * file for a need that is entirely about the last few minutes.
   */
  recentObjects: string[]
  columns: GridColumn[]
  result: ResultSet | null
  orderBy: Sort[]
  /**
   * Whether the sort above is the user's doing. False until they touch a
   * header, which is what lets a freshly opened table default to primary key
   * descending while an empty sort they cycled to themselves stays empty. The
   * server is told which of the two an empty orderBy is.
   */
  sortChosen: boolean

  // filter (Ctrl+F) — raw SQL after WHERE
  filter: string

  // pagination
  paginationEnabled: boolean
  page: number
  pageSize: number
  hasMore: boolean
  totalCount: number | null

  // sql editor
  sqlText: string
  /**
   * Every result set the last run produced, in order. A batch is one round
   * trip that can answer several times over — `use other_db; select …` — and
   * the editor puts a tab on each. Empty until something has been run.
   */
  sqlResults: ResultSet[]
  /** Which of them the editor is showing. */
  sqlResultIndex: number
  /** The run produced more result sets than were kept — see MaxResultSets. */
  moreSqlResults: boolean

  // table details page
  detail: ObjectDetail | null
  detailLoading: boolean
  detailError: string | null

  /**
   * The selected cell range, and which grid it belongs to.
   *
   * In the store rather than in DataGrid because the selection is something the
   * rest of the app acts on — the palette copies it, the cell menu reads it —
   * and because it must survive the grid remounting when the axes are flipped.
   * Always in *source* row/column coordinates, whichever way round the grid is
   * drawn.
   */
  selection: (Selection & { source: ResultSource }) | null

  // ui
  view: View
  /** Grid orientation: false is rows across, true is one record per column.
   *  Shared by the browser and the editor's result — Tab means the same thing
   *  wherever a grid is on screen. */
  transposed: boolean
  collapsed: Record<SectionKey, boolean>
  settings: Settings
  activity: ActivityResult
  /** When the activity snapshot was taken, so the tray can tick its timers on
   *  between polls. See frontend/src/activity.ts. */
  activityPolledAt: number
  /** How many API calls the app is currently waiting on. The tray polls only
   *  while this is above zero, so an idle app issues no requests at all. */
  inFlight: number
  trayOpen: boolean
  /** null when no palette is open. */
  palette: PaletteMode | null
  dialog: DialogState
  busy: boolean
  toasts: Toast[]

  // actions
  init: () => Promise<void>
  refreshConnections: () => Promise<void>
  connect: (id: string) => Promise<void>
  disconnect: (id: string) => Promise<void>
  selectDatabase: (name: string) => Promise<void>
  openObject: (o: SchemaObject) => Promise<void>
  reload: () => Promise<void>
  setFilter: (f: string) => void
  applyFilter: (f: string) => Promise<void>
  setPage: (p: number) => Promise<void>
  setPageSize: (n: number) => Promise<void>
  setPaginationEnabled: (on: boolean) => Promise<void>
  toggleSort: (column: string) => Promise<void>
  clearSort: () => Promise<void>
  setView: (v: View) => void
  toggleTransposed: () => void
  /** Starts a new selection at one cell — a plain click, or an arrow key. */
  selectCell: (source: ResultSource, pos: CellPos) => void
  /** Moves the focus corner, keeping the anchor — shift-click, or shift+arrow. */
  extendSelection: (source: ResultSource, pos: CellPos) => void
  /** Selects the whole result. */
  selectAll: (source: ResultSource) => void
  clearSelection: () => void
  /**
   * Copies the selection: the value for one cell, an `IN (…)` list for one
   * column, CSV for anything wider. See frontend/src/selection.ts.
   */
  copySelection: () => Promise<void>
  /**
   * Loads the details of a table or view and shows the details page.
   *
   * Nothing is cached: the page is opened deliberately and the interesting
   * numbers (row estimate, size) are the ones that move, so a stale panel would
   * be worse than a second of loading.
   */
  openDetails: (ref: ObjectRef) => Promise<void>

  /**
   * The three schema changes, each in two halves.
   *
   * The `truncateTable` / `dropObject` / `newTable` half is the *action* — what
   * the palette entry and the context-menu item both fire, and the only half a
   * caller should reach for. It decides whether a confirmation is owed, which is
   * a question about settings that no call site should have to re-ask.
   *
   * The `run…` half is what the confirmation dialog calls once the user has said
   * yes. Nothing else should call it: doing so is how a destructive statement
   * ends up with no confirmation on one route and one on another.
   */
  truncateTable: (ref: ObjectRef) => Promise<void>
  runTruncate: (ref: ObjectRef) => Promise<void>
  dropObject: (ref: ObjectRef, type: ObjectType) => Promise<void>
  runDrop: (ref: ObjectRef, type: ObjectType) => Promise<void>
  /** Opens the new-table dialog. `schema` is a default, not a constraint. */
  newTable: (schema?: string) => void
  createTable: (spec: CreateTableSpec) => Promise<void>

  toggleSection: (k: SectionKey) => void
  loadSettings: () => Promise<void>
  saveSettings: (s: Settings) => Promise<void>
  refreshActivity: () => Promise<void>
  cancelQuery: (id: string) => Promise<void>
  clearQueryHistory: () => Promise<void>
  setTrayOpen: (open: boolean) => void
  setSqlText: (t: string) => void
  runSql: () => Promise<void>
  /** Switches result tabs. The selection goes with the old one. */
  selectSqlResult: (index: number) => void
  saveConnection: (c: Connection, password: string | null) => Promise<void>
  deleteConnection: (id: string) => Promise<void>
  setPalette: (mode: PaletteMode | null) => void
  setDialog: (d: DialogState) => void
  /** Resolves a grid coordinate to a cell, or null if there is nothing there. */
  cellTarget: (source: ResultSource, rowIndex: number, colIndex: number) => CellTarget | null
  openCell: (source: ResultSource, rowIndex: number, colIndex: number) => void
  /** Copies a cell; `full` re-reads it uncapped first. */
  copyCell: (
    source: ResultSource,
    rowIndex: number,
    colIndex: number,
    full?: boolean,
  ) => Promise<void>
  copyText: (text: string) => Promise<void>
  /** Saves the result on screen as a CSV file — the browse page or the editor's. */
  exportCsv: () => void
  pushToast: (kind: Toast['kind'], message: string) => void
  dismissToast: (id: number) => void
}

/**
 * Responses are matched against this counter before being applied. Paging
 * quickly, or retyping a filter, can leave an earlier request in flight;
 * without the guard a slow first response would overwrite a newer one and the
 * grid would show rows that do not match what the controls say.
 */
let requestSeq = 0
let toastSeq = 0

export const useStore = create<State>((set, get) => {
  /**
   * Wraps a call that runs SQL on the server. The count it maintains is what
   * tells the activity tray there is something worth polling for — the tray
   * cannot know from the outside, and polling on a timer regardless would mean
   * a request every second on an app sitting untouched.
   */
  async function tracked<T>(fn: () => Promise<T>): Promise<T> {
    set({ inFlight: get().inFlight + 1 })
    try {
      return await fn()
    } finally {
      set({ inFlight: get().inFlight - 1 })
    }
  }

  /** Fetches the current page and, separately, the total count. */
  async function fetchRows() {
    const s = get()
    if (!s.activeConnectionId || !s.activeRef) return

    const seq = ++requestSeq
    const { activeConnectionId, activeRef, filter, orderBy, sortChosen } = s
    set({ busy: true })

    try {
      const res = await tracked(() =>
        api.readRows({
          connectionId: activeConnectionId,
          ref: activeRef,
          filter,
          orderBy,
          applyDefaultSort: !sortChosen,
          pagination: {
            enabled: s.paginationEnabled,
            page: s.page,
            pageSize: s.pageSize,
          },
        }),
      )
      if (seq !== requestSeq) return
      set({
        result: res.result,
        columns: res.columns,
        // An open editor addresses rows by position, and this page may be a
        // different set of rows.
        editing: null,
        editKey: res.editKey ?? [],
        readOnlyReason: res.readOnlyReason,
        // A table opened without a sort gets the server's default — primary
        // key descending. Adopting it here is what marks the header and what
        // gives the next header click something to cycle on from. sortChosen
        // stays false: this is still not the user's choice.
        ...(!sortChosen && orderBy.length === 0 && res.orderBy?.length
          ? { orderBy: res.orderBy }
          : {}),
        hasMore: res.hasMore,
        busy: false,
      })
    } catch (e) {
      if (seq !== requestSeq) return
      set({ busy: false })
      get().pushToast('error', errorMessage(e))
      return
    }

    // The count is deliberately not awaited above: COUNT(*) on a large table
    // is slow and must not delay the rows the user asked for.
    if (!get().settings.autoCount) {
      set({ totalCount: null })
      return
    }
    void (async () => {
      set({ totalCount: null })
      try {
        const n = await tracked(() =>
          api.countRows({
            connectionId: activeConnectionId,
            ref: activeRef,
            filter,
          }),
        )
        if (seq === requestSeq) set({ totalCount: n })
      } catch {
        // A failed count is not worth interrupting the user over — the grid
        // simply shows no total.
      }
    })()
  }

  const edits = createEditSlice(set, get, { tracked, fetchRows })
  const holdForDiscard = edits.holdForDiscard

  return {
    ...INITIAL_EDIT_STATE,
    ...edits.actions,
    drivers: null,
    connections: [],
    connectedIds: [],
    activeConnectionId: null,
    capabilities: null,
    databases: [],
    activeDatabase: '',
    objects: [],
    activeRef: null,
    recentObjects: [],
    columns: [],
    result: null,
    orderBy: [],
    sortChosen: false,
    filter: '',
    paginationEnabled: true,
    page: 1,
    pageSize: 100,
    hasMore: false,
    totalCount: null,
    sqlText: '',
    sqlResults: [],
    sqlResultIndex: 0,
    moreSqlResults: false,
    detail: null,
    detailLoading: false,
    detailError: null,
    selection: null,
    view: 'data',
    transposed: false,
    collapsed: { connections: false, databases: false, objects: false },
    settings: DEFAULT_SETTINGS,
    activity: { queries: [], sessions: [] },
    activityPolledAt: 0,
    inFlight: 0,
    trayOpen: false,
    palette: null,
    dialog: { kind: 'none' },
    busy: false,
    toasts: [],

    async init() {
      guardUnload(get)
      try {
        const [drivers, connections, connectedIds, settings] = await Promise.all([
          api.drivers(),
          api.listConnections(),
          api.connectedIds(),
          api.getSettings(),
        ])
        set({
          drivers,
          connections,
          connectedIds: connectedIds ?? [],
          settings,
          // Seed the browse controls from the saved preferences.
          pageSize: settings.defaultPageSize,
          paginationEnabled: settings.paginationEnabled,
        })
        applyAppearance(settings)
        mark('config loaded')
        // Startup timing only exists in the webview — the boot and the bundle
        // parse both happen before Go runs again — so it is sent back to be
        // written to the log file, where it can be read after the fact.
        void api.logClient(`startup ${reportText()}`).catch(() => {
          // A failed log line is never worth a toast.
        })
        // From here on the interaction timings go the same way, so that "why
        // did it feel slow yesterday" is a question the log file answers.
        startFlushing((line) => {
          void api.logClient(line).catch(() => {})
        })
      } catch (e) {
        get().pushToast('error', errorMessage(e))
      }
    },

    async refreshConnections() {
      try {
        set({ connections: await api.listConnections() })
      } catch (e) {
        get().pushToast('error', errorMessage(e))
      }
    },

    async connect(id) {
      set({ busy: true })
      try {
        const res = await tracked(() => api.connect(id))
        const databases = res.databases.map((d) => d.name)
        const active = res.defaultDatabase || databases[0] || ''
        set({
          activeConnectionId: id,
          capabilities: res.capabilities,
          databases,
          activeDatabase: active,
          connectedIds: Array.from(new Set([...get().connectedIds, id])),
          objects: [],
          activeRef: null,
          result: null,
          columns: [],
          filter: '',
          page: 1,
          totalCount: null,
          busy: false,
        })
        if (active) await get().selectDatabase(active)
      } catch (e) {
        set({ busy: false })
        get().pushToast('error', errorMessage(e))
      }
    },

    async disconnect(id) {
      // Edits staged for this connection have nowhere to go once it is closed.
      if (get().staged.scope?.connectionId === id && holdForDiscard(() => get().disconnect(id))) {
        return
      }
      try {
        await api.disconnect(id)
      } catch (e) {
        get().pushToast('error', errorMessage(e))
      }
      const stillActive = get().activeConnectionId === id
      set({
        connectedIds: get().connectedIds.filter((c) => c !== id),
        ...(stillActive
          ? {
              activeConnectionId: null,
              capabilities: null,
              databases: [],
              activeDatabase: '',
              objects: [],
              activeRef: null,
              result: null,
              columns: [],
              totalCount: null,
            }
          : {}),
      })
    },

    async selectDatabase(name) {
      const id = get().activeConnectionId
      if (!id) return
      set({ activeDatabase: name, busy: true, objects: [] })
      try {
        const objects = await tracked(() => api.listObjects(id, name))
        set({ objects, busy: false })
      } catch (e) {
        set({ busy: false })
        get().pushToast('error', errorMessage(e))
      }
    },

    async openObject(o) {
      const s = get()
      if (!s.activeConnectionId) return
      // Functions and procedures have no rows to browse. Selecting one in the
      // palette should not blank the grid.
      if (o.type === 'function' || o.type === 'procedure') {
        s.pushToast('info', `${o.name} is a ${o.type} — open the SQL editor to call it`)
        return
      }
      const key = refKey(s.activeDatabase, o.schema, o.name)
      set({
        activeRef: { database: s.activeDatabase, schema: o.schema, name: o.name },
        // Moved to the front, and de-duplicated, so re-opening a table does not
        // leave a stale copy further down the list.
        recentObjects: [key, ...s.recentObjects.filter((k) => k !== key)].slice(0, RECENT_LIMIT),
        // A new table starts clean: carrying a filter written for the previous
        // table over would almost always be a syntax error.
        filter: '',
        orderBy: [],
        sortChosen: false,
        page: 1,
        totalCount: null,
        result: null,
        view: 'data',
      })
      await fetchRows()
    },

    async reload() {
      await fetchRows()
    },

    setFilter(filter) {
      set({ filter })
    },

    async applyFilter(filter) {
      set({ filter, page: 1, totalCount: null })
      await fetchRows()
    },

    async setPage(p) {
      const page = Math.max(1, p)
      if (page === get().page) return
      set({ page })
      await fetchRows()
    },

    async setPageSize(pageSize) {
      // Jumping to page 1 avoids landing past the end of a smaller result.
      set({ pageSize, page: 1 })
      await fetchRows()
    },

    async setPaginationEnabled(on) {
      set({ paginationEnabled: on, page: 1 })
      await fetchRows()
    },

    async toggleSort(column) {
      const current = get().orderBy[0]
      let orderBy: Sort[]
      if (!current || current.column !== column) orderBy = [{ column, desc: false }]
      else if (!current.desc) orderBy = [{ column, desc: true }]
      else orderBy = [] // third click clears the sort
      // From here on an empty sort means the user emptied it, so the default is
      // not put back. A table that opened on its primary key descending is one
      // click from unsorted, and the cycle from there is the plain
      // none → ascending → descending.
      set({ orderBy, sortChosen: true, page: 1 })
      await fetchRows()
    },

    async clearSort() {
      if (get().orderBy.length === 0 && get().sortChosen) return
      set({ orderBy: [], sortChosen: true, page: 1 })
      await fetchRows()
    },

    async openDetails(ref) {
      const connID = get().activeConnectionId
      if (!connID) return
      set({ view: 'details', detailLoading: true, detailError: null, detail: null })
      try {
        const detail = await api.describeObject(connID, ref)
        set({ detail, detailLoading: false })
      } catch (e) {
        set({ detailError: String(e), detailLoading: false })
      }
    },

    async truncateTable(ref) {
      if (get().settings.confirmDestructive) set({ dialog: { kind: 'confirmTruncate', ref } })
      else await get().runTruncate(ref)
    },

    async runTruncate(ref) {
      const s = get()
      if (!s.activeConnectionId) return
      const connectionId = s.activeConnectionId
      set({ dialog: { kind: 'none' } })
      try {
        await tracked(() => api.truncateTable({ connectionId, ref }))
        s.pushToast('info', `Emptied ${refLabel(ref)}`)
      } catch (e) {
        s.pushToast('error', errorMessage(e))
        return
      }
      // The row count in the sidebar is now wrong, and so is the grid if this is
      // the table on screen.
      await get().selectDatabase(get().activeDatabase)
      // The rows the staged edits point at are gone. The confirmation that got
      // here already said every row would be deleted.
      set(forgetTable(get(), ref))
      if (sameRef(get().activeRef, ref)) await fetchRows()
    },

    async dropObject(ref, type) {
      if (get().settings.confirmDestructive) set({ dialog: { kind: 'confirmDrop', ref, type } })
      else await get().runDrop(ref, type)
    },

    async runDrop(ref, type) {
      const s = get()
      if (!s.activeConnectionId) return
      const connectionId = s.activeConnectionId
      set({ dialog: { kind: 'none' } })
      try {
        await tracked(() => api.dropObject({ connectionId, ref, type }))
        s.pushToast('info', `Dropped ${refLabel(ref)}`)
      } catch (e) {
        s.pushToast('error', errorMessage(e))
        return
      }
      // Leaving the grid pointed at something that no longer exists would make
      // every refresh an error, so the view goes back to nothing selected.
      if (sameRef(get().activeRef, ref)) {
        set({
          activeRef: null,
          result: null,
          columns: [],
          filter: '',
          orderBy: [],
          sortChosen: false,
          totalCount: null,
          selection: null,
          view: 'data',
        })
      }
      set({ ...forgetTable(get(), ref), recentObjects: get().recentObjects.filter((k) => k !== refKey(ref.database, ref.schema, ref.name)) })
      await get().selectDatabase(get().activeDatabase)
    },

    newTable(schema) {
      set({ dialog: { kind: 'newTable', schema: schema ?? '' } })
    },

    async createTable(spec) {
      const s = get()
      if (!s.activeConnectionId) return
      const connectionId = s.activeConnectionId
      try {
        await tracked(() => api.createTable({ connectionId, spec }))
      } catch (e) {
        // The dialog stays open: the error is almost always a type the engine
        // did not accept, and closing would throw away the whole definition.
        s.pushToast('error', errorMessage(e))
        return
      }
      set({ dialog: { kind: 'none' } })
      s.pushToast('info', `Created ${refLabel(spec.ref)}`)
      await get().selectDatabase(get().activeDatabase)
      // Opening it is the point of having made it, and an empty grid with the
      // new columns across the top is the quickest confirmation it is right.
      await get().openObject({ schema: spec.ref.schema, name: spec.ref.name, type: 'table' })
    },

    setView(view) {
      set({ view })
      // Entering the activity page should show current data immediately
      // rather than after the first poll tick.
      if (view === 'activity') void get().refreshActivity()
    },

    toggleTransposed() {
      set({ transposed: !get().transposed })
    },

    selectCell(source, pos) {
      set({ selection: { source, anchor: pos, focus: pos } })
    },

    extendSelection(source, pos) {
      const cur = get().selection
      // Shift-clicking with nothing selected, or in the other grid, has no
      // anchor to extend from, so it starts one where the user clicked.
      if (!cur || cur.source !== source) {
        set({ selection: { source, anchor: pos, focus: pos } })
        return
      }
      set({ selection: { ...cur, focus: pos } })
    },

    selectAll(source) {
      const rs = source === 'sql' ? activeSqlResult(get()) : get().result
      if (!rs || rs.rows.length === 0 || rs.columns.length === 0) return
      set({
        selection: {
          source,
          anchor: { row: 0, col: 0 },
          focus: { row: rs.rows.length - 1, col: rs.columns.length - 1 },
        },
      })
    },

    clearSelection() {
      set({ selection: null })
    },

    async copySelection() {
      const s = get()
      const sel = s.selection
      if (!sel) return
      const rs = sel.source === 'sql' ? activeSqlResult(s) : s.result
      if (!rs) return

      // Clamped, because a result can be replaced under a selection — a smaller
      // page, or a filter that returned fewer rows.
      const r = rectOf(sel)
      const top = Math.max(0, r.top)
      const left = Math.max(0, r.left)
      const bottom = Math.min(rs.rows.length - 1, r.bottom)
      const right = Math.min(rs.columns.length - 1, r.right)
      if (bottom < top || right < left) return

      const columns = rs.columns.slice(left, right + 1).map((c) => c.name)
      const rows = rs.rows.slice(top, bottom + 1).map((row) => row.slice(left, right + 1))

      await s.copyText(selectionText(columns, rows))

      // A capped value copied into an IN list is silently the wrong value, so
      // say so. The count matters more than which cells: the fix is the same
      // either way, open them and copy in full.
      let cut = 0
      for (const c of rs.truncatedCells ?? []) {
        if (c.row >= top && c.row <= bottom && c.col >= left && c.col <= right) cut++
      }
      const what = describeCopy(columns, rows)
      if (cut > 0) {
        s.pushToast('error', `${what} — ${cut} were cut to ${rs.textCap} characters and are partial`)
      } else {
        s.pushToast('info', what)
      }
    },

    toggleSection(k) {
      set({ collapsed: { ...get().collapsed, [k]: !get().collapsed[k] } })
    },

    async loadSettings() {
      try {
        const settings = await api.getSettings()
        set({ settings })
        applyAppearance(settings)
      } catch (e) {
        get().pushToast('error', errorMessage(e))
      }
    },

    async saveSettings(next) {
      const before = get().settings
      try {
        const saved = await api.saveSettings(next)
        set({ settings: saved })
        applyAppearance(saved)
        // The cap is applied by the query, so a changed cap only reaches the
        // grid on the next read. Doing it here saves the user wondering why
        // the setting appeared to do nothing.
        if (saved.textCapChars !== before.textCapChars && get().activeRef) {
          await fetchRows()
        }
      } catch (e) {
        get().pushToast('error', errorMessage(e))
      }
    },

    async refreshActivity() {
      try {
        const fresh = await api.activity()
        const activity = {
          ...fresh,
          queries: reuseUnchanged(get().activity.queries, fresh.queries),
        }
        // The stamp is taken after the response lands, because it is what the
        // tray's tick counts forward from.
        set({ activity, activityPolledAt: Date.now() })
      } catch {
        // The tray polls; a transient failure would otherwise produce a stream
        // of toasts the user cannot act on.
      }
    },

    async cancelQuery(id) {
      // The confirmation, when there is one, is dismissed before the request:
      // a runaway query is being stopped and the dialog must not sit there
      // while the driver unwinds.
      if (get().dialog.kind === 'confirmCancel') set({ dialog: { kind: 'none' } })
      try {
        await api.cancelQuery(id)
        await get().refreshActivity()
      } catch (e) {
        get().pushToast('error', errorMessage(e))
      }
    },

    async clearQueryHistory() {
      try {
        await api.clearQueryHistory()
        await get().refreshActivity()
      } catch (e) {
        get().pushToast('error', errorMessage(e))
      }
    },

    setTrayOpen(trayOpen) {
      set({ trayOpen })
      // Expanding should show the current list immediately rather than after
      // the first poll tick.
      if (trayOpen) void get().refreshActivity()
    },

    setSqlText(sqlText) {
      set({ sqlText })
    },

    async runSql() {
      const s = get()
      if (!s.activeConnectionId) {
        s.pushToast('error', 'Connect to a database first')
        return
      }
      if (!s.sqlText.trim()) return
      const connectionId = s.activeConnectionId
      set({ busy: true })
      try {
        const res = await tracked(() =>
          api.runSql({
            connectionId,
            database: s.activeDatabase,
            sql: s.sqlText,
            maxRows: 0,
          }),
        )
        set({
          sqlResults: res.results,
          sqlResultIndex: 0,
          moreSqlResults: res.moreResults,
          // The old result's selection means nothing against the new one.
          selection: s.selection?.source === 'sql' ? null : s.selection,
          busy: false,
        })
        // Only a statement with nothing to show says how many rows it moved.
        // With a grid on screen the row count is already in front of the user.
        const only = res.results.length === 1 ? res.results[0] : null
        if (only && only.rowsAffected != null) {
          s.pushToast('info', `${only.rowsAffected} row(s) affected in ${only.elapsedMs}ms`)
        }
      } catch (e) {
        set({ busy: false })
        get().pushToast('error', errorMessage(e))
      }
    },

    selectSqlResult(index) {
      const s = get()
      if (index < 0 || index >= s.sqlResults.length || index === s.sqlResultIndex) return
      set({
        sqlResultIndex: index,
        selection: s.selection?.source === 'sql' ? null : s.selection,
      })
    },

    async saveConnection(connection, password) {
      try {
        await api.saveConnection({ connection, password })
        await get().refreshConnections()
        set({ dialog: { kind: 'none' } })
      } catch (e) {
        get().pushToast('error', errorMessage(e))
      }
    },

    async deleteConnection(id) {
      try {
        await api.deleteConnection(id)
        if (get().activeConnectionId === id) await get().disconnect(id)
        await get().refreshConnections()
        set({ dialog: { kind: 'none' } })
      } catch (e) {
        get().pushToast('error', errorMessage(e))
      }
    },

    setPalette(palette) {
      set({ palette })
    },

    setDialog(dialog) {
      set({ dialog })
    },

    cellTarget(source, rowIndex, colIndex) {
      const s = get()
      const rs = source === 'sql' ? activeSqlResult(s) : s.result
      if (!rs) return null
      const column = rs.columns[colIndex]
      const value = rs.rows[rowIndex]?.[colIndex]
      if (!column || value === undefined) return null
      return {
        column: column.name,
        dbType: column.dbType,
        value,
        truncated: isCellTruncated(rs, rowIndex, colIndex),
        // The same absolute coordinate the row gutter is showing, which is what
        // ReadCell addresses rows by.
        rowOffset:
          source === 'browse' && s.activeRef
            ? absoluteRowOffset(rowIndex, {
                enabled: s.paginationEnabled,
                page: s.page,
                pageSize: s.pageSize,
              })
            : null,
      }
    },

    openCell(source, rowIndex, colIndex) {
      const cell = get().cellTarget(source, rowIndex, colIndex)
      if (cell) set({ dialog: { kind: 'cell', cell } })
    },

    async copyCell(source, rowIndex, colIndex, full = false) {
      const s = get()
      const cell = s.cellTarget(source, rowIndex, colIndex)
      if (!cell) return
      let text = cellText(cell.value)

      // Only worth a round trip when there is more to get: an untruncated cell
      // is already whole in the grid.
      if (full && cell.truncated && cell.rowOffset !== null && s.activeConnectionId && s.activeRef) {
        try {
          const res = await api.readCell({
            connectionId: s.activeConnectionId,
            ref: s.activeRef,
            column: cell.column,
            filter: s.filter,
            orderBy: s.orderBy,
            applyDefaultSort: !s.sortChosen,
            rowOffset: cell.rowOffset,
          })
          text = res.value ?? ''
        } catch (e) {
          s.pushToast('error', errorMessage(e))
          return
        }
      }

      await s.copyText(text)
    },

    async copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // Clipboard access can be refused. Silence would look exactly like a
        // menu item that does nothing.
        get().pushToast('error', 'Could not write to the clipboard')
      }
    },

    exportCsv() {
      const s = get()
      // Whichever grid is on screen — the editor's active result tab, or the
      // browse page. Same CSV writer the clipboard uses, so a file and a paste
      // of the same rows are byte-identical.
      const rs = s.view === 'sql' ? activeSqlResult(s) : s.result
      if (!rs || rs.columns.length === 0) {
        s.pushToast('error', 'Nothing to export')
        return
      }
      const stem = s.view === 'sql' ? 'query' : (s.activeRef?.name ?? 'result')
      const name = `${stem.replace(/[^\w.-]+/g, '_')}.csv`
      downloadText(
        name,
        csv(
          rs.columns.map((c) => c.name),
          rs.rows,
        ),
      )
      // The browse grid holds one page, and capped cells are partial in the
      // file exactly as they are in the grid. Both are the kind of quiet
      // wrongness a CSV carries off into a spreadsheet, so say them out loud.
      const cut = rs.truncatedCells?.length ?? 0
      const note = cut > 0 ? ` — ${cut} cells were cut to ${rs.textCap} characters` : ''
      s.pushToast(cut > 0 ? 'error' : 'info', `Exported ${rs.rows.length} rows to ${name}${note}`)
    },

    pushToast(kind, message) {
      const id = ++toastSeq
      set({ toasts: [...get().toasts, { id, kind, message }] })
      // Errors stay until dismissed; they often contain the SQL detail the
      // user needs to read carefully.
      if (kind === 'info') {
        setTimeout(() => get().dismissToast(id), 4000)
      }
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) })
    },
  }
})

/**
 * How an object is named in a toast or a confirmation.
 *
 * Deliberately not commands.ts's qualifiedName, which this would otherwise
 * reuse: commands.ts imports values from this file, so importing back would
 * close a cycle for the sake of one string join.
 */
export function refLabel(ref: ObjectRef): string {
  return ref.schema ? `${ref.schema}.${ref.name}` : ref.name
}

function sameRef(a: ObjectRef | null, b: ObjectRef): boolean {
  return !!a && a.database === b.database && a.schema === b.schema && a.name === b.name
}

/**
 * The dialect of the active connection, or null when nothing is connected.
 *
 * Derived rather than stored: the connection list is already the source of
 * truth, and a second copy would be one more thing to keep in step. Used by
 * the editors, which need it for both highlighting and per-dialect functions.
 */
export function useActiveKind(): Kind | null {
  return useStore((s) => s.connections.find((c) => c.id === s.activeConnectionId)?.kind ?? null)
}

/**
 * The result set the editor is showing, or null before anything has run.
 *
 * Derived rather than stored beside the list: a copy of the active result
 * would be a second thing to keep in step with the tab index, and the two
 * drifting is exactly the bug that would show the wrong grid.
 */
export function activeSqlResult(s: State): ResultSet | null {
  return s.sqlResults[s.sqlResultIndex] ?? null
}

/** Whether the active dialect has schemas, so names are worth qualifying. */
export function useHasSchemas(): boolean {
  const kind = useActiveKind()
  return useStore((s) => (kind ? (s.drivers?.[kind]?.hasSchemas ?? false) : false))
}

/**
 * Pushes the two purely visual settings onto <html>, which is where the CSS
 * reads them from. Both are applied together because both arrive together:
 * every path that produces a Settings — startup, reload, save — wants both.
 *
 * The whole UI is sized in rem, so setting the root font size rescales
 * spacing and controls together rather than leaving big text in small boxes.
 */
function applyAppearance(s: Settings) {
  document.documentElement.style.fontSize = `${s.fontSizePx}px`
  applyTheme(s.theme)
}
