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
  params?: Record<string, string>
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
}

export interface ConnectResult {
  capabilities: Capabilities
  databases: { name: string }[]
  defaultDatabase: string
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

export type QueryKind = 'browse' | 'count' | 'query' | 'introspect' | 'ddl'

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
  sql: string
  startedAt: string
  /** Frozen once the phase is terminal. */
  elapsedMs: number
  phase: QueryPhase
  rowsRead: number
  error?: string
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
