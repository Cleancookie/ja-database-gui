import { effectiveIsolation } from './isolation'
import {
  activeRun,
  addRun,
  clearUnpinned,
  closeRun,
  nextRunId,
  selectRun,
  stepTarget,
  togglePin,
  type SqlHistory,
  type SqlRunEntry,
} from './sqlHistory'
import { endRun, markCancelled, startRun, wasCancelled, type SqlRun } from './sqlRunState'
import { create } from 'zustand'
import { reuseUnchanged } from './activity'
import { api, errorMessage } from './api'
import { absoluteRowOffset, cellText, isCellTruncated } from './cells'
import { countOf, editsFor, removeTable, rowKeyOf, tableKey } from './edits'
import { RECENT_LIMIT, refKey } from './recency'
import { downloadText } from './dom'
import { csv, describeCopy, rectOf, selectionText, type CellPos, type Selection } from './selection'
import { startFlushing } from './perf'
import {
  INITIAL_EDIT_STATE,
  createEditSlice,
  forgetTable,
  guardUnload,
  withStaged,
  type EditActions,
  type EditState,
} from './storeEdits'
import { mark, reportText } from './startup'
import { applyTheme, DEFAULT_THEME } from './themes'
import {
  blankFields,
  closeOpen,
  findOpen,
  FRESH_CONTROLS,
  neighbourOf,
  newTab as makeTab,
  pageOf,
  recordPage,
  samePage,
  sameRef,
  snapshot,
  type Controls,
  type OpenTable,
  type Page,
  type Tab,
  type TabFields,
  upsertOpen,
} from './tabs'
import type {
  ActivityResult,
  Capabilities,
  Cell,
  Connection,
  CreateTableSpec,
  Cursor,
  GridColumn,
  Kind,
  ObjectDetail,
  ObjectRef,
  ObjectType,
  ResultSet,
  SchemaObject,
  SecretBackend,
  Settings,
  Sort,
} from './types'
import { isPasswordRequired, needsPasswordPrompt } from './secrets'

export const PAGE_SIZES = [50, 100, 200, 500, 1000] as const

/** Root font size bounds, one step per press. `config.Settings.clamp` on the Go side enforces the same range. */
export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 28
export const FONT_SIZE_DEFAULT = 16

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
  /**
   * The row's key values, when the table has a key. Finds the row exactly,
   * where the offset finds whatever is at that position now.
   */
  key: Record<string, Cell> | null
}

export type DialogState =
  | { kind: 'none' }
  | { kind: 'connection'; connection: Connection | null }
  | { kind: 'shortcuts' }
  /** Asks for an ask-every-time connection's password. `error` is why the last try failed. */
  | { kind: 'password'; connection: Connection; database: string; error?: string }
  | { kind: 'settings' }
  | { kind: 'confirmDelete'; connection: Connection }
  | { kind: 'confirmResetSample' }
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

export const DEFAULT_SETTINGS: Settings = {
  theme: DEFAULT_THEME,
  fontSizePx: FONT_SIZE_DEFAULT,
  defaultPageSize: 100,
  paginationEnabled: true,
  rowCap: 100_000,
  textCapChars: 1024,
  showSystemObjects: false,
  autoCount: true,
  confirmDestructive: true,
  sidebarWidthPx: 256,
  trayHeightPx: 260,
  sqlEditorHeightPx: 160,
  tabStripHidden: false,
  drawerDurationMs: 260,
  infiniteScroll: false,
}

export interface State extends EditState, EditActions {
  // catalogue
  drivers: Record<Kind, Capabilities> | null
  connections: Connection[]
  connectedIds: string[]

  /**
   * Open tabs, and which one the fields below belong to. See `tabs.ts`: the
   * fields below are the active tab's live state, and every other tab holds a
   * saved copy of the same set.
   */
  tabs: Tab[]
  activeTabId: number
  /**
   * Every page the main panel has shown, oldest first, and where the user is in
   * that list. Written only by the subscription at the bottom of this file.
   */
  nav: Page[]
  navAt: number

  // active connection
  activeConnectionId: string | null
  capabilities: Capabilities | null
  databases: string[]
  activeDatabase: string
  objects: SchemaObject[]

  // active object
  activeRef: ObjectRef | null
  /** The tables opened in this tab, each with how it was left (`tabs.ts`). */
  openTables: OpenTable[]
  /**
   * Objects opened this session, most recent first, as refKey strings.
   *
   * Tabs hold what is open, but Ctrl+P is still how a table gets opened, and
   * the palette is only as good as its ordering. Alphabetical is useless for
   * that: the two tables being compared are rarely neighbours in the alphabet.
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
  /**
   * Where the page below the rows on screen starts, when the sort can be read by
   * position. Infinite scroll asks for it so rows added above cannot repeat; null
   * means page by offset.
   */
  nextCursor: Cursor | null
  totalCount: number | null

  // sql editor
  sqlText: string
  /**
   * Whether the editor holds a runnable selection. A boolean on purpose: the
   * selection itself is read from the editor when Run fires, so typing and
   * caret moves never touch the store — only this flag's rare flips do.
   */
  sqlHasSelection: boolean
  /**
   * The isolation level the editor runs at: one of the dialect's
   * Capabilities.isolationLevels, or '' for the driver default. Tab state, and
   * not persisted across restarts, so a level chosen once cannot silently wrap
   * tomorrow's session in transactions.
   */
  sqlIsolation: string
  /**
   * Every editor run kept for this tab, oldest first, within the limits in
   * sqlHistory.ts. In memory only: results can be sensitive, so this is never
   * persisted and a closed tab's runs are not kept for Reopen.
   */
  sqlRuns: SqlRunEntry[]
  /** Id of the run on screen; null until something has been run. */
  sqlActiveRun: number | null
  /**
   * Which of the active run's result sets is showing. A batch is one round
   * trip that can answer several times over — `use other_db; select …` — and
   * the editor puts a second row of tabs on them.
   */
  sqlResultIndex: number

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
  settings: Settings
  secretBackend: SecretBackend | null
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
  /**
   * The editor run in flight, if any. Not tab state: a run carries on when the
   * user moves to another tab, and Cancel must still reach the connection and
   * database it was started against. `cancelled` is set once the user has
   * asked, so the failure that follows reads as a choice rather than an error.
   */
  sqlRun: SqlRun | null
  toasts: Toast[]

  // actions
  init: () => Promise<void>
  refreshConnections: () => Promise<void>
  /**
   * An ask-every-time connection that is not open opens the password dialog
   * instead, which calls back here with what was typed. The password is passed
   * on and not kept.
   */
  connect: (id: string, password?: string | null, database?: string) => Promise<void>
  disconnect: (id: string) => Promise<void>
  /** Saves the sample database's connection if missing, then connects to it. */
  openSample: () => Promise<void>
  /** Rebuilds the sample database, then reconnects. Call after the user confirmed. */
  resetSample: () => Promise<void>
  selectDatabase: (name: string) => Promise<void>
  openObject: (o: SchemaObject) => Promise<void>
  /**
   * Closes one of the tab's open tables, the one on screen by default, and
   * shows its neighbour. Asks first when the table has staged edits.
   */
  closeOpenTable: (ref?: ObjectRef) => Promise<void>
  reload: () => Promise<void>
  /** Infinite scroll: appends the next page below the rows on screen. */
  loadMore: () => Promise<void>
  /** Opens a blank tab (the picker) and switches to it. */
  newTab: () => void
  /** Closes a tab, the active one by default. Closing the last leaves a blank one. */
  closeTab: (id?: number) => void
  /** Brings back the most recently closed tab, as a new tab. */
  reopenTab: () => void
  switchTab: (id: number) => void
  /** Moves to the next (+1) or previous (-1) tab, wrapping. */
  cycleTab: (delta: number) => void
  /** Jumps straight to entry `at` of the page record, as a run of back / forward steps would. */
  goToVisit: (at: number) => Promise<void>
  /** Mouse back / forward: walks the pages the main panel has shown, across tabs. */
  stepHistory: (delta: number) => Promise<void>
  setTabStrip: (open: boolean) => Promise<void>
  /** Shows the picker in the current tab, keeping the connection and database chosen. */
  showPicker: () => void
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

  loadSettings: () => Promise<void>
  saveSettings: (s: Settings) => Promise<void>
  /** Steps the root font size by `delta` px, stopping at the bounds. */
  adjustFontSize: (delta: number) => Promise<void>
  resetFontSize: () => Promise<void>
  refreshActivity: () => Promise<void>
  cancelQuery: (id: string) => Promise<void>
  /** Stops the editor run in flight. */
  cancelSql: () => Promise<void>
  /** Stops everything running on the connection the editor run is using. */
  cancelConnectionSql: () => Promise<void>
  clearQueryHistory: () => Promise<void>
  setTrayOpen: (open: boolean) => void
  setSqlText: (t: string) => void
  setSqlHasSelection: (has: boolean) => void
  setSqlIsolation: (level: string) => void
  /** Runs `text` when given — the trimmed selection — else the whole buffer. */
  runSql: (text?: string) => Promise<void>
  /** Switches result tabs within the active run. The selection goes with the old one. */
  selectSqlResult: (index: number) => void
  /** Shows another kept run. */
  selectSqlRun: (id: number) => void
  /** Previous (-1) or next (1) kept run, wrapping. */
  stepSqlRun: (delta: number) => void
  /** Closes a run (the active one by default). */
  closeSqlRun: (id?: number) => void
  /** Pins or unpins a run (the active one by default); a pinned run is never evicted. */
  toggleSqlRunPin: (id?: number) => void
  /** Drops every unpinned run. */
  clearSqlRuns: () => void
  /** Puts a run's SQL back in the editor (the active run by default). */
  restoreSqlRunText: (id?: number) => void
  saveConnection: (c: Connection, password: string | null) => Promise<void>
  deleteConnection: (id: string) => Promise<void>
  /** Removes a saved connection, asking first unless confirmations are off. */
  removeConnection: (c: Connection) => void
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
 * Whether the browse grid grows downwards as it scrolls rather than turning
 * pages. Needs pagination: it is the page size that sets how much each step
 * loads, and with pagination off everything is already loaded.
 */
export function isInfinite(s: { settings: Settings; paginationEnabled: boolean }): boolean {
  return s.settings.infiniteScroll && s.paginationEnabled
}

/**
 * Responses are matched against this counter before being applied. Paging
 * quickly, or retyping a filter, can leave an earlier request in flight;
 * without the guard a slow first response would overwrite a newer one and the
 * grid would show rows that do not match what the controls say.
 */
let requestSeq = 0
let toastSeq = 0
let tabSeq = 1
/** Closed tabs, newest last, for Ctrl+Shift+T. Not state: nothing renders it. */
let closedTabs: TabFields[] = []
const CLOSED_TABS_LIMIT = 10

/** A tab with nothing opened in it is not worth bringing back. */
function worthReopening(f: TabFields): boolean {
  return f.openTables.length > 0 || !!f.sqlText || f.view !== 'data'
}

function controlsOf(s: Pick<State, 'filter' | 'orderBy' | 'sortChosen' | 'page'>): Controls {
  return { filter: s.filter, orderBy: s.orderBy, sortChosen: s.sortChosen, page: s.page }
}

/** The table-shaped fields of a tab with nothing open: what the picker shows over. */
const NO_TABLE = {
  activeRef: null,
  columns: [],
  result: null,
  orderBy: [],
  sortChosen: false,
  filter: '',
  page: 1,
  hasMore: false,
  nextCursor: null,
  totalCount: null,
  detail: null,
  detailLoading: false,
  detailError: null,
  selection: null,
  view: 'data',
  editKey: [],
  readOnlyReason: '',
} satisfies Partial<State>
/**
 * True while a back / forward step is moving the panel. The subscription that
 * records pages ignores those moves, or going back would write a new page.
 */
let navigating = false

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

  /**
   * Fetches the current page and, separately, the total count.
   *
   * With infinite scroll, `page` counts the pages loaded so far and the rows are
   * all of them: a read starts again from the top and asks for every page at
   * once, so a refresh keeps what was on screen, and `append` asks for just the
   * next one and adds it below.
   */
  async function fetchRows(append = false) {
    const s = get()
    if (!s.activeConnectionId || !s.activeRef) return

    const seq = ++requestSeq
    const { activeConnectionId, activeRef, filter, orderBy, sortChosen } = s
    const infinite = isInfinite(s)
    const rowCap = s.settings.rowCap
    // Appending below the last row asks for the rows after it, not for "page N":
    // a row inserted above since the last page was read would shift every page
    // and repeat one. Where the sort cannot be read by position, the offset it is.
    const byPosition = infinite && append && s.nextCursor !== null
    const pagination = !infinite
      ? { enabled: s.paginationEnabled, page: s.page, pageSize: s.pageSize }
      : append
        ? { enabled: true, page: byPosition ? 1 : s.page + 1, pageSize: s.pageSize }
        : { enabled: true, page: 1, pageSize: Math.min(s.pageSize * s.page, rowCap) }
    set({ busy: true })

    try {
      const res = await tracked(() =>
        api.readRows({
          connectionId: activeConnectionId,
          ref: activeRef,
          filter,
          orderBy,
          applyDefaultSort: !sortChosen,
          pagination,
          ...(byPosition && s.nextCursor ? { after: s.nextCursor } : {}),
        }),
      )
      if (seq !== requestSeq) return
      const prev = get().result
      if (append && infinite && prev) {
        const rows = [...prev.rows, ...res.result.rows]
        set({
          result: {
            ...prev,
            rows,
            truncated: res.result.truncated,
            elapsedMs: res.result.elapsedMs,
            truncatedCells: [
              ...prev.truncatedCells,
              ...res.result.truncatedCells.map((c) => ({ ...c, row: c.row + prev.rows.length })),
            ],
          },
          page: s.page + 1,
          nextCursor: res.next ?? null,
          // Stops at the row cap: past it the next read would be refused anyway.
          hasMore: res.hasMore && rows.length < rowCap,
          busy: false,
        })
        // The total has not changed, so it is not asked for again.
        return
      }
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
        nextCursor: res.next ?? null,
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

  const blank = () => blankFields(get().settings.defaultPageSize, get().settings.paginationEnabled)

  /** The tab list with the live fields written into the active tab. */
  function stashed(): Tab[] {
    const s = get()
    return s.tabs.map((t) =>
      t.id === s.activeTabId ? { ...t, saved: snapshot(s), needsLoad: s.busy } : t,
    )
  }

  /** Makes `tab` the active one, writing its saved fields over the live ones. */
  function enter(tab: Tab, tabs: Tab[]) {
    // A response still on its way was asked for by the tab being left.
    requestSeq++
    set({
      ...(tab.saved ?? blank()),
      tabs: tabs.map((t) => (t.id === tab.id ? { ...t, saved: null, needsLoad: false } : t)),
      activeTabId: tab.id,
      busy: false,
      editing: null,
    })
    if (tab.needsLoad && tab.saved?.activeRef) void fetchRows()
  }

  /** Points the active tab at a table; `restore` brings back how it was filtered, sorted and paged. */
  async function openObjectAt(o: SchemaObject, restore?: Controls) {
    const s = get()
    if (!s.activeConnectionId) return
    // Functions and procedures have no rows to browse. Selecting one in the
    // palette should not blank the grid.
    if (o.type === 'function' || o.type === 'procedure') {
      s.pushToast('info', `${o.name} is a ${o.type} — open the SQL editor to call it`)
      return
    }
    const ref = { database: s.activeDatabase, schema: o.schema, name: o.name }
    const key = refKey(ref.database, ref.schema, ref.name)
    // The table being left keeps how it was filtered, sorted and paged, and the
    // one being opened gets back what it had — unless the caller says otherwise.
    const left =
      s.activeRef && findOpen(s.openTables, s.activeRef)
        ? upsertOpen(s.openTables, s.activeRef, controlsOf(s))
        : s.openTables
    const controls = restore ?? findOpen(left, ref)?.controls ?? FRESH_CONTROLS
    set({
      activeRef: ref,
      openTables: upsertOpen(left, ref, controls),
      // Moved to the front, and de-duplicated, so re-opening a table does not
      // leave a stale copy further down the list.
      recentObjects: [key, ...s.recentObjects.filter((k) => k !== key)].slice(0, RECENT_LIMIT),
      // Never the previous table's controls: a filter written for one table is
      // almost always a syntax error on another.
      ...controls,
      totalCount: null,
      result: null,
      view: 'data',
    })
    await fetchRows()
  }

  /** The loaded object behind `ref`, or a stand-in when the list does not have it. */
  function objectFor(ref: ObjectRef): SchemaObject {
    const { name, schema } = ref
    return get().objects.find((o) => o.name === name && o.schema === schema) ?? { schema, name, type: 'table' }
  }

  /** Shows `p`: switches to its tab, then does whatever its page needs. */
  async function goToPage(p: Page) {
    navigating = true
    try {
      if (p.tabId !== get().activeTabId) get().switchTab(p.tabId)
      if (samePage(pageOf(get()), p)) return
      const tabId = p.tabId
      switch (p.kind) {
        case 'picker':
          set(NO_TABLE)
          return
        case 'sql':
        case 'activity':
          set({ view: p.kind })
          return
        case 'details':
          if (p.ref) await get().openDetails(p.ref)
          return
        case 'table': {
          if (!p.ref || !p.connectionId) return
          if (get().activeConnectionId !== p.connectionId) await get().connect(p.connectionId)
          if (get().activeTabId !== tabId || get().activeConnectionId !== p.connectionId) return
          if (get().activeDatabase !== p.ref.database) await get().selectDatabase(p.ref.database)
          if (get().activeTabId !== tabId) return
          await openObjectAt(objectFor(p.ref), p.controls ?? undefined)
          return
        }
      }
    } finally {
      navigating = false
    }
  }

  return {
    ...INITIAL_EDIT_STATE,
    ...edits.actions,
    drivers: null,
    connections: [],
    connectedIds: [],
    tabs: [makeTab(1, null)],
    activeTabId: 1,
    nav: [],
    navAt: -1,
    activeConnectionId: null,
    capabilities: null,
    databases: [],
    activeDatabase: '',
    objects: [],
    activeRef: null,
    openTables: [],
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
    nextCursor: null,
    totalCount: null,
    sqlText: '',
    sqlHasSelection: false,
    sqlIsolation: '',
    sqlRuns: [],
    sqlActiveRun: null,
    sqlResultIndex: 0,
    detail: null,
    detailLoading: false,
    detailError: null,
    selection: null,
    view: 'data',
    transposed: false,
    secretBackend: null,
    settings: DEFAULT_SETTINGS,
    activity: { queries: [], sessions: [] },
    activityPolledAt: 0,
    inFlight: 0,
    trayOpen: false,
    palette: null,
    dialog: { kind: 'none' },
    busy: false,
    sqlRun: null,
    toasts: [],

    async init() {
      guardUnload(get)
      try {
        const [drivers, connections, connectedIds, settings, secretBackend] = await Promise.all([
          api.drivers(),
          api.listConnections(),
          api.connectedIds(),
          api.getSettings(),
          // Never worth blocking startup on: no answer just means no banner.
          api.secretBackend().catch(() => null),
        ])
        set({
          secretBackend,
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

    async openSample() {
      try {
        const conn = await api.openSample()
        await get().refreshConnections()
        await get().connect(conn.id)
        get().setView('data')
      } catch (e) {
        get().pushToast('error', errorMessage(e))
      }
    },

    async resetSample() {
      set({ dialog: { kind: 'none' } })
      try {
        const conn = await api.resetSample()
        await get().refreshConnections()
        set({ connectedIds: get().connectedIds.filter((id) => id !== conn.id) })
        await get().connect(conn.id)
        get().setView('data')
        get().pushToast('info', 'Sample database reset')
      } catch (e) {
        get().pushToast('error', errorMessage(e))
      }
    },

    async connect(id, password = null, database = '') {
      const conn = get().connections.find((c) => c.id === id)
      if (needsPasswordPrompt(conn, get().connectedIds.includes(id), password)) {
        set({ dialog: { kind: 'password', connection: conn!, database } })
        return
      }
      const tabId = get().activeTabId
      set({ busy: true })
      try {
        const res = await tracked(() => api.connect(id, password, database))
        const databases = res.databases.map((d) => d.name)
        const active = res.defaultDatabase || databases[0] || ''
        const connectedIds = Array.from(new Set([...get().connectedIds, id]))
        // The user moved to another tab while this was connecting: the
        // connection is open, but the tab they are looking at is not its to change.
        if (get().activeTabId !== tabId) {
          set({ connectedIds })
          return
        }
        set({
          activeConnectionId: id,
          capabilities: res.capabilities,
          databases,
          activeDatabase: active,
          connectedIds,
          objects: [],
          activeRef: null,
          openTables: [],
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
        // A typed password that did not work: ask again, with the reason, rather
        // than making the user find the connection again.
        if (conn?.askPassword && password !== null) {
          set({ dialog: { kind: 'password', connection: conn, database, error: errorMessage(e) } })
          return
        }
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
        // Other tabs on this connection have nothing left to show.
        tabs: get().tabs.map((t) =>
          t.saved?.activeConnectionId === id ? { ...t, saved: blank(), needsLoad: false } : t,
        ),
        ...(stillActive
          ? {
              activeConnectionId: null,
              capabilities: null,
              databases: [],
              activeDatabase: '',
              objects: [],
              activeRef: null,
              openTables: [],
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
      const tabId = get().activeTabId
      // Open tables belong to the database they were opened in.
      const openTables = name === get().activeDatabase ? get().openTables : []
      set({ activeDatabase: name, openTables, busy: true, objects: [] })
      try {
        const objects = await tracked(() => api.listObjects(id, name))
        if (get().activeTabId !== tabId) return
        set({ objects, busy: false })
      } catch (e) {
        set({ busy: false })
        // Each database of an ask-every-time connection is its own session.
        const conn = get().connections.find((c) => c.id === id)
        if (conn && isPasswordRequired(errorMessage(e))) {
          set({ dialog: { kind: 'password', connection: conn, database: name } })
          return
        }
        get().pushToast('error', errorMessage(e))
      }
    },

    async openObject(o) {
      await openObjectAt(o)
    },

    async closeOpenTable(ref) {
      const s = get()
      const target = ref ?? s.activeRef
      if (!target || !findOpen(s.openTables, target)) return
      if (s.activeConnectionId) {
        const key = tableKey(s.activeConnectionId, target)
        const count = countOf(editsFor(s.staged, key)).total
        if (count > 0) {
          set({
            dialog: {
              kind: 'confirmDiscard',
              count,
              proceed: () => {
                set({ ...withStaged(get(), removeTable(get().staged, key)), editing: null })
                return get().closeOpenTable(target)
              },
            },
          })
          return
        }
      }
      const next = neighbourOf(s.openTables, target)
      const openTables = closeOpen(s.openTables, target)
      if (!sameRef(s.activeRef, target)) {
        set({ openTables })
        return
      }
      if (!next) {
        set({ ...NO_TABLE, openTables })
        return
      }
      set({ openTables })
      await openObjectAt(objectFor(next.ref), next.controls)
    },

    newTab() {
      const tab = makeTab(++tabSeq, blank())
      enter(tab, [...stashed(), tab])
    },

    switchTab(id) {
      if (id === get().activeTabId) return
      const tabs = stashed()
      const target = tabs.find((t) => t.id === id)
      if (target) enter(target, tabs)
    },

    cycleTab(delta) {
      const { tabs, activeTabId } = get()
      if (tabs.length < 2) return
      const i = tabs.findIndex((t) => t.id === activeTabId)
      get().switchTab(tabs[(i + delta + tabs.length) % tabs.length].id)
    },

    closeTab(id) {
      const s = get()
      const target = id ?? s.activeTabId
      const at = s.tabs.findIndex((t) => t.id === target)
      if (at < 0) return
      const closing = stashed()[at].saved
      if (closing && worthReopening(closing)) {
        // Reopen brings back the editor text, not the results: they may be sensitive.
        const forgotten = { ...closing, sqlRuns: [], sqlActiveRun: null, sqlResultIndex: 0 }
        closedTabs = [...closedTabs, forgotten].slice(-CLOSED_TABS_LIMIT)
      }
      if (s.tabs.length === 1) {
        const fresh = makeTab(++tabSeq, blank())
        enter(fresh, [fresh])
        return
      }
      const rest = s.tabs.filter((t) => t.id !== target)
      if (target !== s.activeTabId) {
        set({ tabs: rest })
        return
      }
      // The tab being closed is dropped, not stashed.
      enter(rest[Math.min(at, rest.length - 1)], rest)
    },

    reopenTab() {
      const saved = closedTabs.pop()
      if (!saved) return
      const tab = { ...makeTab(++tabSeq, saved), needsLoad: !!saved.activeRef }
      enter(tab, [...stashed(), tab])
    },

    showPicker() {
      set(NO_TABLE)
    },

    async setTabStrip(open) {
      const { settings, saveSettings } = get()
      if (settings.tabStripHidden === !open) return
      await saveSettings({ ...settings, tabStripHidden: !open })
    },

    async stepHistory(delta) {
      const s = get()
      let i = s.navAt + delta
      // Pages of tabs that have since been closed are skipped.
      while (s.nav[i] && !s.tabs.some((t) => t.id === s.nav[i].tabId)) i += delta
      await get().goToVisit(i)
    },

    async goToVisit(at) {
      const s = get()
      if (at < 0 || at >= s.nav.length) return
      // The page being left is refreshed first, so coming back finds its
      // filter, sort and page as they were.
      const nav = s.nav.map((p, j) => (j === s.navAt ? pageOf(s) : p))
      set({ nav, navAt: at })
      await goToPage(nav[at])
    },

    async reload() {
      await fetchRows()
    },

    async loadMore() {
      const s = get()
      if (!isInfinite(s) || !s.hasMore || s.busy || !s.activeRef || s.view !== 'data') return
      await fetchRows(true)
    },

    setFilter(filter) {
      set({ filter })
    },

    async applyFilter(filter) {
      set({ filter, page: 1, totalCount: null })
      await fetchRows()
    },

    async setPage(p) {
      // Pages do not turn when they all stack in one scroll.
      if (isInfinite(get())) return
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
      const tabId = get().activeTabId
      set({ view: 'details', detailLoading: true, detailError: null, detail: null })
      try {
        const detail = await api.describeObject(connID, ref)
        if (get().activeTabId !== tabId) return
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
      // The row count in the picker is now wrong, and so is the grid if this is
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
      if (sameRef(get().activeRef, ref)) set(NO_TABLE)
      // Another tab may have it open, or be showing it.
      set({
        openTables: closeOpen(get().openTables, ref),
        tabs: get().tabs.map((t) => {
          if (t.saved?.activeConnectionId !== connectionId) return t
          const saved = { ...t.saved, openTables: closeOpen(t.saved.openTables, ref) }
          if (!sameRef(t.saved.activeRef, ref)) return { ...t, saved }
          return { ...t, saved: { ...saved, ...NO_TABLE }, needsLoad: false }
        }),
      })
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

    async adjustFontSize(delta) {
      const { settings, saveSettings } = get()
      const fontSizePx = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, settings.fontSizePx + delta))
      if (fontSizePx !== settings.fontSizePx) await saveSettings({ ...settings, fontSizePx })
    },

    async resetFontSize() {
      const { settings, saveSettings } = get()
      if (settings.fontSizePx !== FONT_SIZE_DEFAULT) {
        await saveSettings({ ...settings, fontSizePx: FONT_SIZE_DEFAULT })
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

    async cancelSql() {
      const run = get().sqlRun
      if (!run || run.cancelled) return
      set({ sqlRun: markCancelled(run) })
      try {
        await api.cancelSql(run.connectionId, run.database)
        await get().refreshActivity()
      } catch (e) {
        get().pushToast('error', errorMessage(e))
      }
    },

    async cancelConnectionSql() {
      const run = get().sqlRun
      const connectionId = run?.connectionId ?? get().activeConnectionId
      if (!connectionId) return
      if (run) set({ sqlRun: markCancelled(run) })
      try {
        await api.cancelConnectionQueries(connectionId)
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

    setSqlIsolation(level) {
      set({ sqlIsolation: effectiveIsolation(get().capabilities?.isolationLevels, level) })
    },

    setSqlHasSelection(sqlHasSelection) {
      if (get().sqlHasSelection !== sqlHasSelection) set({ sqlHasSelection })
    },

    async runSql(text) {
      const s = get()
      if (!s.activeConnectionId) {
        s.pushToast('error', 'Connect to a database first')
        return
      }
      const sql = text ?? s.sqlText
      if (!sql.trim()) return
      const connectionId = s.activeConnectionId
      const token = ++sqlRunSeq
      const startedAt = Date.now()
      const connName = s.connections.find((c) => c.id === connectionId)?.name ?? connectionId
      const target = s.activeDatabase ? `${connName} / ${s.activeDatabase}` : connName
      const record = (outcome: Pick<SqlRunEntry, 'results' | 'moreResults' | 'error'>) => {
        const h = get()
        const added = addRun(
          { runs: h.sqlRuns, activeId: h.sqlActiveRun },
          {
            id: nextRunId({ runs: h.sqlRuns, activeId: h.sqlActiveRun }),
            sql,
            at: startedAt,
            durationMs: Date.now() - startedAt,
            target,
            pinned: false,
            ...outcome,
          },
        )
        return { sqlRuns: added.runs, sqlActiveRun: added.activeId, sqlResultIndex: 0 }
      }
      set({
        busy: true,
        sqlRun: startRun(token, connectionId, s.activeDatabase),
      })
      try {
        const res = await tracked(() =>
          api.runSql({
            connectionId,
            database: s.activeDatabase,
            sql,
            maxRows: 0,
            isolation: effectiveIsolation(s.capabilities?.isolationLevels, s.sqlIsolation),
          }),
        )
        set({
          ...record({ results: res.results, moreResults: res.moreResults }),
          // The old result's selection means nothing against the new one.
          selection: s.selection?.source === 'sql' ? null : s.selection,
          busy: false,
          sqlRun: endRun(get().sqlRun, token),
        })
        // Only a statement with nothing to show says how many rows it moved.
        // With a grid on screen the row count is already in front of the user.
        const only = res.results.length === 1 ? res.results[0] : null
        if (only && only.rowsAffected != null) {
          s.pushToast('info', `${only.rowsAffected} row(s) affected in ${only.elapsedMs}ms`)
        }
      } catch (e) {
        const cancelled = wasCancelled(get().sqlRun, token)
        set({
          ...record({
            results: [],
            moreResults: false,
            error: cancelled ? 'Query cancelled' : errorMessage(e),
          }),
          selection: get().selection?.source === 'sql' ? null : get().selection,
          busy: false,
          sqlRun: endRun(get().sqlRun, token),
        })
        if (cancelled) get().pushToast('info', 'Query cancelled')
        else get().pushToast('error', errorMessage(e))
      }
    },

    selectSqlResult(index) {
      const s = get()
      const n = activeRun(history(s))?.results.length ?? 0
      if (index < 0 || index >= n || index === s.sqlResultIndex) return
      set({
        sqlResultIndex: index,
        selection: s.selection?.source === 'sql' ? null : s.selection,
      })
    },

    selectSqlRun(id) {
      const s = get()
      if (id === s.sqlActiveRun) return
      set(historyPatch(s, selectRun(history(s), id)))
    },

    stepSqlRun(delta) {
      const id = stepTarget(history(get()), delta)
      if (id !== null) get().selectSqlRun(id)
    },

    closeSqlRun(id) {
      const s = get()
      const target = id ?? s.sqlActiveRun
      if (target !== null) set(historyPatch(s, closeRun(history(s), target)))
    },

    toggleSqlRunPin(id) {
      const s = get()
      const target = id ?? s.sqlActiveRun
      if (target !== null) set(historyPatch(s, togglePin(history(s), target)))
    },

    clearSqlRuns() {
      const s = get()
      set(historyPatch(s, clearUnpinned(history(s))))
    },

    restoreSqlRunText(id) {
      const s = get()
      const run = history(s).runs.find((r) => r.id === (id ?? s.sqlActiveRun))
      if (run) set({ sqlText: run.sql })
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

    removeConnection(c) {
      if (get().settings.confirmDestructive) set({ dialog: { kind: 'confirmDelete', connection: c } })
      else void get().deleteConnection(c.id)
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
                // With infinite scroll the rows are all of them from the top,
                // so the index is already absolute and `page` is a count.
                enabled: s.paginationEnabled && !isInfinite(s),
                page: s.page,
                pageSize: s.pageSize,
              })
            : null,
        key: source === 'browse' ? rowKeyOf(rs, rowIndex, s.editKey) : null,
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
            ...(cell.key ? { key: cell.key } : {}),
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
      // browse page. Same CSV writer the clipboard uses, except that the file is
      // opened in a spreadsheet and so has formulas defused (audit B5).
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
          true,
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
let sqlRunSeq = 0

function history(s: State): SqlHistory {
  return { runs: s.sqlRuns, activeId: s.sqlActiveRun }
}

/**
 * The state change for a new history. Moving to another run drops the grid
 * selection and goes back to its first result set; closing or pinning another
 * run leaves what is on screen alone.
 */
function historyPatch(s: State, h: SqlHistory): Partial<State> {
  if (h.activeId === s.sqlActiveRun) return { sqlRuns: h.runs }
  return {
    sqlRuns: h.runs,
    sqlActiveRun: h.activeId,
    sqlResultIndex: 0,
    selection: s.selection?.source === 'sql' ? null : s.selection,
  }
}

export function activeSqlResult(s: State): ResultSet | null {
  return s.sqlRuns.find((r) => r.id === s.sqlActiveRun)?.results[s.sqlResultIndex] ?? null
}

/** Whether the active dialect has schemas, so names are worth qualifying. */
export function useHasSchemas(): boolean {
  const kind = useActiveKind()
  return useStore((s) => (kind ? (s.drivers?.[kind]?.hasSchemas ?? false) : false))
}

// Every change of page is recorded, whatever caused it: a click in the strip, a
// table opened from the palette, the SQL editor toggled. Done here rather than
// at those call sites so a new way of reaching a page is recorded for free.
useStore.subscribe((s, prev) => {
  if (navigating) return
  const now = pageOf(s)
  const before = pageOf(prev)
  if (samePage(now, before)) return
  const { nav, at } = recordPage(s.nav, s.navAt, before, now)
  useStore.setState({ nav, navAt: at })
})

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
  document.documentElement.style.setProperty('--drawer-duration', `${s.drawerDurationMs}ms`)
  applyTheme(s.theme)
}
