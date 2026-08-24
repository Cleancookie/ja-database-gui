// Package driver defines the dialect abstraction that the rest of ja-db is
// written against. Each supported database implements Driver.
//
// The interface is introspection-shaped, not SQL-shaped: it hands back
// []Database, []SchemaObject and []Column rather than raw rows, because the
// four dialects disagree fundamentally about how those questions are asked.
// See ARCHITECTURE.md for the table of asymmetries this absorbs.
package driver

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
)

// Kind identifies a dialect. These strings are persisted in connections.json
// and sent to the frontend, so they are part of the app's public surface.
type Kind string

const (
	KindMySQL    Kind = "mysql" // also serves MariaDB
	KindPostgres Kind = "postgres"
	KindMSSQL    Kind = "mssql"
	KindSQLite   Kind = "sqlite"
)

// ConnConfig is everything needed to open a connection. Database may be
// overridden per-request when the dialect supports switching.
type ConnConfig struct {
	Kind     Kind              `json:"kind"`
	Host     string            `json:"host"`
	Port     int               `json:"port"`
	User     string            `json:"user"`
	Password string            `json:"password"`
	Database string            `json:"database"`
	File     string            `json:"file"`    // SQLite only
	SSLMode  string            `json:"sslMode"` // postgres: disable/require/verify-full; mysql: tls param
	Params   map[string]string `json:"params"`  // escape hatch, appended to the DSN
}

// Capabilities lets the UI adapt without switching on Kind.
type Capabilities struct {
	// ServerHostsDatabases is false for SQLite, where the connection *is* the
	// database and the database list is meaningless.
	ServerHostsDatabases bool `json:"serverHostsDatabases"`
	// HasSchemas is true where objects live in a schema within a database
	// (postgres, mssql) and false where the database is the schema (mysql,
	// sqlite). Drives whether the tree renders a schema level.
	HasSchemas bool `json:"hasSchemas"`
	// DatabasePerConnection is true for postgres, where you cannot switch
	// database on an open connection and the engine must dial again.
	DatabasePerConnection bool `json:"databasePerConnection"`
	// SupportsFunctions is false for SQLite, which has no catalog of them.
	SupportsFunctions bool   `json:"supportsFunctions"`
	DefaultPort       int    `json:"defaultPort"`
	DisplayName       string `json:"displayName"`

	// TruncateIsDelete is true for SQLite, which has no TRUNCATE and is emptied
	// with DELETE FROM instead. The confirmation says which one it is about to
	// run, because they are not the same statement: DELETE fires triggers, is
	// transactional, and does not reset a sequence.
	TruncateIsDelete bool `json:"truncateIsDelete"`
	// CommonTypes seeds the type field in the new-table dialog with this
	// dialect's usual spellings, identity column included. It is a starting
	// point, not a whitelist — the field takes any type the engine accepts.
	CommonTypes []string `json:"commonTypes"`
}

type Database struct {
	Name string `json:"name"`
}

type ObjectType string

const (
	ObjectTable     ObjectType = "table"
	ObjectView      ObjectType = "view"
	ObjectFunction  ObjectType = "function"
	ObjectProcedure ObjectType = "procedure"
)

// SchemaObject is one entry in the object tree.
type SchemaObject struct {
	Schema string     `json:"schema"` // empty where the dialect has no schemas
	Name   string     `json:"name"`
	Type   ObjectType `json:"type"`
	// RowEstimate is the planner's estimate where one is cheaply available.
	// It is an estimate and is labelled as such in the UI; nil means unknown.
	RowEstimate *int64 `json:"rowEstimate,omitempty"`
}

type Column struct {
	Name       string  `json:"name"`
	DataType   string  `json:"dataType"`
	Nullable   bool    `json:"nullable"`
	PrimaryKey bool    `json:"primaryKey"`
	Default    *string `json:"default,omitempty"`
	Ordinal    int     `json:"ordinal"`

	// The fields below are filled by DescribeObject and left zero by
	// ListColumns, which the row browser uses and which should stay one cheap
	// query. Nothing outside the details view should depend on them.

	// AutoIncrement covers MySQL AUTO_INCREMENT, postgres identity and serial,
	// and MSSQL IDENTITY. For SQLite it marks the INTEGER PRIMARY KEY that
	// aliases the rowid, which is the same idea by a different name.
	AutoIncrement bool `json:"autoIncrement,omitempty"`
	// Generated marks a computed/virtual/stored column.
	Generated bool `json:"generated,omitempty"`
	// Comment is nil where the engine has no comment for the column, and also
	// where it has no notion of one — see ObjectDetail.Unavailable.
	Comment   *string `json:"comment,omitempty"`
	Collation *string `json:"collation,omitempty"`
}

// Index is one index on a table. Primary is set for the index backing the
// primary key, which every dialect reports through its index catalog and which
// the UI labels rather than listing twice.
type Index struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique"`
	Primary bool     `json:"primary"`
	// Method is the access method where the dialect names one — btree, hash,
	// CLUSTERED, NONCLUSTERED. Empty where the dialect has only one kind.
	Method string `json:"method,omitempty"`
}

// ForeignKey is one outbound reference. Columns and ReferencedColumns are
// positionally paired, so a composite key reads left to right.
type ForeignKey struct {
	Name              string   `json:"name"`
	Columns           []string `json:"columns"`
	ReferencedSchema  string   `json:"referencedSchema,omitempty"`
	ReferencedTable   string   `json:"referencedTable"`
	ReferencedColumns []string `json:"referencedColumns"`
	// OnUpdate and OnDelete are the referential actions as the dialect words
	// them, upper-cased: CASCADE, SET NULL, RESTRICT, NO ACTION.
	OnUpdate string `json:"onUpdate,omitempty"`
	OnDelete string `json:"onDelete,omitempty"`
}

type Trigger struct {
	Name string `json:"name"`
	// Timing is BEFORE, AFTER or INSTEAD OF; Event is INSERT, UPDATE or
	// DELETE. Both are empty where the dialect only exposes the trigger body.
	Timing string `json:"timing,omitempty"`
	Event  string `json:"event,omitempty"`
}

type CheckConstraint struct {
	Name       string `json:"name"`
	Expression string `json:"expression"`
}

// ObjectDetail is everything the details view shows about one table or view.
//
// The split between fields is by portability, not by topic. Columns, PrimaryKey,
// Indexes, ForeignKeys and Triggers are answerable by all four dialects and are
// always populated. RowEstimate, SizeBytes, Comment and Checks are not: where a
// dialect cannot answer, the field stays nil or empty and Unavailable carries
// the reason.
type ObjectDetail struct {
	Ref  ObjectRef  `json:"ref"`
	Type ObjectType `json:"type"`

	Columns     []Column     `json:"columns"`
	PrimaryKey  []string     `json:"primaryKey"`
	Indexes     []Index      `json:"indexes"`
	ForeignKeys []ForeignKey `json:"foreignKeys"`
	Triggers    []Trigger    `json:"triggers"`

	// RowEstimate is the planner's estimate, not a COUNT(*) — it can be stale
	// or zero on a table that has never been analysed, and is labelled as an
	// estimate in the UI.
	RowEstimate *int64 `json:"rowEstimate,omitempty"`
	// SizeBytes is data plus indexes where the dialect reports them together.
	SizeBytes *int64  `json:"sizeBytes,omitempty"`
	Comment   *string `json:"comment,omitempty"`
	// Not omitempty: an empty slice must still marshal as [] rather than
	// disappearing, because the frontend declares this field as always present
	// and indexes into it. The same goes for the five slices above.
	Checks []CheckConstraint `json:"checks"`
	// Definition is the view body, for views only.
	Definition *string `json:"definition,omitempty"`

	// DialectDetail is the handful of facts that exist in one dialect and have
	// no counterpart elsewhere — MySQL's engine and table collation, postgres's
	// tablespace and owner, MSSQL's filegroup. Rendered as a plain key/value
	// list, in Order.
	DialectDetail []KeyValue `json:"dialectDetail,omitempty"`

	// Unavailable maps a field name above to a short reason the engine could
	// not fill it: "not available in SQLite", "requires the dbstat module".
	// The UI prints the reason where the value would go, so a gap reads as a
	// known engine limitation rather than as a zero. A field named here is nil
	// or empty above and must never be rendered as data.
	Unavailable map[string]string `json:"unavailable,omitempty"`
}

// KeyValue is one dialect-specific fact. A slice rather than a map because the
// order is chosen by the driver and worth preserving in the UI.
type KeyValue struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// ObjectRef identifies a table or view to read from.
type ObjectRef struct {
	Database string `json:"database"`
	Schema   string `json:"schema"`
	Name     string `json:"name"`
}

type Sort struct {
	Column string `json:"column"`
	Desc   bool   `json:"desc"`
}

// ReadOptions describes one page of a table browse.
type ReadOptions struct {
	// Filter is a raw SQL fragment placed directly after WHERE. It is not
	// parsed, escaped or validated — see docs/adr/0002-raw-sql-filter.md.
	Filter  string `json:"filter"`
	OrderBy []Sort `json:"orderBy"`
	// Limit of 0 means "no LIMIT clause" — pagination switched off. The engine
	// still applies a hard row cap so this cannot exhaust memory.
	Limit  int `json:"limit"`
	Offset int `json:"offset"`
	// TextCap cuts long text-shaped columns to this many characters in the
	// emitted SQL, so a table of megabyte JSON documents does not put
	// megabytes on the wire. 0 disables it. The cap needs cols to know which
	// columns can exceed it; with no column metadata the query is left alone
	// and only the scan-side cap in scan.go applies.
	TextCap int `json:"textCap"`
	// Select restricts the projection to these columns instead of SELECT *.
	// The single-cell fetch uses it to ask for one uncapped column of one row.
	// Names are quoted per dialect, never interpolated raw.
	Select []string `json:"select"`
}

type ResultColumn struct {
	Name string `json:"name"`
	// DBType is the database's own type name (VARCHAR, int4, …) where the
	// driver reports one. Used by the grid for alignment and formatting.
	DBType string `json:"dbType"`
}

// CellRef locates one cell within a ResultSet by its row and column index.
type CellRef struct {
	Row int `json:"row"`
	Col int `json:"col"`
}

// ResultSet is a page of rows in a JSON-safe form. Values are limited to
// string, float64, bool and nil — see scan.go.
type ResultSet struct {
	Columns   []ResultColumn `json:"columns"`
	Rows      [][]any        `json:"rows"`
	Truncated bool           `json:"truncated"` // hard row cap trimmed the result
	// TextCap is the character cap that was in force, so the UI can say what
	// a cut cell was cut to. 0 means no cap was applied.
	TextCap int `json:"textCap"`
	// TruncatedCells lists the cells the cap shortened. Truncation has to be
	// visible in the grid rather than silent, and a sparse list costs nothing
	// on the usual result where nothing was cut.
	TruncatedCells []CellRef `json:"truncatedCells"`
	ElapsedMS      int64     `json:"elapsedMs"`
	// RowsAffected is set for statements that are not queries (INSERT/UPDATE…).
	RowsAffected *int64 `json:"rowsAffected,omitempty"`
	Query        string `json:"query"` // the SQL actually executed, for the UI
}

// Driver is the per-dialect contract. Implementations must be stateless and
// safe for concurrent use — they receive the *sql.DB on every call.
type Driver interface {
	Kind() Kind
	Caps() Capabilities

	// SQLDriverName is the name registered with database/sql.
	SQLDriverName() string
	// DSN builds a connection string. database overrides cfg.Database when
	// non-empty, which is how postgres reaches a second database.
	DSN(cfg ConnConfig, database string) (string, error)

	ListDatabases(ctx context.Context, db *sql.DB) ([]Database, error)
	// ListObjects returns tables, views, functions and procedures. database is
	// passed because MySQL and MSSQL can query across databases on one
	// connection; postgres and sqlite ignore it.
	ListObjects(ctx context.Context, db *sql.DB, database string) ([]SchemaObject, error)
	ListColumns(ctx context.Context, db *sql.DB, ref ObjectRef) ([]Column, error)
	// DescribeObject gathers everything the details view shows about one table
	// or view. It is several queries per dialect and is only called when that
	// view is opened — the row browser stays on ListColumns.
	//
	// A dialect that cannot answer part of it records the reason in
	// ObjectDetail.Unavailable rather than returning an error: a missing row
	// count is not a failure to describe the table. An error means the object
	// could not be read at all.
	DescribeObject(ctx context.Context, db *sql.DB, ref ObjectRef) (*ObjectDetail, error)

	// QuoteIdent quotes a single identifier for this dialect.
	QuoteIdent(ident string) string
	// BuildSelect assembles the row-browse query. cols is supplied so dialects
	// that need a deterministic sort for pagination (mssql) can pick one.
	BuildSelect(ref ObjectRef, opts ReadOptions, cols []Column) (string, error)
	BuildCount(ref ObjectRef, filter string) string

	// The three statements behind the object menu. See ddl.go for why they are
	// built per dialect rather than written once in the caller.
	//
	// BuildTruncate empties a table. SQLite returns a DELETE, which Caps
	// advertises through TruncateIsDelete so the confirmation can say so.
	BuildTruncate(ref ObjectRef) (string, error)
	// BuildDrop drops a table or view. Any other object type is refused.
	BuildDrop(ref ObjectRef, typ ObjectType) (string, error)
	BuildCreateTable(spec CreateTableSpec) (string, error)
}

// textCapper is how a dialect says "the first n characters of this
// expression". It is deliberately *not* part of Driver: the interface stays
// introspection-shaped, and this is the one fragment of SQL a dialect has to
// hand back. expr arrives already quoted, and n is a Go int rendered by us,
// so nothing user-authored reaches the query through here.
//
// Every driver implements it; the type assertion in selectList means a future
// one that cannot express a substring simply gets no server-side cap, and the
// scan-side cap still protects the UI.
type textCapper interface {
	capText(expr string, n int) string
}

var registry = map[Kind]Driver{}

func register(d Driver) { registry[d.Kind()] = d }

// Get returns the driver for a kind.
func Get(k Kind) (Driver, error) {
	d, ok := registry[k]
	if !ok {
		return nil, fmt.Errorf("unsupported database kind %q", k)
	}
	return d, nil
}

// All returns every registered driver's capabilities, keyed by kind. The
// frontend uses this to build the "new connection" form without hardcoding
// dialect knowledge.
func All() map[Kind]Capabilities {
	out := make(map[Kind]Capabilities, len(registry))
	for k, d := range registry {
		out[k] = d.Caps()
	}
	return out
}

// Kinds returns the registered kinds in a stable order.
func Kinds() []Kind {
	ks := make([]Kind, 0, len(registry))
	for k := range registry {
		ks = append(ks, k)
	}
	sort.Slice(ks, func(i, j int) bool { return ks[i] < ks[j] })
	return ks
}

// --- shared query-building helpers -------------------------------------------------

// quoteWith quotes an identifier by doubling any occurrence of the closing
// character, which is the correct escape for every dialect we support: a
// backtick is doubled in MySQL, a double-quote in postgres and sqlite, and a
// closing square bracket in MSSQL.
func quoteWith(open, close, ident string) string {
	return open + strings.ReplaceAll(ident, close, close+close) + close
}

// qualify joins the non-empty parts of a reference with dots, quoting each.
func qualify(d Driver, parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			out = append(out, d.QuoteIdent(p))
		}
	}
	return strings.Join(out, ".")
}

// whereClause renders the raw user filter. The fragment is interpolated
// verbatim by design; see docs/adr/0002-raw-sql-filter.md.
func whereClause(filter string) string {
	f := strings.TrimSpace(filter)
	if f == "" {
		return ""
	}
	// Tolerate the user typing the keyword themselves, which is a common
	// reflex when moving over from a tool that expects the full clause.
	if len(f) >= 5 && strings.EqualFold(f[:5], "where") && (len(f) == 5 || isSpace(f[5])) {
		f = strings.TrimSpace(f[5:])
		if f == "" {
			return ""
		}
	}
	return " WHERE " + f
}

func isSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

// DefaultOrderBy is the sort a table browse uses when the user has not picked
// one: the primary key, descending. Newest-first is what someone opening a
// table almost always wants to see, and an unordered read gives whatever the
// engine finds first, which also makes paging non-deterministic.
//
// Composite keys are ordered by every part, in key order. A view, or a table
// without a primary key, gets nothing — there is no column here worth guessing
// at, and mssql still invents its own key for paging (see mssql.go).
func DefaultOrderBy(cols []Column) []Sort {
	var sorts []Sort
	for _, c := range cols {
		if c.PrimaryKey {
			sorts = append(sorts, Sort{Column: c.Name, Desc: true})
		}
	}
	return sorts
}

// orderByClause renders sorts, quoting each column. Unlike the filter, sort
// columns are identifiers and are always quoted.
func orderByClause(d Driver, sorts []Sort) string {
	if len(sorts) == 0 {
		return ""
	}
	parts := make([]string, 0, len(sorts))
	for _, s := range sorts {
		if strings.TrimSpace(s.Column) == "" {
			continue
		}
		dir := " ASC"
		if s.Desc {
			dir = " DESC"
		}
		parts = append(parts, d.QuoteIdent(s.Column)+dir)
	}
	if len(parts) == 0 {
		return ""
	}
	return " ORDER BY " + strings.Join(parts, ", ")
}

// limitOffsetClause is the MySQL/Postgres/SQLite form. MSSQL overrides this.
func limitOffsetClause(opts ReadOptions) string {
	var b strings.Builder
	if opts.Limit > 0 {
		fmt.Fprintf(&b, " LIMIT %d", opts.Limit)
		if opts.Offset > 0 {
			fmt.Fprintf(&b, " OFFSET %d", opts.Offset)
		}
	} else if opts.Offset > 0 {
		// An OFFSET with no LIMIT is only legal alongside one in MySQL, so
		// emit the maximum rather than special-casing per dialect.
		fmt.Fprintf(&b, " LIMIT %d OFFSET %d", int64(1)<<62, opts.Offset)
	}
	return b.String()
}

// selectList renders the projection.
//
// Long text columns are wrapped in the dialect's substring so the value is cut
// by the server rather than shipped in full and trimmed here — that is the
// whole point of the cap. Every other column passes through untouched, and
// with nothing to cap the list collapses back to "*" so the query stays as
// readable as it was before the cap existed.
func selectList(d Driver, opts ReadOptions, cols []Column) string {
	if len(opts.Select) > 0 {
		parts := make([]string, 0, len(opts.Select))
		for _, c := range opts.Select {
			parts = append(parts, d.QuoteIdent(c))
		}
		return strings.Join(parts, ", ")
	}

	capper, ok := d.(textCapper)
	if !ok || opts.TextCap <= 0 || len(cols) == 0 {
		return "*"
	}

	capped := false
	parts := make([]string, 0, len(cols))
	for _, c := range cols {
		q := d.QuoteIdent(c.Name)
		if isLongTextType(c.DataType, opts.TextCap) {
			// One character past the cap: that extra character is what tells
			// the scan the value was cut, without a second query or a
			// length() column tagged onto every row.
			parts = append(parts, capper.capText(q, opts.TextCap+1)+" AS "+q)
			capped = true
			continue
		}
		parts = append(parts, q)
	}
	if !capped {
		return "*"
	}
	return strings.Join(parts, ", ")
}

// buildStandardSelect is shared by every dialect using LIMIT/OFFSET.
func buildStandardSelect(d Driver, ref ObjectRef, opts ReadOptions, target string, cols []Column) string {
	return "SELECT " + selectList(d, opts, cols) + " FROM " + target +
		whereClause(opts.Filter) +
		orderByClause(d, opts.OrderBy) +
		limitOffsetClause(opts)
}
