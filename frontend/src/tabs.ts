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

import type { ObjectRef } from './types'
import type { State } from './store'

export const TAB_FIELDS = [
  'activeConnectionId',
  'capabilities',
  'databases',
  'activeDatabase',
  'objects',
  'activeRef',
  'columns',
  'result',
  'orderBy',
  'sortChosen',
  'filter',
  'paginationEnabled',
  'page',
  'pageSize',
  'hasMore',
  'totalCount',
  'sqlText',
  'sqlHasSelection',
  'sqlResults',
  'sqlResultIndex',
  'moreSqlResults',
  'detail',
  'detailLoading',
  'detailError',
  'selection',
  'view',
  'editKey',
  'readOnlyReason',
] as const

export type TabFields = Pick<State, (typeof TAB_FIELDS)[number]>

/** Where a tab has been, for the mouse back and forward buttons. */
export interface HistoryEntry {
  connectionId: string
  ref: ObjectRef
}

export interface Tab {
  id: number
  /** The fields as they were when the tab was left; null for the active tab. */
  saved: TabFields | null
  /** A request was still in flight when the tab was left, so its rows are missing. */
  needsLoad: boolean
  history: HistoryEntry[]
  /** Index into `history` of where this tab is now. */
  at: number
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
    columns: [],
    result: null,
    orderBy: [],
    sortChosen: false,
    filter: '',
    paginationEnabled,
    page: 1,
    pageSize,
    hasMore: false,
    totalCount: null,
    sqlText: '',
    sqlHasSelection: false,
    sqlResults: [],
    sqlResultIndex: 0,
    moreSqlResults: false,
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
  return { id, saved: fields, needsLoad: false, history: [], at: -1 }
}

/** What the strip calls a tab. Takes only the fields it needs so it can be fed from either copy. */
export function tabTitle(f: Pick<TabFields, 'view' | 'activeRef' | 'activeDatabase'>): string {
  if (f.view === 'sql') return f.activeDatabase ? `SQL · ${f.activeDatabase}` : 'SQL'
  if (f.view === 'activity') return 'Activity'
  if (f.activeRef) return f.activeRef.name
  return 'New tab'
}

/** Appends a visit, dropping any forward entries, and skipping a repeat of the current one. */
export function visit(tab: Tab, entry: HistoryEntry): Tab {
  const cur = tab.history[tab.at]
  if (
    cur &&
    cur.connectionId === entry.connectionId &&
    cur.ref.database === entry.ref.database &&
    cur.ref.schema === entry.ref.schema &&
    cur.ref.name === entry.ref.name
  ) {
    return tab
  }
  const history = [...tab.history.slice(0, tab.at + 1), entry].slice(-HISTORY_LIMIT)
  return { ...tab, history, at: history.length - 1 }
}

const HISTORY_LIMIT = 50
