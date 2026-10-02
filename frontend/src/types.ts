// Mirrors the Go DTOs in internal/driver, internal/config and internal/api.
// Kept hand-written rather than generated so the browser transport does not
// depend on `wails generate` having been run.

export type Kind = 'mysql' | 'postgres' | 'mssql' | 'sqlite'

export interface Capabilities {
  serverHostsDatabases: boolean
  hasSchemas: boolean
  databasePerConnection: boolean
  supportsFunctions: boolean
  defaultPort: number
  displayName: string
  /** SQLite has no TRUNCATE and is emptied with DELETE FROM; the confirmation
   *  says which, because they are not the same statement. */
  truncateIsDelete: boolean
  /** Seeds the type field in the new-table dialog. A starting point, not a
   *  whitelist — the field takes any type the engine accepts. */
  commonTypes: string[]
  /** False on SQLite, which has no DEFAULT keyword for an UPDATE: hide "reset
   *  to default" there. An insert may still carry a `default` cell — the
   *  column is simply left out. */
  setToDefault: boolean
}

export interface Connection {
  id: string
  name: string
  kind: Kind
  host?: string
  port?: number
  user?: string
  database?: string
  file?: string
  sslMode?: string
  /** Stored in plaintext. Never put a secret here. */
  params?: Record<string, string>
  /** The password is never stored: it is asked for on every connect. */
  askPassword?: boolean
  colour?: string
  createdAt?: string
  updatedAt?: string
}

export type ObjectType = 'table' | 'view' | 'function' | 'procedure'

export interface SchemaObject {
  schema: string
  name: string
  type: ObjectType
  rowEstimate?: number
}

export interface Column {
  name: string
  dataType: string
  nullable: boolean
  primaryKey: boolean
  default?: string
  ordinal: number
  /**
   * Filled by describeObject only — listColumns leaves these unset so the row
   * browser stays one cheap query. See internal/driver/driver.go.
   */
  autoIncrement?: boolean
  generated?: boolean
  comment?: string
  collation?: string
}

export interface Index {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  /** btree, hash, CLUSTERED … blank where the dialect has only one kind. */
  method?: string
}

export interface ForeignKey {
  name: string
  /** Positionally paired with referencedColumns. */
  columns: string[]
  referencedSchema?: string
  referencedTable: string
  referencedColumns: string[]
  onUpdate?: string
  onDelete?: string
}

export interface Trigger {
  name: string
  timing?: string
  event?: string
}

export interface CheckConstraint {
  name: string
  expression: string
}

export interface KeyValue {
  key: string
  value: string
}

/**
 * Everything the details page shows about one table or view.
 *
 * The first group is answerable by all four dialects and is always present.
 * The second is not: where an engine cannot answer, the field is absent and
 * `unavailable` carries the reason to print in its place — so a gap reads as a
 * known limitation rather than as a zero. Never render a value whose name
 * appears in `unavailable`.
 */
export interface ObjectDetail {
  ref: ObjectRef
  type: ObjectType

  columns: Column[]
  primaryKey: string[]
  indexes: Index[]
  foreignKeys: ForeignKey[]
  triggers: Trigger[]

  rowEstimate?: number
  sizeBytes?: number
  comment?: string
  checks: CheckConstraint[]
  /** View body, for views only. */
  definition?: string

  dialectDetail?: KeyValue[]
  unavailable?: Record<string, string>
}

export interface ObjectRef {
  database: string
  schema: string
  name: string
}

export interface Sort {
  column: string
  desc: boolean
}

export interface ResultColumn {
  name: string
  dbType: string
}

/** Cell values are limited to these by internal/driver/scan.go. */
export type Cell = string | number | boolean | null

/** One cell's position in a ResultSet. */
export interface CellRef {
  row: number
  col: number
}

export interface ResultSet {
  columns: ResultColumn[]
  rows: Cell[][]
  truncated: boolean
  /** Character cap applied to long values; 0 means none was. */
  textCap: number
  /** The cells the cap shortened — the grid marks these rather than lying. */
  truncatedCells: CellRef[]
  elapsedMs: number
  rowsAffected?: number
  query: string
}

/**
 * What one run of the editor produced. A batch is one round trip that can
 * answer several times over — `use other_db; select …` — so the editor shows a
 * tab per result set.
 */
export interface RunSQLResult {
  results: ResultSet[]
  /** The batch produced more result sets than were kept. */
  moreResults: boolean
}

/** One value fetched on its own, in full — see api.readCell. */
export interface CellValue {
  /** null for NULL, which is not the same as an empty string. */
  value: string | null
  /** Size in the database, before any trimming. */
  bytes: number
  /** True when even the full fetch had to stop (8 MiB). */
  truncated: boolean
  query: string
}

export interface Pagination {
  enabled: boolean
  page: number
  pageSize: number
}

/**
 * A column as the grid receives it from readRows: the catalogue's description
 * plus whether a cell in it can be written. Flattened from Go's GridColumn.
 */
export interface GridColumn extends Column {
  /** False for every column of a read-only table, and for generated, binary,
   *  identity and rowversion columns of an editable one. */
  editable: boolean
  /** Why, for a tooltip. Absent when editable. */
  readOnlyReason?: string
}

/**
 * A position in a sort: the values of the last row's sort columns. Opaque to
 * the UI — it is returned by one read and handed back to ask for the rows after
 * it, so rows added or removed above cannot repeat or skip one.
 */
export interface Cursor {
  columns: string[]
  values: unknown[]
}

export interface ReadRowsResult {
  result: ResultSet
  columns: GridColumn[]
  /** Columns that identify one row, in key order: what a row change sends as
   *  its key. Empty when the table is read-only. */
  editKey: string[]
  /** Why the whole table cannot be edited (a view, no usable key …); empty
   *  when it can. An editable table may still have read-only columns. */
  readOnlyReason: string
  page: number
  /** The sort the page was read with — the default one when none was asked for. */
  orderBy: Sort[] | null
  hasMore: boolean
  /** Where the next page starts, when this sort can be read by position. */
  next?: Cursor | null
}

/**
 * What one cell is to become. Three intents a bare string cannot tell apart:
 * text to store, NULL, and "whatever the column defaults to". Go: api.CellValue —
 * renamed here because CellValue above is the result of readCell.
 */
export interface CellInput {
  kind: 'value' | 'null' | 'default'
  /** Text to store, for kind 'value'. Coerced server-side by the column's type. */
  value?: string
}

export interface RowChange {
  /** The table this change is for. One change set may span several tables of one
   *  connection and ONE database (a different database is rejected). */
  ref: ObjectRef
  op: 'update' | 'insert' | 'delete'
  /** ORIGINAL values of the key columns, exactly readRows' editKey, as readRows
   *  sent them (bigints and decimals stay strings). Update and delete only. */
  key?: Record<string, unknown>
  /** Update: the changed columns only. Insert: the columns given a value. */
  set?: Record<string, CellInput>
}

export interface ChangesRequest {
  connectionId: string
  /** Applied in this order, in one transaction. */
  changes: RowChange[]
}

/** What one column of a statement is set to. Go: api.StatementCell. */
export interface StatementCell {
  column: string
  kind: 'value' | 'null' | 'default'
  /** Characters of the new text; 0 unless kind is 'value'. */
  chars: number
}

export interface Statement {
  /** Parameterised text — what runs. */
  sql: string
  /** The same statement with values written in, for a person to read. Never run. */
  display: string
  /** display with every string literal over 160 characters cut and ending
   *  "…(+N more chars)". Equals display when nothing was long. */
  short: string
  /** Qualified name of the table touched ("schema.name", or "name"). */
  table: string
  /** Set columns in column order; empty for a delete. */
  cells: StatementCell[]
}

export interface ChangesPreview {
  /** One per change, in order. */
  statements: Statement[]
}

export interface ChangeConflict {
  /** Into ChangesRequest.changes, from 0. */
  index: number
  /** Qualified name of the table that change was for. */
  table: string
  message: string
}

/** All or nothing: applied is changes.length and conflict is absent, or applied
 *  is 0, the transaction rolled back, and conflict says which change and why. */
export interface ApplyResult {
  applied: number
  conflict?: ChangeConflict
}

export interface ConnectResult {
  capabilities: Capabilities
  databases: { name: string }[]
  defaultDatabase: string
}

/** Where saved passwords live. Anything but `keyring` gets a standing warning. */
export interface SecretBackend {
  kind: 'keyring' | 'file' | 'unavailable'
  reason?: string
}

export interface SaveConnectionRequest {
  connection: Connection
  /** null leaves the stored password untouched. */
  password: string | null
}

export interface Settings {
  /** Palette id — see `themes.ts`. Mirrors `config.ThemeIDs` on the Go side. */
  theme: string
  /** Root font size in px. The UI is sized in rem, so this scales all of it. */
  fontSizePx: number
  defaultPageSize: number
  paginationEnabled: boolean
  rowCap: number
  /** Characters kept from long text/JSON columns; 0 disables the cap. */
  textCapChars: number
  showSystemObjects: boolean
  autoCount: boolean
  confirmDestructive: boolean
  sidebarWidthPx: number
  trayHeightPx: number
  sqlEditorHeightPx: number
  /** Whether the tab strip is hidden (Ctrl+B). */
  tabStripHidden: boolean
  /** Slide time of the tab strip and the activity tray, in ms. 0 is instant. */
  drawerDurationMs: number
  /** Load the next page when the last row scrolls into view. */
  infiniteScroll: boolean
}

/**
 * One column in a CREATE TABLE.
 *
 * `type` and `default` are raw SQL fragments, not values — `numeric(10,2)`,
 * `now()` — because DDL takes no placeholders. Mirrors driver.NewColumn; the Go
 * side rejects semicolons and comments in either, and nothing else.
 */
export interface NewColumn {
  name: string
  type: string
  nullable: boolean
  primaryKey: boolean
  default: string
}

export interface CreateTableSpec {
  ref: ObjectRef
  columns: NewColumn[]
}

export type QueryKind = 'browse' | 'count' | 'query' | 'introspect' | 'ddl' | 'write'

/**
 * The app's own lifecycle states, instrumented in internal/activity,
 * internal/driver and internal/api — not the server's view of the query. The
 * last three are terminal: an entry carrying one of them is history.
 */
export type QueryPhase =
  | 'queued'
  | 'executing'
  | 'reading rows'
  | 'cancelling'
  | 'done'
  | 'failed'
  | 'cancelled'

/** One query, running or finished. Mirrors internal/activity.Info. */
export interface QueryInfo {
  id: string
  connectionId: string
  database: string
  kind: QueryKind
  /** A preview of at most 300 characters; `querySql` has the whole statement. */
  sql: string
  /** `sql` is cut. The whole statement is fetched with `api.querySql`. */
  sqlTruncated?: boolean
  startedAt: string
  /** Frozen once the phase is terminal. */
  elapsedMs: number
  phase: QueryPhase
  rowsRead: number
  /** A preview of at most 500 characters. */
  error?: string
  errorTruncated?: boolean
}

/** The whole text behind a QueryInfo. Mirrors api.QuerySQLResult. */
export interface QuerySqlResult {
  sql: string
  error?: string
  /** False once the text has been evicted from the log; `sql` is then only the preview. */
  kept: boolean
}

export interface SessionInfo {
  connectionId: string
  database: string
  openConns: number
  inUse: number
  idle: number
}

export interface ActivityResult {
  /** Running queries newest-first, then the bounded history newest-first. */
  queries: QueryInfo[]
  sessions: SessionInfo[]
}
