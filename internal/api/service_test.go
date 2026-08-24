package api

import (
	"context"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Cleancookie/ja-db/internal/activity"
	"github.com/Cleancookie/ja-db/internal/config"
	"github.com/Cleancookie/ja-db/internal/driver"
	"github.com/Cleancookie/ja-db/internal/engine"
)

// newService builds a Service over a real store, settings file, engine and
// activity registry rooted at dir.
func newService(t *testing.T, dir string) *Service {
	t.Helper()
	store, err := config.Open(dir)
	if err != nil {
		t.Fatalf("opening store: %v", err)
	}
	settings, err := config.OpenSettings(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatalf("opening settings: %v", err)
	}
	svc := New(store, settings, engine.New(), activity.New())
	t.Cleanup(svc.Shutdown)
	return svc
}

// newTestService wires the real store, engine and service against a throwaway
// SQLite file, so these tests exercise the whole stack rather than a mock.
func newTestService(t *testing.T) (*Service, string) {
	t.Helper()
	dir := t.TempDir()
	svc := newService(t, dir)

	conn, err := svc.SaveConnection(SaveConnectionRequest{
		Connection: config.Connection{
			Name: "test",
			Kind: driver.KindSQLite,
			File: filepath.Join(dir, "test.db"),
		},
	})
	if err != nil {
		t.Fatalf("saving connection: %v", err)
	}
	return svc, conn.ID
}

// runOne runs a batch expected to produce exactly one result set and returns
// it, so tests that predate multi-result batches read as they did.
func runOne(t *testing.T, svc *Service, id, sql string) *driver.ResultSet {
	t.Helper()
	res, err := svc.RunSQL(context.Background(), RunSQLRequest{ConnectionID: id, SQL: sql})
	if err != nil {
		t.Fatalf("running %q: %v", sql, err)
	}
	if len(res.Results) != 1 {
		t.Fatalf("running %q gave %d result sets, want 1", sql, len(res.Results))
	}
	return res.Results[0]
}

func mustRun(t *testing.T, svc *Service, id, sql string) {
	t.Helper()
	if _, err := svc.RunSQL(context.Background(), RunSQLRequest{ConnectionID: id, SQL: sql}); err != nil {
		t.Fatalf("running %q: %v", sql, err)
	}
}

func seed(t *testing.T, svc *Service, id string, rows int) {
	t.Helper()
	mustRun(t, svc, id, `CREATE TABLE orders (
		id INTEGER PRIMARY KEY,
		customer TEXT NOT NULL,
		total REAL,
		note TEXT
	)`)
	mustRun(t, svc, id, `CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100`)
	for i := 1; i <= rows; i++ {
		mustRun(t, svc, id, fmt.Sprintf(
			`INSERT INTO orders (id, customer, total, note) VALUES (%d, 'cust-%d', %d.5, NULL)`,
			i, i%3, i*10))
	}
}

func TestConnectListsTheSQLiteFileAsOneDatabase(t *testing.T) {
	svc, id := newTestService(t)
	res, err := svc.Connect(context.Background(), id)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if res.Capabilities.ServerHostsDatabases {
		t.Error("SQLite should not advertise a server-hosted database list")
	}
	if len(res.Databases) != 1 || res.Databases[0].Name != "main" {
		t.Errorf("got %v, want exactly [main]", res.Databases)
	}
}

func TestListObjectsSeparatesTablesFromViews(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 3)

	objs, err := svc.ListObjects(context.Background(), id, "main")
	if err != nil {
		t.Fatalf("list objects: %v", err)
	}
	kinds := map[string]driver.ObjectType{}
	for _, o := range objs {
		kinds[o.Name] = o.Type
	}
	if kinds["orders"] != driver.ObjectTable {
		t.Errorf("orders typed as %q, want table", kinds["orders"])
	}
	if kinds["big_orders"] != driver.ObjectView {
		t.Errorf("big_orders typed as %q, want view", kinds["big_orders"])
	}
}

func TestListColumnsReportsKeysAndNullability(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 1)

	cols, err := svc.ListColumns(context.Background(), id,
		driver.ObjectRef{Database: "main", Name: "orders"})
	if err != nil {
		t.Fatalf("list columns: %v", err)
	}
	if len(cols) != 4 {
		t.Fatalf("got %d columns, want 4", len(cols))
	}
	if !cols[0].PrimaryKey {
		t.Error("id was not reported as the primary key")
	}
	if cols[1].Nullable {
		t.Error("customer is NOT NULL but was reported nullable")
	}
	if !cols[3].Nullable {
		t.Error("note is nullable but was reported otherwise")
	}
}

// Paging must not overlap or skip. Walking every page and collecting ids is
// the only check that actually catches an off-by-one in the offset maths.
func TestPaginationWalksEveryRowExactlyOnce(t *testing.T) {
	svc, id := newTestService(t)
	const total = 25
	seed(t, svc, id, total)

	seen := map[any]bool{}
	page := 1
	for {
		res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
			ConnectionID: id,
			Ref:          driver.ObjectRef{Database: "main", Name: "orders"},
			OrderBy:      []driver.Sort{{Column: "id"}},
			Pagination:   Pagination{Enabled: true, Page: page, PageSize: 10},
		})
		if err != nil {
			t.Fatalf("page %d: %v", page, err)
		}
		for _, row := range res.Result.Rows {
			if seen[row[0]] {
				t.Errorf("row %v appeared on more than one page", row[0])
			}
			seen[row[0]] = true
		}
		if !res.HasMore {
			break
		}
		page++
		if page > 10 {
			t.Fatal("HasMore never went false — pagination is not terminating")
		}
	}
	if len(seen) != total {
		t.Errorf("saw %d distinct rows across %d pages, want %d", len(seen), page, total)
	}
}

// HasMore is derived from an extra fetched row, so the boundary where the last
// page is exactly full is the case most likely to be wrong.
func TestHasMoreIsFalseOnAnExactlyFullFinalPage(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 20)

	res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID: id,
		Ref:          driver.ObjectRef{Database: "main", Name: "orders"},
		OrderBy:      []driver.Sort{{Column: "id"}},
		Pagination:   Pagination{Enabled: true, Page: 2, PageSize: 10},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Result.Rows) != 10 {
		t.Errorf("got %d rows, want a full page of 10", len(res.Result.Rows))
	}
	if res.HasMore {
		t.Error("HasMore is true on the final page")
	}
}

// The extra row fetched to compute HasMore must never reach the caller.
func TestPageNeverReturnsMoreRowsThanRequested(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 50)

	res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID: id,
		Ref:          driver.ObjectRef{Database: "main", Name: "orders"},
		Pagination:   Pagination{Enabled: true, Page: 1, PageSize: 7},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Result.Rows) != 7 {
		t.Errorf("got %d rows, want exactly the requested 7", len(res.Result.Rows))
	}
	if !res.HasMore {
		t.Error("HasMore should be true with 50 rows and a page size of 7")
	}
}

func TestPaginationOffReturnsEverything(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 40)

	res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID: id,
		Ref:          driver.ObjectRef{Database: "main", Name: "orders"},
		Pagination:   Pagination{Enabled: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Result.Rows) != 40 {
		t.Errorf("got %d rows, want all 40", len(res.Result.Rows))
	}
	if res.HasMore {
		t.Error("HasMore is meaningless with pagination off and should be false")
	}
}

func TestFilterIsAppliedAndCounted(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 30)
	ref := driver.ObjectRef{Database: "main", Name: "orders"}

	// total is i*10+0.5 for i in 1..30, so this matches i = 20..30: 11 rows.
	const filter = "total > 200"
	const want = 11

	res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID: id, Ref: ref, Filter: filter,
		Pagination: Pagination{Enabled: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Result.Rows) != want {
		t.Errorf("filter returned %d rows, want %d", len(res.Result.Rows), want)
	}

	n, err := svc.CountRows(context.Background(), CountRowsRequest{
		ConnectionID: id, Ref: ref, Filter: filter,
	})
	if err != nil {
		t.Fatal(err)
	}
	if n != want {
		t.Errorf("count returned %d, want %d — count and read disagree", n, want)
	}
}

// A bad filter is normal usage, not an app error: the database message has to
// reach the user intact so they can fix their expression.
func TestBadFilterSurfacesTheDatabaseError(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 2)

	_, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID: id,
		Ref:          driver.ObjectRef{Database: "main", Name: "orders"},
		Filter:       "total >>> 100",
	})
	if err == nil {
		t.Fatal("expected a syntax error")
	}
	if len(err.Error()) == 0 {
		t.Error("error message is empty; the user has nothing to act on")
	}
}

func TestBrowsingAViewWorks(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 30)

	res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID: id,
		Ref:          driver.ObjectRef{Database: "main", Name: "big_orders"},
		Pagination:   Pagination{Enabled: true, Page: 1, PageSize: 100},
	})
	if err != nil {
		t.Fatalf("reading a view: %v", err)
	}
	// The view is total > 100, and total is i*10+0.5, so i = 10..30: 21 rows.
	if len(res.Result.Rows) != 21 {
		t.Errorf("got %d rows from the view, want 21", len(res.Result.Rows))
	}
}

func TestNullsAreDistinctFromEmptyStrings(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 1)
	mustRun(t, svc, id, `INSERT INTO orders (id, customer, total, note) VALUES (99, 'x', 1, '')`)

	res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID: id,
		Ref:          driver.ObjectRef{Database: "main", Name: "orders"},
		OrderBy:      []driver.Sort{{Column: "id"}},
		Pagination:   Pagination{Enabled: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Result.Rows[0][3]; got != nil {
		t.Errorf("NULL note came back as %#v, want nil", got)
	}
	if got := res.Result.Rows[1][3]; got != "" {
		t.Errorf("empty-string note came back as %#v, want an empty string", got)
	}
}

func TestRunSQLDistinguishesQueriesFromStatements(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 5)

	q := runOne(t, svc, id, "SELECT id, customer FROM orders ORDER BY id")
	if len(q.Rows) != 5 || len(q.Columns) != 2 {
		t.Errorf("got %d rows / %d cols, want 5/2", len(q.Rows), len(q.Columns))
	}
	if q.RowsAffected != nil {
		t.Error("a SELECT should not report rows affected")
	}

	e := runOne(t, svc, id, "UPDATE orders SET note = 'seen'")
	if e.RowsAffected == nil || *e.RowsAffected != 5 {
		t.Errorf("got %v rows affected, want 5", e.RowsAffected)
	}
}

func TestReturnsRowsClassifier(t *testing.T) {
	queries := []string{
		"SELECT 1", "select 1", "  \n SELECT 1", "WITH x AS (SELECT 1) SELECT * FROM x",
		"-- a comment\nSELECT 1", "PRAGMA table_info(t)", "EXPLAIN SELECT 1", "(SELECT 1)",
		";WITH x AS (SELECT 1) SELECT * FROM x",
	}
	for _, q := range queries {
		if !returnsRows(q) {
			t.Errorf("%q was not classified as a query", q)
		}
	}
	statements := []string{
		"INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t",
		"CREATE TABLE t (a int)", "DROP TABLE t", "-- only a comment",
	}
	for _, s := range statements {
		if returnsRows(s) {
			t.Errorf("%q was misclassified as a query", s)
		}
	}
}

// --- the text cap and the full-value fetch -----------------------------------------

// seedDocs makes a table with one long text column and one JSON column, each
// holding far more than any sane cap.
func seedDocs(t *testing.T, svc *Service, id string, size int) {
	t.Helper()
	mustRun(t, svc, id, `CREATE TABLE docs (
		id INTEGER PRIMARY KEY,
		name VARCHAR(64),
		body TEXT,
		doc JSON
	)`)
	body := strings.Repeat("x", size)
	for i := 1; i <= 3; i++ {
		mustRun(t, svc, id, fmt.Sprintf(
			`INSERT INTO docs (id, name, body, doc) VALUES (%d, 'doc-%d', '%s', '{"n":%d,"pad":"%s"}')`,
			i, i, body, i, body))
	}
}

func setTextCap(t *testing.T, svc *Service, n int) {
	t.Helper()
	s := svc.GetSettings()
	s.TextCapChars = n
	if _, err := svc.SaveSettings(s); err != nil {
		t.Fatalf("saving settings: %v", err)
	}
}

// The cap must be applied by the database, not after the fetch — otherwise the
// megabytes have already crossed the wire and only the rendering is saved.
func TestLongValuesAreCappedInTheEmittedSQL(t *testing.T) {
	svc, id := newTestService(t)
	seedDocs(t, svc, id, 5000)
	setTextCap(t, svc, 64)

	res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID: id,
		Ref:          driver.ObjectRef{Database: "main", Name: "docs"},
		OrderBy:      []driver.Sort{{Column: "id"}},
		Pagination:   Pagination{Enabled: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Result.Query, `substr("body", 1, 65)`) {
		t.Errorf("the cap is not in the query: %q", res.Result.Query)
	}
	if strings.Contains(res.Result.Query, `substr("name"`) {
		t.Errorf("a varchar(64) was capped needlessly: %q", res.Result.Query)
	}
	for _, col := range []int{2, 3} {
		got, ok := res.Result.Rows[0][col].(string)
		if !ok {
			t.Fatalf("column %d came back as %T", col, res.Result.Rows[0][col])
		}
		if len(got) != 64 {
			t.Errorf("column %d is %d characters, want the 64 it was capped to", col, len(got))
		}
	}
	// Short columns must be untouched, and every cut cell must be reported.
	if res.Result.Rows[0][1] != "doc-1" {
		t.Errorf("short value was altered: %#v", res.Result.Rows[0][1])
	}
	if res.Result.TextCap != 64 {
		t.Errorf("TextCap reported as %d, want 64", res.Result.TextCap)
	}
	if len(res.Result.TruncatedCells) != 6 {
		t.Errorf("got %d truncated cells, want 6 (two columns × three rows): %v",
			len(res.Result.TruncatedCells), res.Result.TruncatedCells)
	}
}

// Truncation that the grid cannot see is worse than no truncation at all: the
// user would read a cut value as the whole one.
func TestTruncationIsReportedPerCell(t *testing.T) {
	svc, id := newTestService(t)
	seedDocs(t, svc, id, 5000)
	setTextCap(t, svc, 64)
	// A value shorter than the cap must not be flagged.
	mustRun(t, svc, id, `INSERT INTO docs (id, name, body, doc) VALUES (9, 'short', 'tiny', '{}')`)

	res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID: id,
		Ref:          driver.ObjectRef{Database: "main", Name: "docs"},
		Filter:       "id = 9",
		Pagination:   Pagination{Enabled: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Result.TruncatedCells) != 0 {
		t.Errorf("short values were flagged as truncated: %v", res.Result.TruncatedCells)
	}
}

func TestTextCapOfZeroLeavesValuesWhole(t *testing.T) {
	svc, id := newTestService(t)
	seedDocs(t, svc, id, 5000)
	setTextCap(t, svc, 0)

	res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID: id,
		Ref:          driver.ObjectRef{Database: "main", Name: "docs"},
		Pagination:   Pagination{Enabled: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(res.Result.Query, "substr") {
		t.Errorf("cap disabled but still emitted: %q", res.Result.Query)
	}
	if got := res.Result.Rows[0][2].(string); len(got) != 5000 {
		t.Errorf("got %d characters, want the whole 5000", len(got))
	}
}

// The editor's SQL must not be rewritten, so there the cap is applied while
// scanning. The rows still have to arrive capped and flagged.
func TestAdHocSQLIsCappedWhileScanning(t *testing.T) {
	svc, id := newTestService(t)
	seedDocs(t, svc, id, 5000)
	setTextCap(t, svc, 32)

	res := runOne(t, svc, id, "SELECT body FROM docs ORDER BY id")
	if res.Query != "SELECT body FROM docs ORDER BY id" {
		t.Errorf("the user's statement was rewritten: %q", res.Query)
	}
	if got := res.Rows[0][0].(string); len(got) != 32 {
		t.Errorf("got %d characters, want 32", len(got))
	}
	if len(res.TruncatedCells) != 3 {
		t.Errorf("got %d truncated cells, want 3", len(res.TruncatedCells))
	}
}

// The cap is only bearable because a single cell can still be had in full.
func TestReadCellReturnsTheWholeValue(t *testing.T) {
	svc, id := newTestService(t)
	seedDocs(t, svc, id, 5000)
	setTextCap(t, svc, 64)
	ref := driver.ObjectRef{Database: "main", Name: "docs"}

	cell, err := svc.ReadCell(context.Background(), ReadCellRequest{
		ConnectionID: id, Ref: ref, Column: "body",
		OrderBy: []driver.Sort{{Column: "id"}}, RowOffset: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if cell.Value == nil {
		t.Fatal("value is NULL, want 5000 characters")
	}
	if len(*cell.Value) != 5000 {
		t.Errorf("got %d characters, want the whole 5000", len(*cell.Value))
	}
	if cell.Bytes != 5000 {
		t.Errorf("Bytes = %d, want 5000", cell.Bytes)
	}
	if cell.Truncated {
		t.Error("a 5000-character value should not hit MaxCellBytes")
	}
}

// The offset is in the coordinates of the filtered, sorted result the grid is
// showing. Fetching the wrong row would hand the user someone else's data.
func TestReadCellHonoursFilterAndSort(t *testing.T) {
	svc, id := newTestService(t)
	seedDocs(t, svc, id, 10)
	ref := driver.ObjectRef{Database: "main", Name: "docs"}

	cell, err := svc.ReadCell(context.Background(), ReadCellRequest{
		ConnectionID: id, Ref: ref, Column: "name",
		Filter: "id > 1", OrderBy: []driver.Sort{{Column: "id", Desc: true}},
		RowOffset: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	// id > 1 descending is [3, 2]; offset 1 is id 2.
	if cell.Value == nil || *cell.Value != "doc-2" {
		t.Errorf("got %v, want doc-2", cell.Value)
	}
}

// NULL and "" have to stay apart here as much as they do in the grid.
func TestReadCellDistinguishesNullFromEmpty(t *testing.T) {
	svc, id := newTestService(t)
	seedDocs(t, svc, id, 10)
	mustRun(t, svc, id, `INSERT INTO docs (id, name, body) VALUES (10, '', NULL)`)
	ref := driver.ObjectRef{Database: "main", Name: "docs"}

	null, err := svc.ReadCell(context.Background(), ReadCellRequest{
		ConnectionID: id, Ref: ref, Column: "body",
		OrderBy: []driver.Sort{{Column: "id"}}, RowOffset: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if null.Value != nil {
		t.Errorf("NULL came back as %#v", *null.Value)
	}

	empty, err := svc.ReadCell(context.Background(), ReadCellRequest{
		ConnectionID: id, Ref: ref, Column: "name",
		OrderBy: []driver.Sort{{Column: "id"}}, RowOffset: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	if empty.Value == nil || *empty.Value != "" {
		t.Errorf("empty string came back as %v", empty.Value)
	}
}

func TestReadCellRejectsAnUnknownColumn(t *testing.T) {
	svc, id := newTestService(t)
	seedDocs(t, svc, id, 10)

	_, err := svc.ReadCell(context.Background(), ReadCellRequest{
		ConnectionID: id,
		Ref:          driver.ObjectRef{Database: "main", Name: "docs"},
		Column:       "body; drop table docs",
		RowOffset:    0,
	})
	if err == nil {
		t.Fatal("expected an error for a column that does not exist")
	}
	// And the table is still there — the name was never interpolated raw.
	if _, err := svc.RunSQL(context.Background(), RunSQLRequest{
		ConnectionID: id, SQL: "SELECT count(*) FROM docs",
	}); err != nil {
		t.Fatalf("docs is gone: %v", err)
	}
}

// A row that has moved on is normal on a live table; the message has to say so
// rather than leaking "sql: no rows in result set".
func TestReadCellPastTheEndExplainsItself(t *testing.T) {
	svc, id := newTestService(t)
	seedDocs(t, svc, id, 10)

	_, err := svc.ReadCell(context.Background(), ReadCellRequest{
		ConnectionID: id,
		Ref:          driver.ObjectRef{Database: "main", Name: "docs"},
		Column:       "body",
		RowOffset:    999,
	})
	if err == nil {
		t.Fatal("expected an error past the end of the result")
	}
	if strings.Contains(err.Error(), "sql: no rows") {
		t.Errorf("raw driver error surfaced: %v", err)
	}
}

// Deleting a connection must take its stored password with it.
func TestDeletingAConnectionRemovesItsPassword(t *testing.T) {
	dir := t.TempDir()
	svc := newService(t, dir)
	store := svc.store

	pw := "hunter2"
	conn, err := svc.SaveConnection(SaveConnectionRequest{
		Connection: config.Connection{
			Name: "pg", Kind: driver.KindPostgres, Host: "localhost",
		},
		Password: &pw,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := store.Password(conn.ID); got != pw {
		t.Fatalf("password not stored, got %q", got)
	}
	if err := svc.DeleteConnection(conn.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.Password(conn.ID); got != "" {
		t.Errorf("password %q survived deletion of the connection", got)
	}
}

// Editing a connection without retyping the password must not blank it.
func TestUpdateWithoutPasswordKeepsTheStoredOne(t *testing.T) {
	dir := t.TempDir()
	svc := newService(t, dir)
	store := svc.store

	pw := "hunter2"
	conn, err := svc.SaveConnection(SaveConnectionRequest{
		Connection: config.Connection{Name: "pg", Kind: driver.KindPostgres, Host: "localhost"},
		Password:   &pw,
	})
	if err != nil {
		t.Fatal(err)
	}

	conn.Name = "pg renamed"
	if _, err := svc.SaveConnection(SaveConnectionRequest{Connection: conn}); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.Password(conn.ID); got != pw {
		t.Errorf("password is now %q; an edit erased it", got)
	}
}

// Connections must survive a restart — the store is reopened from disk here.
func TestConnectionsPersistAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	svc := newService(t, dir)
	pw := "s3cret"
	if _, err := svc.SaveConnection(SaveConnectionRequest{
		Connection: config.Connection{Name: "keeper", Kind: driver.KindMySQL, Host: "db.internal"},
		Password:   &pw,
	}); err != nil {
		t.Fatal(err)
	}
	svc.Shutdown()

	reopened, err := config.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	conns := reopened.List()
	if len(conns) != 1 || conns[0].Name != "keeper" {
		t.Fatalf("got %v after restart, want the saved connection", conns)
	}
	if got, _ := reopened.Password(conns[0].ID); got != pw {
		t.Errorf("password did not survive restart, got %q", got)
	}
}

// --- activity ----------------------------------------------------------------------

// The phases the tray shows are instrumented, not inferred, so they are worth
// asserting through the whole stack: api -> driver -> registry.
func TestActivityRecordsFinishedQueriesWithTheirPhase(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 3)

	if _, err := svc.RunSQL(context.Background(), RunSQLRequest{
		ConnectionID: id,
		SQL:          "SELECT * FROM orders",
	}); err != nil {
		t.Fatalf("select: %v", err)
	}

	got := svc.Activity().Queries
	if len(got) == 0 {
		t.Fatal("Activity() reported no queries; the history is empty")
	}
	// Newest first, and nothing is still running by the time RunSQL returns.
	latest := got[0]
	if latest.Phase != activity.PhaseDone {
		t.Fatalf("Phase = %q, want %q", latest.Phase, activity.PhaseDone)
	}
	if latest.SQL != "SELECT * FROM orders" {
		t.Fatalf("SQL = %q, want the statement that ran", latest.SQL)
	}
	// The row counter is what makes "reading rows" informative.
	if latest.RowsRead != 3 {
		t.Errorf("RowsRead = %d, want 3", latest.RowsRead)
	}
}

func TestActivityRecordsFailuresWithTheDatabaseMessage(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 1)

	if _, err := svc.RunSQL(context.Background(), RunSQLRequest{
		ConnectionID: id,
		SQL:          "SELECT nope FROM orders",
	}); err == nil {
		t.Fatal("expected the bad column to error")
	}

	latest := svc.Activity().Queries[0]
	if latest.Phase != activity.PhaseFailed || latest.Error == "" {
		t.Fatalf("got %+v, want a failed entry carrying the database's message", latest)
	}
}

// Catalogue reads reach the log like anything else. They were dropped once, and
// the effect was a log the user could not trust: a describe ran, was visible for
// a few milliseconds, and left no trace. The tray hides them from the *view* by
// default, which is reversible; dropping the data was not.
func TestActivityRecordsIntrospection(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 1)
	svc.ClearQueryHistory()

	if _, err := svc.ListColumns(context.Background(), id,
		driver.ObjectRef{Name: "orders"}); err != nil {
		t.Fatalf("list columns: %v", err)
	}

	got := svc.Activity().Queries
	if len(got) != 1 {
		t.Fatalf("Activity() = %+v, want the describe recorded", got)
	}
	if got[0].Kind != activity.KindIntrospect || got[0].Phase != activity.PhaseDone {
		t.Fatalf("got %+v, want a done introspect entry", got[0])
	}
	// The label names the object, so the row is identifiable in the tray.
	if !strings.Contains(got[0].SQL, "orders") {
		t.Fatalf("SQL = %q, want it to name the object described", got[0].SQL)
	}
}

// Every path through Service goes via the query runner, so anything it runs is
// tracked. This is the guard against a new method quietly bypassing it: the
// count query is separate from the browse, and both must be recorded.
func TestBrowsingRecordsEveryQueryItRuns(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 3)
	svc.ClearQueryHistory()

	ref := driver.ObjectRef{Name: "orders"}
	if _, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID: id,
		Ref:          ref,
		Pagination:   Pagination{Enabled: true, Page: 1, PageSize: 10},
	}); err != nil {
		t.Fatalf("read rows: %v", err)
	}
	if _, err := svc.CountRows(context.Background(), CountRowsRequest{
		ConnectionID: id, Ref: ref,
	}); err != nil {
		t.Fatalf("count rows: %v", err)
	}

	kinds := map[activity.Kind]bool{}
	for _, q := range svc.Activity().Queries {
		kinds[q.Kind] = true
	}
	for _, want := range []activity.Kind{activity.KindBrowse, activity.KindCount, activity.KindIntrospect} {
		if !kinds[want] {
			t.Errorf("no %q entry in the log; a call is bypassing the runner", want)
		}
	}
}

func TestClearQueryHistoryEmptiesTheLog(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 1)
	if len(svc.Activity().Queries) == 0 {
		t.Fatal("seeding should have left history behind")
	}

	svc.ClearQueryHistory()
	if got := svc.Activity().Queries; len(got) != 0 {
		t.Fatalf("Activity() = %+v after clearing, want empty", got)
	}
}

// A table browse with no sort chosen must come back newest-first on the
// primary key, and must say so, or the grid cannot mark the header and
// ReadCell cannot address the same row.
func TestReadRowsDefaultsToPrimaryKeyDescending(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 5)

	res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID:     id,
		Ref:              driver.ObjectRef{Database: "main", Name: "orders"},
		ApplyDefaultSort: true,
		Pagination:       Pagination{Enabled: true, Page: 1, PageSize: 10},
	})
	if err != nil {
		t.Fatalf("reading rows: %v", err)
	}
	want := []driver.Sort{{Column: "id", Desc: true}}
	if !reflect.DeepEqual(res.OrderBy, want) {
		t.Errorf("effective sort = %v, want %v", res.OrderBy, want)
	}
	if got := res.Result.Rows[0][0]; fmt.Sprint(got) != "5" {
		t.Errorf("first row id = %v, want the highest id", got)
	}
}

// An explicit sort is never second-guessed.
func TestReadRowsKeepsTheSortItWasGiven(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 5)

	res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID: id,
		Ref:          driver.ObjectRef{Database: "main", Name: "orders"},
		OrderBy:      []driver.Sort{{Column: "id"}},
		Pagination:   Pagination{Enabled: true, Page: 1, PageSize: 10},
	})
	if err != nil {
		t.Fatalf("reading rows: %v", err)
	}
	if got := res.Result.Rows[0][0]; fmt.Sprint(got) != "1" {
		t.Errorf("first row id = %v, want the lowest id", got)
	}
}

// A view has no primary key, so there is nothing to default to and the browse
// must still work.
func TestReadRowsHasNoDefaultSortWithoutAPrimaryKey(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 5)

	res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID:     id,
		Ref:              driver.ObjectRef{Database: "main", Name: "big_orders"},
		ApplyDefaultSort: true,
		Pagination:       Pagination{Enabled: true, Page: 1, PageSize: 10},
	})
	if err != nil {
		t.Fatalf("reading the view: %v", err)
	}
	if len(res.OrderBy) != 0 {
		t.Errorf("invented a sort for a view: %v", res.OrderBy)
	}
}

// Cycling the sort off is not the same as never having chosen one: the user
// asked for the engine's own order and must not be given the default back.
func TestReadRowsLeavesAnEmptySortEmptyWhenNotAskedToDefault(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 5)

	res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID: id,
		Ref:          driver.ObjectRef{Database: "main", Name: "orders"},
		Pagination:   Pagination{Enabled: true, Page: 1, PageSize: 10},
	})
	if err != nil {
		t.Fatalf("reading rows: %v", err)
	}
	if len(res.OrderBy) != 0 {
		t.Errorf("sorted anyway: %v", res.OrderBy)
	}
	if strings.Contains(res.Result.Query, "ORDER BY") {
		t.Errorf("emitted an ORDER BY: %q", res.Result.Query)
	}
}

// The bug this replaced: a batch was classified on its first keyword, so
// `use db; select …` was Exec'd and the rows were thrown away.
func TestBatchWithAQueryAnywhereReturnsItsRows(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 3)

	res, err := svc.RunSQL(context.Background(), RunSQLRequest{
		ConnectionID: id,
		SQL:          "PRAGMA foreign_keys; SELECT id FROM orders ORDER BY id",
	})
	if err != nil {
		t.Fatalf("running the batch: %v", err)
	}
	last := res.Results[len(res.Results)-1]
	if len(last.Rows) != 3 {
		t.Errorf("got %d rows from the batch, want 3", len(last.Rows))
	}
}

func TestSplitStatements(t *testing.T) {
	cases := []struct {
		in   string
		want int
	}{
		{"SELECT 1", 1},
		{"use db; select 1", 2},
		{"select ';' ; select 2", 2},
		{"select \"a;b\" from t", 1},
		{"select [a;b] from t", 1},
		{"-- ; not a split\nselect 1", 1},
		{"/* ; */ select 1", 1},
		{"select 'it''s ; fine'", 1},
	}
	for _, c := range cases {
		if got := len(splitStatements(c.in)); got != c.want {
			t.Errorf("splitStatements(%q) gave %d statements, want %d", c.in, got, c.want)
		}
	}
}

func TestBatchReturnsRows(t *testing.T) {
	yes := []string{
		"use db; select 1",
		"SET NOCOUNT ON;\nSELECT 1",
		"insert into t values (1); select * from t",
	}
	for _, b := range yes {
		if !batchReturnsRows(b) {
			t.Errorf("%q has a query in it and was not treated as one", b)
		}
	}
	no := []string{"insert into t values (1); update t set a = 2", "use db;"}
	for _, b := range no {
		if batchReturnsRows(b) {
			t.Errorf("%q returns no rows but was treated as a query", b)
		}
	}
}
