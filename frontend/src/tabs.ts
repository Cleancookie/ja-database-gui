/**
 * Tabs.
 *
 * The store keeps one flat set of "active" fields — the table on screen, its
 * rows, filter, sort, page, the SQL editor, the connection it came from — and
 * nearly every component reads them directly. A tab is a saved copy of exactly
 * that set. Switching tabs stashes the live fields into the tab being left and
 * writes the other tab's back, so no component needs to know tabs exist.
 *
 * What is *not* in the set is global on purpose: staged edits (they span
 * tables, and so tabs), the recent list, settings, the activity tray, dialogs.
 *
 * The active tab's `saved` is stale — the flat fields are the truth for it.
 */

import { refKey } from './recency'
import type { ObjectRef, Sort } from './types'
import type { State } from './store'

export const TAB_FIELDS = [
  'activeConnectionId',
  'capabilities',
  'databases',
  'activeDatabase',
  'objects',
  'activeRef',
  'openTables',
  'columns',
  'result',
  'orderBy',
  'sortChosen',
  'filter',
  'paginationEnabled',
  'page',
  'pageSize',
  'hasMore',
  'nextCursor',
  'totalCount',
  'sqlText',
  'sqlHasSelection',
  'sqlIsolation',
  'sqlRuns',
  'sqlActiveRun',
  'sqlResultIndex',
  'detail',
  'detailLoading',
  'detailError',
  'selection',
  'view',
  'editKey',
  'readOnlyReason',
] as const

export type TabFields = Pick<State, (typeof TAB_FIELDS)[number]>

export interface Tab {
  id: number
  /** The fields as they were when the tab was left; null for the active tab. */
  saved: TabFields | null
  /** A request was still in flight when the tab was left, so its rows are missing. */
  needsLoad: boolean
}

export function snapshot(s: State): TabFields {
  const out: Record<string, unknown> = {}
  for (const k of TAB_FIELDS) out[k] = s[k]
  return out as unknown as TabFields
}

/** A tab that has not been pointed at anything: the picker. */
export function blankFields(pageSize: number, paginationEnabled: boolean): TabFields {
  return {
    activeConnectionId: null,
    capabilities: null,
    databases: [],
    activeDatabase: '',
    objects: [],
    activeRef: null,
    openTables: [],
    columns: [],
    result: null,
    orderBy: [],
    sortChosen: false,
    filter: '',
    paginationEnabled,
    page: 1,
    pageSize,
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
    editKey: [],
    readOnlyReason: '',
  }
}

export function newTab(id: number, fields: TabFields | null): Tab {
  return { id, saved: fields, needsLoad: false }
}

/**
 * Open tables.
 *
 * A tab is one connection and one database, and the tables opened in it are
 * kept as a list, each with the filter, sort and page it had when it was left.
 * Rows are never kept: going back to a table fetches them again.
 *
 * `activeRef` is the table on screen. Its entry's controls are stale while it
 * is — the live fields are the truth, as with the active tab's `saved`.
 */
export interface OpenTable {
  ref: ObjectRef
  controls: Controls
}

export const FRESH_CONTROLS: Controls = { filter: '', orderBy: [], sortChosen: false, page: 1 }

export function sameRef(a: ObjectRef | null | undefined, b: ObjectRef): boolean {
  return !!a && a.database === b.database && a.schema === b.schema && a.name === b.name
}

export function findOpen(list: OpenTable[], ref: ObjectRef): OpenTable | undefined {
  return list.find((t) => sameRef(t.ref, ref))
}

/** Puts `ref` in the list with `controls`, in place if it is already there, else at the end. */
export function upsertOpen(list: OpenTable[], ref: ObjectRef, controls: Controls): OpenTable[] {
  const at = list.findIndex((t) => sameRef(t.ref, ref))
  if (at < 0) return [...list, { ref, controls }]
  const out = list.slice()
  out[at] = { ref: list[at].ref, controls }
  return out
}

export function closeOpen(list: OpenTable[], ref: ObjectRef): OpenTable[] {
  return list.filter((t) => !sameRef(t.ref, ref))
}

/** What takes the place of `ref` when it closes: the next one along, else the one before. */
export function neighbourOf(list: OpenTable[], ref: ObjectRef): OpenTable | null {
  const at = list.findIndex((t) => sameRef(t.ref, ref))
  if (at < 0) return null
  return list[at + 1] ?? list[at - 1] ?? null
}

/** The open tables as `refKey`s, for marking them in a list of every object. */
export function openTableKeys(list: OpenTable[]): Set<string> {
  return new Set(list.map((t) => refKey(t.ref.database, t.ref.schema, t.ref.name)))
}

/** What the strip calls a tab. Takes only the fields it needs so it can be fed from either copy. */
export function tabTitle(f: Pick<TabFields, 'view' | 'activeRef' | 'activeDatabase'>): string {
  if (f.view === 'sql') return f.activeDatabase ? `SQL · ${f.activeDatabase}` : 'SQL'
  if (f.view === 'activity') return 'Activity'
  if (f.activeRef) return f.activeRef.name
  return 'New tab'
}

/**
 * Pages.
 *
 * The main panel shows one page at a time — the picker, a table, the SQL
 * editor, a table's details, the activity log — and every change of page is a
 * route: it is recorded, and the mouse back / forward buttons walk the record.
 * Switching to another tab is a route too, since it changes what the panel
 * shows.
 *
 * Nothing is pushed by hand. `store.ts` watches `pageOf` and records whenever it
 * changes, so a new way of reaching a page is recorded without being told to.
 */
export type PageKind = 'picker' | 'table' | 'sql' | 'details' | 'activity'

/** What a table page needs to be shown as it was left. */
export interface Controls {
  filter: string
  orderBy: Sort[]
  sortChosen: boolean
  page: number
}

export interface Page {
  tabId: number
  kind: PageKind
  connectionId: string | null
  ref: ObjectRef | null
  controls: Controls | null
}

type PageSource = Pick<
  State,
  | 'activeTabId'
  | 'view'
  | 'activeRef'
  | 'activeConnectionId'
  | 'filter'
  | 'orderBy'
  | 'sortChosen'
  | 'page'
>

export function pageOf(s: PageSource): Page {
  const kind: PageKind =
    s.view === 'data' ? (s.activeRef ? 'table' : 'picker') : s.view
  const onTable = kind === 'table' || kind === 'details'
  return {
    tabId: s.activeTabId,
    kind,
    connectionId: onTable ? s.activeConnectionId : null,
    ref: onTable ? s.activeRef : null,
    controls:
      kind === 'table'
        ? { filter: s.filter, orderBy: s.orderBy, sortChosen: s.sortChosen, page: s.page }
        : null,
  }
}

/** Same place, ignoring how the table was filtered, sorted or paged. */
export function samePage(a: Page, b: Page): boolean {
  return (
    a.tabId === b.tabId &&
    a.kind === b.kind &&
    a.connectionId === b.connectionId &&
    a.ref?.database === b.ref?.database &&
    a.ref?.schema === b.ref?.schema &&
    a.ref?.name === b.ref?.name
  )
}

/**
 * Records a move from `before` to `now`. Anything ahead of the current entry is
 * dropped, as in a browser; the entry being left is refreshed so it carries the
 * filter, sort and page it had when the user left it.
 */
export function recordPage(
  nav: Page[],
  at: number,
  before: Page,
  now: Page,
): { nav: Page[]; at: number } {
  const kept = nav.slice(0, at + 1)
  if (kept.length > 0) kept[kept.length - 1] = before
  else kept.push(before)
  kept.push(now)
  const trimmed = kept.slice(-NAV_LIMIT)
  return { nav: trimmed, at: trimmed.length - 1 }
}

const NAV_LIMIT = 100

/** One of a tab's earlier pages, with where it sits in the record. */
export interface TabVisit {
  page: Page
  at: number
}

/**
 * Where a tab has been, newest first: its pages up to the current entry, each
 * place once, without the one it is on now. The bare picker is left out — it
 * is a step on the way to somewhere, not a place to go back to.
 */
export function tabHistory(nav: Page[], at: number, tabId: number): TabVisit[] {
  const seen: Page[] = []
  const visits: TabVisit[] = []
  for (let i = Math.min(at, nav.length - 1); i >= 0; i--) {
    const page = nav[i]
    if (page.tabId !== tabId || seen.some((p) => samePage(p, page))) continue
    seen.push(page)
    if (seen.length > 1 && page.kind !== 'picker') visits.push({ page, at: i })
  }
  return visits
}

export function pageTitle(p: Page): string {
  switch (p.kind) {
    case 'table':
      return p.ref?.name ?? 'Table'
    case 'details':
      return `${p.ref?.name ?? 'Table'} · details`
    case 'sql':
      return 'SQL'
    case 'activity':
      return 'Activity'
    case 'picker':
      return 'New tab'
  }
}
