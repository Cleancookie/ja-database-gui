// Package api is the whole application surface. It knows nothing about Wails
// or HTTP; both transports are thin pass-throughs to the methods here.
package api

import (
	"context"
	"fmt"
	"log"
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
	}
}

// logQuery is the default log sink: one line per finished query, at a level
// that depends on the outcome. Deliberately plain `log` — this app has no
// logging framework and a query log is not a reason to add one.
func logQuery(e query.Entry) {
	switch {
	case e.Err != nil:
		log.Printf("query %s %s db=%q failed in %s: %v",
			e.Op.ID, e.Op.Kind, e.Op.Database, e.Elapsed.Round(time.Millisecond), e.Err)
	case e.RowsRead > 0:
		log.Printf("query %s %s db=%q %d rows in %s",
			e.Op.ID, e.Op.Kind, e.Op.Database, e.RowsRead, e.Elapsed.Round(time.Millisecond))
	default:
		log.Printf("query %s %s db=%q ok in %s",
			e.Op.ID, e.Op.Kind, e.Op.Database, e.Elapsed.Round(time.Millisecond))
	}
}

func (s *Service) Shutdown() { s.engine.Shutdown() }

// --- settings ----------------------------------------------------------------------

func (s *Service) GetSettings() config.Settings { return s.settings.Get() }

func (s *Service) SaveSettings(v config.Settings) (config.Settings, error) {
	return s.settings.Set(v)
}

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
	} else if c.ID != "" {
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
	return s.engine.Test(ctx, cfg)
}

// ConnectResult is everything the UI needs to populate the sidebar after a
// successful connect.
type ConnectResult struct {
	Capabilities    driver.Capabilities `json:"capabilities"`
	Databases       []driver.Database   `json:"databases"`
	DefaultDatabase string              `json:"defaultDatabase"`
}

func (s *Service) Connect(ctx context.Context, connID string) (*ConnectResult, error) {
	conn, err := s.store.Get(connID)
	if err != nil {
		return nil, err
	}
	d, err := driver.Get(conn.Kind)
	if err != nil {
		return nil, err
	}
	caps := d.Caps()

	sess, err := s.session(ctx, connID, conn.Database)
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

func (s *Service) ListColumns(ctx context.Context, connID string, ref driver.ObjectRef) ([]driver.Column, error) {
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
	return cols, nil
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
}

type ReadRowsResult struct {
	Result  *driver.ResultSet `json:"result"`
	Columns []driver.Column   `json:"columns"`
	Page    int               `json:"page"`
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
	opts := driver.ReadOptions{
		Filter:  req.Filter,
		OrderBy: orderBy,
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

	// Named stmt, not query: `query` is the package that runs it.
	stmt, err := sess.Driver.BuildSelect(req.Ref, opts, cols)
	if err != nil {
		return nil, err
	}

	var rs *driver.ResultSet
	if err := s.runner.Do(ctx, query.Op{
		ConnectionID: req.ConnectionID,
		Database:     req.Ref.Database,
		Kind:         activity.KindBrowse,
		SQL:          stmt,
	}, func(qctx context.Context) error {
		var err error
		rs, err = driver.RunQuery(qctx, sess.DB, stmt, driver.QueryOptions{
			RowCap:  settings.RowCap,
			TextCap: settings.TextCapChars,
		})
		return err
	}); err != nil {
		return nil, err
	}

	out := &ReadRowsResult{Result: rs, Columns: cols, Page: page, OrderBy: orderBy}
	if req.Pagination.Enabled {
		size := opts.Limit - 1
		if len(rs.Rows) > size {
			out.HasMore = true
			rs.Rows = rs.Rows[:size]
		}
	}
	return out, nil
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

	// TextCap is deliberately absent: this call exists to defeat it.
	stmt, err := sess.Driver.BuildSelect(req.Ref, driver.ReadOptions{
		Filter:  req.Filter,
		OrderBy: orderBy,
		Select:  []string{req.Column},
		Limit:   1,
		Offset:  req.RowOffset,
	}, cols)
	if err != nil {
		return nil, err
	}

	var cell *driver.Cell
	if err := s.runner.Do(ctx, query.Op{
		ConnectionID: req.ConnectionID,
		Database:     req.Ref.Database,
		Kind:         activity.KindBrowse,
		SQL:          stmt,
	}, func(qctx context.Context) error {
		var err error
		cell, err = driver.ReadCell(qctx, sess.DB, stmt, driver.MaxCellBytes)
		return err
	}); err != nil {
		return nil, err
	}
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
	return s.exec(ctx, sess, req.ConnectionID, req.Spec.Ref.Database, stmt)
}

// PreviewCreateTable renders the statement without running it, for the dialog to
// show. It resolves the dialect from the saved connection rather than from a
// session, so it neither dials nor needs the connection to be open — and it
// deliberately does not go through the runner, since nothing is executed and an
// activity entry per keystroke would bury the log.
func (s *Service) PreviewCreateTable(req CreateTableRequest) (string, error) {
	cfg, err := s.store.DriverConfig(req.ConnectionID)
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

// session resolves a live connection. For dialects that reach other databases
// through qualified names, database is left off the session key so a single
// connection serves the whole server.
func (s *Service) session(ctx context.Context, connID, database string) (*engine.Session, error) {
	cfg, err := s.store.DriverConfig(connID)
	if err != nil {
		return nil, err
	}
	d, err := driver.Get(cfg.Kind)
	if err != nil {
		return nil, err
	}
	target := ""
	if d.Caps().DatabasePerConnection {
		target = database
	}
	return s.engine.Acquire(ctx, connID, cfg, target)
}
