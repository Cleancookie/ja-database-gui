// Typed client for the Go API.
//
// Two transports, one interface. Inside the Wails webview the generated
// bindings hang off window.go; in a browser we POST to the dev server. Nothing
// above this file knows which is in play.
// See docs/adr/0001-go-core-with-two-transports.md.

import { span } from './perf'
import type {
  ActivityResult,
  QuerySqlResult,
  ApplyResult,
  Capabilities,
  Cell,
  CellValue,
  ChangesPreview,
  ChangesRequest,
  Column,
  Connection,
  ConnectResult,
  CreateTableSpec,
  Cursor,
  Kind,
  ObjectDetail,
  ObjectRef,
  ObjectType,
  Pagination,
  ReadRowsResult,
  RunSQLResult,
  ResultSet,
  SaveConnectionRequest,
  SecretBackend,
  SchemaObject,
  Settings,
  Sort,
  TlsInfo,
} from './types'

type Bindings = Record<string, (...args: unknown[]) => Promise<unknown>>

declare global {
  interface Window {
    go?: { main?: { App?: Bindings } }
  }
}

function wailsBindings(): Bindings | null {
  return window.go?.main?.App ?? null
}

export const transportName = wailsBindings() ? 'wails' : 'http'

/**
 * Errors from the Go side are almost always database errors, which are the
 * user's primary feedback channel. They are surfaced verbatim rather than
 * being wrapped in something friendlier and less useful.
 */
export class ApiError extends Error {
  constructor(public method: string, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * `args` is the ordered argument list for the Wails binding. The HTTP
 * transport needs a single JSON body instead, so `httpBody` maps those
 * arguments into the shape cmd/devserver expects.
 */
function call<T>(method: string, args: unknown[], httpBody: unknown): Promise<T> {
  // Timed here rather than at each of the thirty call sites below. The span is
  // what separates "the database was slow" from "our UI was slow" — no other
  // measurement can, and the two feel identical to whoever is clicking.
  return span(`api ${method}`, () => invoke<T>(method, args, httpBody))
}

async function invoke<T>(method: string, args: unknown[], httpBody: unknown): Promise<T> {
  const bindings = wailsBindings()
  if (bindings) {
    const fn = bindings[method]
    if (!fn) throw new ApiError(method, `binding ${method} is missing`)
    try {
      return (await fn(...args)) as T
    } catch (e) {
      throw new ApiError(method, e instanceof Error ? e.message : String(e))
    }
  }

  const res = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(httpBody ?? {}),
  })
  const text = await res.text()
  if (!res.ok) {
    let message = text
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text
    } catch {
      // A non-JSON body means the dev server is not running or something
      // upstream failed; the raw text is the most useful thing to show.
    }
    throw new ApiError(method, message || `${method} failed with ${res.status}`)
  }
  return (text ? JSON.parse(text) : null) as T
}

export const api = {
  drivers: () => call<Record<Kind, Capabilities>>('Drivers', [], {}),

  listConnections: () => call<Connection[]>('ListConnections', [], {}),

  saveConnection: (req: SaveConnectionRequest) =>
    call<Connection>('SaveConnection', [req], req),

  deleteConnection: (id: string) => call<void>('DeleteConnection', [id], { id }),

  testConnection: (req: SaveConnectionRequest) => call<void>('TestConnection', [req], req),

  /**
   * `password` is read only for an ask-every-time connection and is used for
   * this call alone. `database` overrides the saved default.
   */
  connect: (id: string, password: string | null = null, database = '') => {
    const req = { connectionId: id, password, database }
    return call<ConnectResult>('Connect', [req], req)
  },

  disconnect: (id: string) => call<void>('Disconnect', [id], { id }),

  connectedIds: () => call<string[] | null>('ConnectedIDs', [], {}),

  listObjects: (id: string, database: string) =>
    call<SchemaObject[]>('ListObjects', [id, database], { id, database }),

  listColumns: (id: string, ref: ObjectRef) =>
    call<Column[]>('ListColumns', [id, ref], { id, ref }),

  describeObject: (id: string, ref: ObjectRef) =>
    call<ObjectDetail>('DescribeObject', [id, ref], { id, ref }),

  readRows: (req: {
    connectionId: string
    ref: ObjectRef
    filter: string
    orderBy: Sort[]
    /** Fill an empty orderBy with the table's default sort — see the store. */
    applyDefaultSort: boolean
    pagination: Pagination
    /** Read the rows after this position instead of counting `pagination.page`. */
    after?: Cursor
  }) => call<ReadRowsResult>('ReadRows', [req], req),

  /**
   * One cell in full, bypassing the text cap. The row is addressed by its
   * absolute offset in the same filtered, sorted result the grid is showing,
   * so the filter and sort passed here must be the ones the page was read
   * with.
   */
  readCell: (req: {
    connectionId: string
    ref: ObjectRef
    column: string
    filter: string
    orderBy: Sort[]
    applyDefaultSort: boolean
    rowOffset: number
    /** The row's key values, which find it exactly; the offset is the fallback. */
    key?: Record<string, Cell>
  }) => call<CellValue>('ReadCell', [req], req),

  countRows: (req: { connectionId: string; ref: ObjectRef; filter: string }) =>
    call<number>('CountRows', [req], req),

  /** The statements applyChanges would run. Runs none of them. Rejects with the
   *  reason when a change does not fit the table (wrong key, read-only column …). */
  previewChanges: (req: ChangesRequest) =>
    call<ChangesPreview>('PreviewChanges', [req], req),

  /** One transaction. A conflict comes back as a result, not a thrown error;
   *  a change that does not fit the table rejects like previewChanges does. */
  applyChanges: (req: ChangesRequest) => call<ApplyResult>('ApplyChanges', [req], req),

  runSql: (req: { connectionId: string; database: string; sql: string; maxRows: number }) =>
    call<RunSQLResult>('RunSQL', [req], req),

  /** Empties a table — a DELETE on SQLite. See capabilities.truncateIsDelete. */
  truncateTable: (req: { connectionId: string; ref: ObjectRef }) =>
    call<ResultSet>('TruncateTable', [req], req),

  /** Drops a table or view. Functions and procedures are refused by the driver. */
  dropObject: (req: { connectionId: string; ref: ObjectRef; type: ObjectType }) =>
    call<ResultSet>('DropObject', [req], req),

  createTable: (req: { connectionId: string; spec: CreateTableSpec }) =>
    call<ResultSet>('CreateTable', [req], req),

  /** The statement createTable would run, for the dialog to show. Runs nothing,
   *  needs no open connection, and is not logged as activity. */
  previewCreateTable: (req: { connectionId: string; spec: CreateTableSpec }) =>
    call<string>('PreviewCreateTable', [req], req),

  getSettings: () => call<Settings>('GetSettings', [], {}),

  saveSettings: (s: Settings) => call<Settings>('SaveSettings', [s], s),

  /** The TLS mode `c` will use once defaults apply. Needs no saved connection. */
  describeTLS: (c: Connection) => call<TlsInfo>('DescribeTLS', [c], c),

  secretBackend: () => call<SecretBackend>('SecretBackend', [], {}),

  activity: () => call<ActivityResult>('Activity', [], {}),

  cancelQuery: (id: string) => call<void>('CancelQuery', [id], { id }),

  /** The whole statement and error of an entry the tray shows truncated. */
  querySql: (id: string) => call<QuerySqlResult>('QuerySQL', [id], { id }),

  clearQueryHistory: () => call<void>('ClearQueryHistory', [], {}),

  /**
   * Sends a line to the Go log file, which is the only place it persists.
   *
   * Deliberately untimed — it is how the timings are flushed, and measuring it
   * would mean every flush produced fresh measurements to flush.
   */
  logClient: (line: string) => invoke<void>('LogClient', [line], { line }),
}

// Re-exported so `import { api, errorMessage } from './api'` keeps working. It
// lives in ./errors because this file reads `window` as it loads, and the
// DOM-free logic modules — crash.ts — need the helper without that.
export { errorMessage } from './errors'
