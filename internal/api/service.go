// Package api is the whole application surface. It knows nothing about Wails
// or HTTP; both transports are thin pass-throughs to the methods here.
package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/Cleancookie/ja-db/internal/activity"
	"github.com/Cleancookie/ja-db/internal/config"
	"github.com/Cleancookie/ja-db/internal/driver"
	"github.com/Cleancookie/ja-db/internal/engine"
	"github.com/Cleancookie/ja-db/internal/query"
)

// testConnectionTimeout bounds the "Test connection" button so a wrong host
// cannot leave the dialog spinning indefinitely.
const testConnectionTimeout = 20 * time.Second

// Service is the API. One instance per running app.
type Service struct {
	store    *config.Store
	settings *config.SettingsStore
	engine   *engine.Engine
	activity *activity.Registry
	// runner is the only way this package runs anything against a database.
	// See internal/query: tracking and logging are middleware there rather
	// than repeated at every call site.
	runner *query.Runner
	// columns memoises column metadata for columnTTL. Metadata only — rows are
	// never cached. See columncache.go.
	columns *columnCache
}

func New(store *config.Store, settings *config.SettingsStore, eng *engine.Engine, act *activity.Registry) *Service {
	return &Service{
		store:    store,
		settings: settings,
		engine:   eng,
		activity: act,
		runner: query.New(
			// Tracking first, so it is outermost: it supplies the cancellable
			// context everything else runs under, and assigns the id the log
			// lines share with the tray.
			query.Tracking(act),
			query.Logging(logQuery),
		),
		columns: newColumnCache(columnTTL, time.Now),
	}
}

// logQuery is the default log sink: one line per finished query, at a level
// that depends on the outcome. Deliberately plain `log` — this app has no
// logging framework and a query log is not a reason to add one.
func logQuery(e query.Entry) {
	sql := logSQL(e.Op.SQL)
	switch {
	case e.Err != nil:
		log.Printf("query %s %s db=%q %s failed in %s: %v",
			e.Op.ID, e.Op.Kind, e.Op.Database, sql, e.Elapsed.Round(time.Millisecond), e.Err)
	case e.RowsRead > 0:
		log.Printf("query %s %s db=%q %s %d rows in %s",
			e.Op.ID, e.Op.Kind, e.Op.Database, sql, e.RowsRead, e.Elapsed.Round(time.Millisecond))
	default:
		log.Printf("query %s %s db=%q %s ok in %s",
			e.Op.ID, e.Op.Kind, e.Op.Database, sql, e.Elapsed.Round(time.Millisecond))
	}
}

// logSQLMax caps the statement in the log line. The introspect ops carry short
// labels ("list objects", "describe foo.bar") and survive whole; a browse
// carries a real SELECT, of which the head is enough to tell two apart.
const logSQLMax = 120

// logSQL flattens a statement onto one line and caps its length, so that one
// query stays one grep-able line.
func logSQL(sql string) string {
	flat := strings.Join(strings.Fields(sql), " ")
	// Rune-wise, not byte-wise: a table name can be non-ASCII and half a rune
	// in the log is worse than a longer line.
	if r := []rune(flat); len(r) > logSQLMax {
		flat = string(r[:logSQLMax]) + "…"
	}
	return strconv.Quote(flat)
}

func (s *Service) Shutdown() {
	s.engine.Shutdown()
	s.activity.Close()
}

// --- settings ----------------------------------------------------------------------

func (s *Service) GetSettings() config.Settings { return s.settings.Get() }

func (s *Service) SaveSettings(v config.Settings) (config.Settings, error) {
	return s.settings.Set(v)
}

// --- secrets -----------------------------------------------------------------------

// SecretBackend says where saved passwords are kept: "keyring", "file" (plaintext
// on disk, because no keyring worked) or "unavailable". The UI shows a standing
// warning for anything but "keyring".
func (s *Service) SecretBackend() config.BackendInfo { return s.store.Backend() }

// --- activity ----------------------------------------------------------------------

// SessionInfo is one live connection to one database.
type SessionInfo struct {
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database"`
	OpenConns    int    `json:"openConns"`
	InUse        int    `json:"inUse"`
	Idle         int    `json:"idle"`
}

// ActivityResult is what the app has open and what it has been running.
// Queries covers both halves of the tray: what is in flight, then the bounded
// history of what has finished.
type ActivityResult struct {
	Queries  []activity.Info `json:"queries"`
	Sessions []SessionInfo   `json:"sessions"`
}

func (s *Service) Activity() ActivityResult {
	sessions := s.engine.Sessions()
	out := ActivityResult{
		Queries:  s.activity.List(),
		Sessions: make([]SessionInfo, 0, len(sessions)),
	}
	for _, sess := range sessions {
		out.Sessions = append(out.Sessions, SessionInfo{
			ConnectionID: sess.ConnectionID,
			Database:     sess.Database,
			OpenConns:    sess.OpenConns,
			InUse:        sess.InUse,
			Idle:         sess.Idle,
		})
	}
	return out
}

// CancelQuery stops one running query.
func (s *Service) CancelQuery(id string) { s.activity.Cancel(id) }

// QuerySQLResult is the whole text of one activity-log entry. Kept is false
// when the text has been evicted, in which case SQL and Error hold only the
// preview the log still has, or nothing for an id it never knew.
type QuerySQLResult struct {
	SQL   string `json:"sql"`
	Error string `json:"error,omitempty"`
	Kept  bool   `json:"kept"`
}

// QuerySQL returns the full statement and error of a query the tray shows
// truncated. It reads a temp file, never the database.
func (s *Service) QuerySQL(id string) QuerySQLResult {
	sql, errText, kept := s.activity.Full(id)
	return QuerySQLResult{SQL: sql, Error: errText, Kept: kept}
}

// ClearQueryHistory empties the finished half of the activity list. Anything
// still running stays, since it is not history yet.
func (s *Service) ClearQueryHistory() { s.activity.ClearHistory() }

// --- connection management ---------------------------------------------------------

// Drivers describes every supported dialect, so the frontend can build the
// connection form without hardcoding dialect knowledge.
func (s *Service) Drivers() map[driver.Kind]driver.Capabilities { return driver.All() }

func (s *Service) ListConnections() []config.Connection { return s.store.List() }

// SaveConnectionRequest creates when Connection.ID is empty, otherwise
// updates. Password is nil on an edit that did not touch the password field,
// which leaves the stored one alone.
type SaveConnectionRequest struct {
	Connection config.Connection `json:"connection"`
	Password   *string           `json:"password"`
}

func (s *Service) SaveConnection(req SaveConnectionRequest) (config.Connection, error) {
	if req.Connection.ID == "" {
		pw := ""
		if req.Password != nil {
			pw = *req.Password
		}
		return s.store.Create(req.Connection, pw)
	}
	return s.store.Update(req.Connection, req.Password)
}

func (s *Service) DeleteConnection(id string) error {
	// Drop live sessions first — leaving them open would keep using
	// credentials the user has just deleted.
	s.engine.Disconnect(id)
	return s.store.Delete(id)
}

// TestConnection dials without saving, so the dialog can verify before commit.
func (s *Service) TestConnection(req SaveConnectionRequest) error {
	c := req.Connection
	pw := ""
	if req.Password != nil {
		pw = *req.Password
	} else if c.ID != "" && !c.AskPassword {
		// Editing an existing connection without retyping the password.
		stored, err := s.store.Password(c.ID)
		if err != nil {
			return err
		}
		pw = stored
	}
	cfg := driver.ConnConfig{
		Kind: c.Kind, Host: c.Host, Port: c.Port, User: c.User, Password: pw,
		Database: c.Database, File: c.File, SSLMode: c.SSLMode, Params: c.Params,
	}
	ctx, cancel := context.WithTimeout(context.Background(), testConnectionTimeout)
	defer cancel()
	return scrub(s.engine.Test(ctx, cfg), pw)
}

// ConnectResult is everything the UI needs to populate the sidebar after a
// successful connect.
type ConnectResult struct {
	Capabilities    driver.Capabilities `json:"capabilities"`
	Databases       []driver.Database   `json:"databases"`
	DefaultDatabase string              `json:"defaultDatabase"`
}

// ErrPasswordRequired is returned for an ask-every-time connection that has no
// live session to reuse. The UI keys on the PASSWORD_REQUIRED prefix to open its
// password prompt.
var ErrPasswordRequired = errors.New("PASSWORD_REQUIRED: this connection asks for its password every time")

// ConnectRequest opens a connection. Password is only read for a connection
// saved with AskPassword; it is used for this call and not kept. Database
// overrides the saved default, which is how the UI reaches a second database of
// an ask-every-time connection.
type ConnectRequest struct {
	ConnectionID string  `json:"connectionId"`
	Password     *string `json:"password"`
	Database     string  `json:"database"`
}

func (s *Service) Connect(ctx context.Context, req ConnectRequest) (*ConnectResult, error) {
	connID := req.ConnectionID
	conn, err := s.store.Get(connID)
	if err != nil {
		return nil, err
	}
	if req.Database != "" {
		conn.Database = req.Database
	}
	d, err := driver.Get(conn.Kind)
	if err != nil {
		return nil, err
	}
	caps := d.Caps()

	sess, err := s.sessionWith(ctx, connID, conn.Database, req.Password)
	if err != nil {
		return nil, err
	}

	out := &ConnectResult{Capabilities: caps, DefaultDatabase: conn.Database}
	if !caps.ServerHostsDatabases {
		// SQLite: the file is the database. "main" keeps the shape uniform.
		out.Databases = []driver.Database{{Name: "main"}}
		out.DefaultDatabase = "main"
		return out, nil
	}

	var dbs []driver.Database
	err = s.runner.Do(ctx, query.Op{
		ConnectionID: connID,
		Database:     conn.Database,
		Kind:         activity.KindIntrospect,
		SQL:          "list databases",
	}, func(qctx context.Context) error {
		var err error
		dbs, err = sess.Driver.ListDatabases(qctx, sess.DB)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("listing databases: %w", err)
	}
	out.Databases = s.filterDatabases(conn.Kind, dbs)
	if out.DefaultDatabase == "" && len(out.Databases) > 0 {
		out.DefaultDatabase = out.Databases[0].Name
	}
	return out, nil
}

func (s *Service) Disconnect(connID string) {
	// Cancel first: closing a pool with queries still running leaves those
	// goroutines blocked until the server notices the socket has gone.
	s.activity.CancelConnection(connID)
	s.engine.Disconnect(connID)
	// Nothing cached for this connection describes anything still open, and the
	// next Connect may reach a different server behind the same id.
	s.columns.invalidateConnection(connID)
}

func (s *Service) ConnectedIDs() []string { return s.engine.Connected() }

// filterDatabases hides the server's own databases unless the user has asked
// to see them.
func (s *Service) filterDatabases(kind driver.Kind, dbs []driver.Database) []driver.Database {
	if s.settings.Get().ShowSystemObjects {
		return dbs
	}
	out := make([]driver.Database, 0, len(dbs))
	for _, d := range dbs {
		if !driver.IsSystemDatabase(kind, d.Name) {
			out = append(out, d)
		}
	}
	// Never hide everything: a server with only system databases should still
	// show them rather than presenting an empty, unexplained list.
	if len(out) == 0 {
		return dbs
	}
	return out
}

// --- browsing ----------------------------------------------------------------------

func (s *Service) ListDatabases(ctx context.Context, connID string) ([]driver.Database, error) {
	sess, err := s.session(ctx, connID, "")
	if err != nil {
		return nil, err
	}
	if !sess.Driver.Caps().ServerHostsDatabases {
		return []driver.Database{{Name: "main"}}, nil
	}

	var dbs []driver.Database
	if err := s.runner.Do(ctx, query.Op{
		ConnectionID: connID,
		Kind:         activity.KindIntrospect,
		SQL:          "list databases",
	}, func(qctx context.Context) error {
		var err error
		dbs, err = sess.Driver.ListDatabases(qctx, sess.DB)
		return err
	}); err != nil {
		return nil, err
	}
	return s.filterDatabases(sess.Driver.Kind(), dbs), nil
}

func (s *Service) ListObjects(ctx context.Context, connID, database string) ([]driver.SchemaObject, error) {
	sess, err := s.session(ctx, connID, database)
	if err != nil {
		return nil, err
	}

	var objs []driver.SchemaObject
	if err := s.runner.Do(ctx, query.Op{
		ConnectionID: connID,
		Database:     database,
		Kind:         activity.KindIntrospect,
		SQL:          "list objects",
	}, func(qctx context.Context) error {
		var err error
		objs, err = sess.Driver.ListObjects(qctx, sess.DB, database)
		return err
	}); err != nil {
		return nil, err
	}

	showAll := s.settings.Get().ShowSystemObjects
	kind := sess.Driver.Kind()
	out := make([]driver.SchemaObject, 0, len(objs))
	for _, o := range objs {
		if showAll || !driver.IsSystemSchema(kind, o.Schema) {
			out = append(out, o)
		}
	}
	return out, nil
}

// ListColumns reads a table's columns, from the cache when it has a live entry.
//
// A cache hit runs no query, so it produces no log line and no activity entry —
// it is not dodging the middleware chain, there is simply nothing to record.
// The chain still runs on every miss.
func (s *Service) ListColumns(ctx context.Context, connID string, ref driver.ObjectRef) ([]driver.Column, error) {
	if cached, ok := s.columns.get(connID, ref); ok {
		s.noteColumnCache()
		return cached, nil
	}

	sess, err := s.session(ctx, connID, ref.Database)
	if err != nil {
		return nil, err
	}

	var cols []driver.Column
	if err := s.runner.Do(ctx, query.Op{
		ConnectionID: connID,
		Database:     ref.Database,
		Kind:         activity.KindIntrospect,
		SQL:          "describe " + qualify(ref),
	}, func(qctx context.Context) error {
		var err error
		cols, err = sess.Driver.ListColumns(qctx, sess.DB, ref)
		return err
	}); err != nil {
		return nil, err
	}
	if cols == nil {
		cols = []driver.Column{}
	}
	s.columns.put(connID, ref, cols)
	s.noteColumnCache()
	return cols, nil
}

// columnCacheEvery is how often the running hit rate is logged. Every decision
// would be a line per grid interaction; never would leave "is the 5s TTL long
// enough?" a matter of opinion.
const columnCacheEvery = 25

// noteColumnCache logs the running hit rate periodically.
func (s *Service) noteColumnCache() {
	hits, misses := s.columns.stats()
	total := hits + misses
	if total == 0 || total%columnCacheEvery != 0 {
		return
	}
	log.Printf("columns cache: %d hits, %d misses (%d%% hit) ttl=%s",
		hits, misses, 100*hits/total, columnTTL)
}

// Pagination carries the three modes the UI offers: paged, or off entirely.
type Pagination struct {
	// Enabled false means no LIMIT is emitted. driver.HardRowCap still applies.
	Enabled  bool `json:"enabled"`
	Page     int  `json:"page"` // 1-based
	PageSize int  `json:"pageSize"`
}

type ReadRowsRequest struct {
	ConnectionID string           `json:"connectionId"`
	Ref          driver.ObjectRef `json:"ref"`
	// Filter is raw SQL appended after WHERE — see docs/adr/0002-raw-sql-filter.md.
	Filter  string        `json:"filter"`
	OrderBy []driver.Sort `json:"orderBy"`
	// ApplyDefaultSort fills an empty OrderBy with driver.DefaultOrderBy. It is
	// opt-in because an empty sort has two meanings: the table was just opened
	// and nobody has chosen one, or the user cycled the sort off and wants the
	// rows in whatever order the engine gives them.
	ApplyDefaultSort bool       `json:"applyDefaultSort"`
	Pagination       Pagination `json:"pagination"`
	// After asks for the rows following a position a previous read returned as
	// Next, in place of counting Pagination.Page rows from the top. Rows added or
	// removed above the window then cannot repeat or skip one. The sort must be
	// the one the position came from.
	After *driver.Cursor `json:"after"`
}

type ReadRowsResult struct {
	Result *driver.ResultSet `json:"result"`
	// Columns carries per-column editability beside the catalogue's description.
	Columns []GridColumn `json:"columns"`
	// EditKey is the columns that identify one row, in key order: what a change
	// must send as its Key. Empty when the table is read-only.
	EditKey []string `json:"editKey"`
	// ReadOnlyReason is why the whole table cannot be edited, or empty when it
	// can. A table that can be edited may still have read-only columns.
	ReadOnlyReason string `json:"readOnlyReason"`
	// Next is the position of the last row returned, to send back as After for
	// the page below it. Absent when there is no page below, or when this sort
	// cannot be paged by position (see driver.StableOrder) and Page must be used.
	Next *driver.Cursor `json:"next"`
	Page int            `json:"page"`
	// OrderBy is the sort the page was actually read with, which is the one the
	// request asked for or, when it asked for none, the default from
	// driver.DefaultOrderBy. The UI needs the effective sort to mark the header
	// and to address a cell with ReadCell.
	OrderBy []driver.Sort `json:"orderBy"`
	// HasMore is derived by asking for one row more than the page size, which
	// tells the UI whether to enable "next page" without a COUNT(*).
	HasMore bool `json:"hasMore"`
}

// DescribeObject gathers everything the table-details view shows. It is
// several queries per dialect rather than one, so it runs as a single
// introspect Op through the middleware chain — one activity-log entry for the
// whole description rather than seven, which is what someone reading the log
// wants to see.
func (s *Service) DescribeObject(ctx context.Context, connID string, ref driver.ObjectRef) (*driver.ObjectDetail, error) {
	sess, err := s.session(ctx, connID, ref.Database)
	if err != nil {
		return nil, err
	}

	var det *driver.ObjectDetail
	if err := s.runner.Do(ctx, query.Op{
		ConnectionID: connID,
		Database:     ref.Database,
		Kind:         activity.KindIntrospect,
		SQL:          "describe object " + qualify(ref),
	}, func(qctx context.Context) error {
		var err error
		det, err = sess.Driver.DescribeObject(qctx, sess.DB, ref)
		return err
	}); err != nil {
		return nil, err
	}

	// The frontend indexes into these, so a nil slice would arrive as null and
	// need guarding at every use site.
	if det.Columns == nil {
		det.Columns = []driver.Column{}
	}
	if det.Indexes == nil {
		det.Indexes = []driver.Index{}
	}
	if det.ForeignKeys == nil {
		det.ForeignKeys = []driver.ForeignKey{}
	}
	if det.Triggers == nil {
		det.Triggers = []driver.Trigger{}
	}
	if det.Checks == nil {
		det.Checks = []driver.CheckConstraint{}
	}
	if det.PrimaryKey == nil {
		det.PrimaryKey = []string{}
	}
	return det, nil
}

func (s *Service) ReadRows(ctx context.Context, req ReadRowsRequest) (*ReadRowsResult, error) {
	sess, err := s.session(ctx, req.ConnectionID, req.Ref.Database)
	if err != nil {
		return nil, err
	}

	cols, err := s.ListColumns(ctx, req.ConnectionID, req.Ref)
	if err != nil {
		// Column metadata is a nicety; a view the user can select from but not
		// introspect should still be browsable.
		cols = []driver.Column{}
	}

	settings := s.settings.Get()
	page := req.Pagination.Page
	if page < 1 {
		page = 1
	}
	orderBy := req.OrderBy
	if len(orderBy) == 0 && req.ApplyDefaultSort {
		orderBy = driver.DefaultOrderBy(cols)
	}

	facts := s.editFacts(ctx, sess, req.ConnectionID, req.Ref, cols)

	// What the query sorts by is the requested order plus whatever key columns it
	// lacks, so rows that tie on the chosen sort do not swap places between
	// pages. The UI is told the requested order, not this one: it is what the
	// header shows, and the tiebreaker is not the user's doing.
	queryOrder, byPosition := driver.StableOrder(orderBy, cols, facts.EditKey)

	opts := driver.ReadOptions{
		Filter:  req.Filter,
		OrderBy: queryOrder,
		TextCap: settings.TextCapChars,
	}
	if req.Pagination.Enabled {
		size := req.Pagination.PageSize
		if size <= 0 {
			size = settings.DefaultPageSize
		}
		// One extra row, trimmed before returning, is how HasMore is known.
		opts.Limit = size + 1
		opts.Offset = (page - 1) * size
	}
	if req.After != nil {
		if !req.Pagination.Enabled || !byPosition {
			return nil, fmt.Errorf("this sort cannot be read from a position; reload it")
		}
		after, err := cursorValues(req.After, queryOrder, cols)
		if err != nil {
			return nil, err
		}
		opts.After = after
		opts.Offset = 0
	}

	stmt, err := driver.BuildRead(sess.Driver, req.Ref, opts, cols)
	if err != nil {
		return nil, err
	}

	var rs *driver.ResultSet
	if err := s.runner.Do(ctx, query.Op{
		ConnectionID: req.ConnectionID,
		Database:     req.Ref.Database,
		Kind:         activity.KindBrowse,
		SQL:          stmt.Display,
	}, func(qctx context.Context) error {
		var err error
		rs, err = driver.RunQuery(qctx, sess.DB, stmt.SQL, driver.QueryOptions{
			RowCap:  settings.RowCap,
			TextCap: settings.TextCapChars,
		}, stmt.Args...)
		return err
	}); err != nil {
		return nil, err
	}
	// The statement with its values written in is the one worth showing.
	rs.Query = stmt.Display

	out := &ReadRowsResult{
		Result: rs, Columns: gridColumns(cols, facts), Page: page, OrderBy: orderBy,
		EditKey: facts.EditKey, ReadOnlyReason: facts.ReadOnlyReason,
	}
	if req.Pagination.Enabled {
		size := opts.Limit - 1
		if len(rs.Rows) > size {
			out.HasMore = true
			rs.Rows = rs.Rows[:size]
		}
		if out.HasMore && byPosition {
			out.Next = cursorAfter(rs, queryOrder)
		}
	}
	return out, nil
}

// cursorValues turns a position the UI sent back into values a database will
// bind. It must be for the order being read, or the comparison means nothing.
func cursorValues(c *driver.Cursor, order []driver.Sort, cols []driver.Column) ([]any, error) {
	if len(c.Columns) != len(order) || len(c.Values) != len(order) {
		return nil, fmt.Errorf("the position does not match this sort; reload it")
	}
	byName := make(map[string]driver.Column, len(cols))
	for _, col := range cols {
		byName[col.Name] = col
	}
	out := make([]any, len(order))
	for i, s := range order {
		if c.Columns[i] != s.Column {
			return nil, fmt.Errorf("the position does not match this sort; reload it")
		}
		v, err := driver.CoerceKey(byName[s.Column], c.Values[i])
		if err != nil {
			return nil, err
		}
		out[i] = v
	}
	return out, nil
}

// cursorAfter is the position of the last row of rs in order: its values in the
// wire form the grid holds, which is what cursorValues takes back. Nil when a
// sort column is not among the result's, in which case the UI pages by offset.
func cursorAfter(rs *driver.ResultSet, order []driver.Sort) *driver.Cursor {
	if len(rs.Rows) == 0 {
		return nil
	}
	index := make(map[string]int, len(rs.Columns))
	for i, c := range rs.Columns {
		index[c.Name] = i
	}
	lastRow := len(rs.Rows) - 1
	last := rs.Rows[lastRow]
	cut := make(map[int]bool)
	for _, c := range rs.TruncatedCells {
		if c.Row == lastRow {
			cut[c.Col] = true
		}
	}
	cur := &driver.Cursor{Columns: make([]string, len(order)), Values: make([]any, len(order))}
	for i, s := range order {
		j, ok := index[s.Column]
		// A value the text cap shortened is not the stored one, so a comparison
		// against it would land in the wrong place.
		if !ok || j >= len(last) || cut[j] {
			return nil
		}
		cur.Columns[i] = s.Column
		cur.Values[i] = last[j]
	}
	return cur
}

// ReadCellRequest asks for one cell in full — the escape hatch from the text
// cap, for the value the user has actually stopped to look at.
//
// The cell is addressed in the coordinates the grid is already displaying: the
// filter and sort that produced the page, plus the row's absolute offset within
// that result. Re-running the same query for one column of one row works on
// any table or view, with or without a primary key, which a key-based lookup
// would not. The trade is that the row is identified by position, so on a
// table being written to concurrently — or ordered only by whatever the server
// felt like — the value fetched may not be the one that was on screen.
type ReadCellRequest struct {
	ConnectionID string           `json:"connectionId"`
	Ref          driver.ObjectRef `json:"ref"`
	Column       string           `json:"column"`
	// Filter and OrderBy must be the ones the page was read with, or the
	// offset addresses a different row.
	Filter  string        `json:"filter"`
	OrderBy []driver.Sort `json:"orderBy"`
	// ApplyDefaultSort means the same as it does on ReadRowsRequest, and must
	// be passed the same way the page was read or the offset moves.
	ApplyDefaultSort bool `json:"applyDefaultSort"`
	// RowOffset is 0-based and absolute, not relative to the page.
	RowOffset int `json:"rowOffset"`
	// Key, when present, addresses the row by its key values (the original
	// ones, as ReadRows sent them) instead of by position, and the filter, sort
	// and offset are ignored. It is exact however the table has been written to
	// since the page was read, which an offset is not; it needs the table to
	// have a key (ReadRowsResult.EditKey), so the offset remains for those that
	// do not.
	Key map[string]any `json:"key,omitempty"`
}

func (s *Service) ReadCell(ctx context.Context, req ReadCellRequest) (*driver.Cell, error) {
	if strings.TrimSpace(req.Column) == "" {
		return nil, fmt.Errorf("no column given")
	}
	if req.RowOffset < 0 {
		return nil, fmt.Errorf("row offset must not be negative")
	}
	sess, err := s.session(ctx, req.ConnectionID, req.Ref.Database)
	if err != nil {
		return nil, err
	}

	// Columns are needed for the same reason as in ReadRows: mssql pages with
	// OFFSET/FETCH and has to invent an ORDER BY, and it must invent the same
	// one here or the offset points at a different row.
	cols, err := s.ListColumns(ctx, req.ConnectionID, req.Ref)
	if err != nil {
		cols = []driver.Column{}
	}
	if len(cols) > 0 && !hasColumn(cols, req.Column) {
		return nil, fmt.Errorf("no column %q on %s", req.Column, req.Ref.Name)
	}

	// The same defaulting as ReadRows, for the same reason as the columns
	// above: the row at this offset is only the row the user clicked if both
	// queries are ordered identically.
	orderBy := req.OrderBy
	if len(orderBy) == 0 && req.ApplyDefaultSort {
		orderBy = driver.DefaultOrderBy(cols)
	}
	facts := s.editFacts(ctx, sess, req.ConnectionID, req.Ref, cols)

	// TextCap is deliberately absent: this call exists to defeat it.
	opts := driver.ReadOptions{Select: []string{req.Column}, Limit: 1}
	if len(req.Key) > 0 {
		byName := make(map[string]driver.Column, len(cols))
		for _, c := range cols {
			byName[c.Name] = c
		}
		key, err := coerceKey(byName, facts.EditKey, req.Key)
		if err != nil {
			return nil, err
		}
		opts.Key = key
	} else {
		// Ordered exactly as ReadRows orders, tiebreaker included, or the
		// offset lands on a different one of the rows that tie.
		order, _ := driver.StableOrder(orderBy, cols, facts.EditKey)
		opts.Filter, opts.OrderBy, opts.Offset = req.Filter, order, req.RowOffset
	}
	stmt, err := driver.BuildRead(sess.Driver, req.Ref, opts, cols)
	if err != nil {
		return nil, err
	}

	var cell *driver.Cell
	if err := s.runner.Do(ctx, query.Op{
		ConnectionID: req.ConnectionID,
		Database:     req.Ref.Database,
		Kind:         activity.KindBrowse,
		SQL:          stmt.Display,
	}, func(qctx context.Context) error {
		var err error
		cell, err = driver.ReadCell(qctx, sess.DB, stmt.SQL, driver.MaxCellBytes, stmt.Args...)
		return err
	}); err != nil {
		return nil, err
	}
	cell.Query = stmt.Display
	return cell, nil
}

// qualify names an object the way the user sees it in the tree, so an activity
// row reads "describe auth.users" rather than an ambiguous bare table name.
func qualify(ref driver.ObjectRef) string {
	if ref.Schema == "" {
		return ref.Name
	}
	return ref.Schema + "." + ref.Name
}

func hasColumn(cols []driver.Column, name string) bool {
	for _, c := range cols {
		if c.Name == name {
			return true
		}
	}
	return false
}

type CountRowsRequest struct {
	ConnectionID string           `json:"connectionId"`
	Ref          driver.ObjectRef `json:"ref"`
	Filter       string           `json:"filter"`
}

// CountRows is deliberately separate from ReadRows: an exact COUNT(*) is slow
// on a large table and must not sit on the hot path of every page turn. The UI
// renders the page first and fills the total in behind it.
func (s *Service) CountRows(ctx context.Context, req CountRowsRequest) (int64, error) {
	sess, err := s.session(ctx, req.ConnectionID, req.Ref.Database)
	if err != nil {
		return 0, err
	}
	q := sess.Driver.BuildCount(req.Ref, req.Filter)

	var n int64
	if err := s.runner.Do(ctx, query.Op{
		ConnectionID: req.ConnectionID,
		Database:     req.Ref.Database,
		Kind:         activity.KindCount,
		SQL:          q,
	}, func(qctx context.Context) error {
		return sess.DB.QueryRowContext(qctx, q).Scan(&n)
	}); err != nil {
		return 0, err
	}
	return n, nil
}

// --- schema changes ----------------------------------------------------------------

// The three statements behind the object menu. Each is built by the dialect (see
// internal/driver/ddl.go) and run through the same middleware chain as
// everything else, so a truncate shows up in the activity log next to the
// queries around it — which for an irreversible statement is the point.
//
// None of the three asks for confirmation here. The confirmation is the UI's
// job, because only the UI knows whether the user has turned it off; by the time
// a call reaches this package the decision has been made.

type ObjectRequest struct {
	ConnectionID string           `json:"connectionId"`
	Ref          driver.ObjectRef `json:"ref"`
}

// TruncateTable empties a table. On SQLite this is a DELETE — see
// Capabilities.TruncateIsDelete.
func (s *Service) TruncateTable(ctx context.Context, req ObjectRequest) (*driver.ResultSet, error) {
	sess, err := s.session(ctx, req.ConnectionID, req.Ref.Database)
	if err != nil {
		return nil, err
	}
	stmt, err := sess.Driver.BuildTruncate(req.Ref)
	if err != nil {
		return nil, err
	}
	return s.exec(ctx, sess, req.ConnectionID, req.Ref.Database, stmt)
}

type DropObjectRequest struct {
	ConnectionID string            `json:"connectionId"`
	Ref          driver.ObjectRef  `json:"ref"`
	Type         driver.ObjectType `json:"type"`
}

// DropObject drops a table or view. Functions and procedures are refused by the
// driver rather than here, because whether they can be named in a DROP without
// their signature is a dialect question.
func (s *Service) DropObject(ctx context.Context, req DropObjectRequest) (*driver.ResultSet, error) {
	sess, err := s.session(ctx, req.ConnectionID, req.Ref.Database)
	if err != nil {
		return nil, err
	}
	stmt, err := sess.Driver.BuildDrop(req.Ref, req.Type)
	if err != nil {
		return nil, err
	}
	// Whatever was cached for this ref describes something that no longer
	// exists — and a table recreated under the same name inside the TTL would
	// otherwise be browsed with the dropped table's columns.
	s.columns.invalidate(req.ConnectionID, req.Ref)
	return s.exec(ctx, sess, req.ConnectionID, req.Ref.Database, stmt)
}

type CreateTableRequest struct {
	ConnectionID string                 `json:"connectionId"`
	Spec         driver.CreateTableSpec `json:"spec"`
}

func (s *Service) CreateTable(ctx context.Context, req CreateTableRequest) (*driver.ResultSet, error) {
	sess, err := s.session(ctx, req.ConnectionID, req.Spec.Ref.Database)
	if err != nil {
		return nil, err
	}
	stmt, err := sess.Driver.BuildCreateTable(req.Spec)
	if err != nil {
		return nil, err
	}
	s.columns.invalidate(req.ConnectionID, req.Spec.Ref)
	return s.exec(ctx, sess, req.ConnectionID, req.Spec.Ref.Database, stmt)
}

// PreviewCreateTable renders the statement without running it, for the dialog to
// show. It resolves the dialect from the saved connection rather than from a
// session, so it neither dials nor needs the connection to be open — and it
// deliberately does not go through the runner, since nothing is executed and an
// activity entry per keystroke would bury the log.
func (s *Service) PreviewCreateTable(req CreateTableRequest) (string, error) {
	cfg, err := s.store.DriverConfig(req.ConnectionID, "")
	if err != nil {
		return "", err
	}
	d, err := driver.Get(cfg.Kind)
	if err != nil {
		return "", err
	}
	return d.BuildCreateTable(req.Spec)
}

// exec is the shared tail of the three above: one statement, through the
// middleware, logged as DDL. The session is passed in because each caller has
// already resolved one to build the statement with.
func (s *Service) exec(ctx context.Context, sess *engine.Session, connID, database, stmt string) (*driver.ResultSet, error) {
	var rs *driver.ResultSet
	if err := s.runner.Do(ctx, query.Op{
		ConnectionID: connID,
		Database:     database,
		Kind:         activity.KindDDL,
		SQL:          stmt,
	}, func(qctx context.Context) error {
		var err error
		rs, err = driver.Exec(qctx, sess.DB, stmt)
		return err
	}); err != nil {
		return nil, err
	}
	return rs, nil
}

// --- SQL editor --------------------------------------------------------------------

type RunSQLRequest struct {
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database"`
	SQL          string `json:"sql"`
	// MaxRows caps the result; 0 uses driver.HardRowCap.
	MaxRows int `json:"maxRows"`
}

// RunSQLResult is what one run of the editor produced. A list because a batch
// is one round trip that can answer several times over — `use other_db;
// select …` is two statements and one of them has rows — and the editor shows
// a tab per result set.
type RunSQLResult struct {
	// Results holds every result set the batch produced, in order. Empty for a
	// batch that returned none: an INSERT reports through RowsAffected on a
	// single, column-less entry instead.
	Results []*driver.ResultSet `json:"results"`
	// MoreResults is set when the batch produced more result sets than
	// driver.MaxResultSets, so the UI can say the list was cut rather than
	// implying it is complete.
	MoreResults bool `json:"moreResults"`
}

func (s *Service) RunSQL(ctx context.Context, req RunSQLRequest) (*RunSQLResult, error) {
	stmt := strings.TrimSpace(req.SQL)
	if stmt == "" {
		return nil, fmt.Errorf("nothing to run")
	}
	sess, err := s.session(ctx, req.ConnectionID, req.Database)
	if err != nil {
		return nil, err
	}

	// Arbitrary SQL may have altered any table on this connection, so the whole
	// connection's metadata goes. Unconditionally, and on failure too: a batch
	// that errors partway may still have committed the ALTER before it. One
	// re-read on the next browse is a cheap price on a path this cold, and
	// guessing which tables a statement touched is not worth being wrong about.
	defer s.columns.invalidateConnection(req.ConnectionID)

	settings := s.settings.Get()
	maxRows := req.MaxRows
	if maxRows <= 0 {
		maxRows = settings.RowCap
	}

	out := &RunSQLResult{}
	if err := s.runner.Do(ctx, query.Op{
		ConnectionID: req.ConnectionID,
		Database:     req.Database,
		Kind:         activity.KindQuery,
		SQL:          stmt,
	}, func(qctx context.Context) error {
		// Any statement in the batch that returns rows sends the whole batch
		// down the query path: Exec would run it all and throw those rows
		// away, which is what `use db; select …` used to do.
		if batchReturnsRows(stmt) {
			// The editor's SQL is the user's own text and must not be
			// rewritten, so the text cap here is applied while scanning. It
			// keeps the grid responsive; it cannot keep the bytes off the wire.
			sets, more, err := driver.RunQueryAll(qctx, sess.DB, stmt, driver.QueryOptions{
				RowCap:  maxRows,
				TextCap: settings.TextCapChars,
			})
			out.Results, out.MoreResults = sets, more
			return err
		}
		rs, err := driver.Exec(qctx, sess.DB, stmt)
		if err != nil {
			return err
		}
		out.Results = []*driver.ResultSet{rs}
		return nil
	}); err != nil {
		return nil, err
	}
	if out.Results == nil {
		out.Results = []*driver.ResultSet{}
	}
	return out, nil
}

// batchReturnsRows is true when any statement in the text looks like it
// returns rows. The split is only ever used for this decision — the batch is
// always executed whole — so a split confused by exotic quoting costs nothing
// worse than the classification that was there before.
func batchReturnsRows(batch string) bool {
	for _, stmt := range splitStatements(batch) {
		if returnsRows(stmt) {
			return true
		}
	}
	return false
}

// splitStatements cuts a batch on semicolons that are not inside a string, a
// quoted identifier or a comment.
func splitStatements(batch string) []string {
	var out []string
	start := 0
	for i := 0; i < len(batch); i++ {
		switch batch[i] {
		case ';':
			out = append(out, batch[start:i])
			start = i + 1
		case '\'', '"', '`':
			if end := closingQuote(batch, i, batch[i]); end > i {
				i = end
			}
		case '[':
			if end := closingQuote(batch, i, ']'); end > i {
				i = end
			}
		case '-':
			if strings.HasPrefix(batch[i:], "--") {
				if nl := strings.IndexByte(batch[i:], '\n'); nl >= 0 {
					i += nl
				} else {
					i = len(batch)
				}
			}
		case '/':
			if strings.HasPrefix(batch[i:], "/*") {
				if end := strings.Index(batch[i+2:], "*/"); end >= 0 {
					i += 2 + end + 1
				} else {
					i = len(batch)
				}
			}
		}
	}
	return append(out, batch[min(start, len(batch)):])
}

// closingQuote finds the delimiter that closes the one at open. A doubled
// delimiter is an escaped one and does not close anything, which is true of
// ” in every dialect here and of "" and “ in the ones that use them.
func closingQuote(s string, open int, closer byte) int {
	for i := open + 1; i < len(s); i++ {
		if s[i] != closer {
			continue
		}
		if i+1 < len(s) && s[i+1] == closer {
			i++
			continue
		}
		return i
	}
	return len(s)
}

// returnsRows guesses from the leading keyword whether to use Query or Exec.
// Guessing is unavoidable without a per-dialect parser, and guessing wrong is
// cheap: an Exec'd SELECT returns no rows, and a Query'd INSERT still runs.
func returnsRows(stmt string) bool {
	stmt = trimLeadingNoise(stmt)
	word := stmt
	if i := strings.IndexAny(word, " \t\n\r(;"); i >= 0 {
		word = word[:i]
	}
	switch strings.ToUpper(word) {
	case "SELECT", "WITH", "SHOW", "PRAGMA", "EXPLAIN", "DESCRIBE", "DESC", "VALUES", "TABLE", "CALL":
		return true
	}
	return false
}

// trimLeadingNoise strips whitespace, comments and opening parentheses from
// the front of a statement, so the classifier sees the first real keyword in
// "-- note\nSELECT 1", "/* note */ SELECT 1" and "(SELECT 1) UNION …" alike.
func trimLeadingNoise(s string) string {
	for {
		s = strings.TrimSpace(s)
		switch {
		case strings.HasPrefix(s, "--"):
			nl := strings.IndexByte(s, '\n')
			if nl < 0 {
				return ""
			}
			s = s[nl+1:]
		case strings.HasPrefix(s, "/*"):
			end := strings.Index(s, "*/")
			if end < 0 {
				return ""
			}
			s = s[end+2:]
		case strings.HasPrefix(s, "("), strings.HasPrefix(s, ";"):
			// A leading semicolon is the T-SQL `;WITH cte AS (…)` idiom, which
			// is a query and must not be Exec'd.
			s = s[1:]
		default:
			return s
		}
	}
}

// --- internals ---------------------------------------------------------------------

// sessionDatabase is which database the pooled connection is opened against.
//
// The selected database, for every dialect that has databases at all. This used
// to be gated on Caps().DatabasePerConnection, which is true only for postgres,
// and the two questions are not the same one:
//
//   - DatabasePerConnection asks whether switching database *requires* a new
//     connection. For MySQL and SQL Server it does not — they reach other
//     databases through qualified names on one connection.
//   - This asks what the connection's *current* database should be, and the
//     answer is always the one the user picked.
//
// Conflating them left MySQL and SQL Server connections with no current
// database. Every path that generates its own SQL survived that, because the
// drivers qualify object names with the database (see mysqlDriver.target). The
// SQL editor does not and cannot: it runs the user's own text, so
// `select * from seq_orders` reached a connection with no default and MySQL
// answered "Error 1046 (3D000): No database selected".
//
// SQLite ignores the value — its DSN is the file — so no flag is needed for it.
//
// A pass-through, and named anyway: this is where a dialect exception would go,
// and the test that guards the invariant calls it.
func sessionDatabase(database string) string {
	return database
}

// session resolves a live connection.
func (s *Service) session(ctx context.Context, connID, database string) (*engine.Session, error) {
	return s.sessionWith(ctx, connID, database, nil)
}

// sessionWith is session for a caller that may hold a typed password. asked is
// read only for an ask-every-time connection, and only to open a new session:
// an existing one is reused without it. Without one, there is nothing to dial
// with, so it fails with ErrPasswordRequired rather than trying an empty password.
func (s *Service) sessionWith(ctx context.Context, connID, database string, asked *string) (*engine.Session, error) {
	conn, err := s.store.Get(connID)
	if err != nil {
		return nil, err
	}
	pw := ""
	if conn.AskPassword {
		if database == "" {
			database = conn.Database
		}
		if asked == nil {
			if !s.engine.Has(connID, sessionDatabase(database)) {
				return nil, ErrPasswordRequired
			}
		} else {
			pw = *asked
		}
	}
	cfg, err := s.store.DriverConfig(connID, pw)
	if err != nil {
		return nil, err
	}
	// No driver lookup here any more: Acquire does its own, and the dialect no
	// longer decides which database the session opens against.
	sess, err := s.engine.Acquire(ctx, connID, cfg, sessionDatabase(database))
	return sess, scrub(err, pw)
}

// scrub keeps a typed password out of an error on its way to the UI and the log.
func scrub(err error, secret string) error {
	if err == nil || secret == "" || !strings.Contains(err.Error(), secret) {
		return err
	}
	return errors.New(strings.ReplaceAll(err.Error(), secret, "***"))
}
