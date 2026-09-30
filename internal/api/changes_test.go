package api

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/Cleancookie/ja-db/internal/activity"
	"github.com/Cleancookie/ja-db/internal/driver"
)

var ordersRef = driver.ObjectRef{Database: "main", Name: "orders"}

func val(s string) CellValue { return CellValue{Kind: "value", Value: s} }

var (
	null = CellValue{Kind: "null"}
	dflt = CellValue{Kind: "default"}
)

func changes(id string, ref driver.ObjectRef, cs ...RowChange) ChangesRequest {
	return ChangesRequest{ConnectionID: id, Ref: ref, Changes: cs}
}

func update(key float64, set map[string]CellValue) RowChange {
	return RowChange{Op: "update", Key: map[string]any{"id": key}, Set: set}
}

func apply(t *testing.T, svc *Service, req ChangesRequest) ApplyResult {
	t.Helper()
	res, err := svc.ApplyChanges(context.Background(), req)
	if err != nil {
		t.Fatalf("ApplyChanges: %v", err)
	}
	return res
}

// scalar runs a query expected to return one value.
func scalar(t *testing.T, svc *Service, id, sql string) string {
	t.Helper()
	return fmt.Sprint(runOne(t, svc, id, sql).Rows[0][0])
}

func TestApplyUpdateInsertAndDelete(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 3)

	res := apply(t, svc, changes(id, ordersRef,
		update(2, map[string]CellValue{"customer": val("zed"), "total": val("99.5")}),
		RowChange{Op: "insert", Set: map[string]CellValue{"id": val("10"), "customer": val("new")}},
		RowChange{Op: "delete", Key: map[string]any{"id": float64(3)}},
	))
	if res.Conflict != nil || res.Applied != 3 {
		t.Fatalf("result = %+v, want 3 applied and no conflict", res)
	}

	if got := scalar(t, svc, id, `SELECT customer || '/' || total FROM orders WHERE id = 2`); got != "zed/99.5" {
		t.Errorf("updated row = %q", got)
	}
	if got := scalar(t, svc, id, `SELECT customer FROM orders WHERE id = 10`); got != "new" {
		t.Errorf("inserted row = %q", got)
	}
	if got := scalar(t, svc, id, `SELECT count(*) FROM orders WHERE id = 3`); got != "0" {
		t.Errorf("deleted row still there: %s", got)
	}
}

// The column cache is left alone (no schema changed), so this proves rows are
// never cached rather than that the cache was flushed.
func TestReadRowsSeesAppliedChanges(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 2)
	before := readOrders(t, svc, id, "orders")

	apply(t, svc, changes(id, ordersRef, update(1, map[string]CellValue{"customer": val("changed")})))

	after := readOrders(t, svc, id, "orders")
	if fmt.Sprint(before.Result.Rows) == fmt.Sprint(after.Result.Rows) {
		t.Fatal("ReadRows returned the old rows after an apply")
	}
	if !strings.Contains(fmt.Sprint(after.Result.Rows), "changed") {
		t.Errorf("rows = %v, want the new value", after.Result.Rows)
	}
}

func TestStaleKeyIsAConflictAndRollsBackEverything(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 2)

	res := apply(t, svc, changes(id, ordersRef,
		update(1, map[string]CellValue{"customer": val("first")}),
		update(999, map[string]CellValue{"customer": val("ghost")}), // deleted since it was loaded
	))
	if res.Conflict == nil || res.Conflict.Index != 1 || res.Applied != 0 {
		t.Fatalf("result = %+v, want a conflict at index 1 and nothing applied", res)
	}
	if !strings.Contains(res.Conflict.Message, "no row matched") {
		t.Errorf("message = %q", res.Conflict.Message)
	}
	if got := scalar(t, svc, id, `SELECT customer FROM orders WHERE id = 1`); got != "cust-1" {
		t.Errorf("the first change survived the rollback: customer = %q", got)
	}
}

func TestADatabaseErrorIsAConflictAtThatChange(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 2)

	// customer is NOT NULL.
	res := apply(t, svc, changes(id, ordersRef,
		update(1, map[string]CellValue{"note": val("fine")}),
		update(2, map[string]CellValue{"customer": null}),
	))
	if res.Conflict == nil || res.Conflict.Index != 1 {
		t.Fatalf("result = %+v, want a conflict at index 1", res)
	}
	if got := scalar(t, svc, id, `SELECT count(*) FROM orders WHERE note = 'fine'`); got != "0" {
		t.Error("the first change was not rolled back")
	}
}

func TestNullAndEmptyStringStayDistinct(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 2)

	apply(t, svc, changes(id, ordersRef,
		update(1, map[string]CellValue{"note": val("")}),
		update(2, map[string]CellValue{"note": val("x")}),
	))
	apply(t, svc, changes(id, ordersRef, update(2, map[string]CellValue{"note": null})))

	if got := scalar(t, svc, id, `SELECT note IS NULL FROM orders WHERE id = 1`); got != "0" {
		t.Error("an empty string was stored as NULL")
	}
	if got := scalar(t, svc, id, `SELECT note IS NULL FROM orders WHERE id = 2`); got != "1" {
		t.Error("null was not stored as NULL")
	}
}

func TestInsertDefaultOmitsTheColumnOnSQLite(t *testing.T) {
	svc, id := newTestService(t)
	mustRun(t, svc, id, `CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT DEFAULT 'dflt')`)
	ref := driver.ObjectRef{Database: "main", Name: "t"}

	apply(t, svc, changes(id, ref,
		RowChange{Op: "insert", Set: map[string]CellValue{"label": dflt}},
		RowChange{Op: "insert"}, // no columns at all
	))
	if got := scalar(t, svc, id, `SELECT count(*) FROM t WHERE label = 'dflt'`); got != "2" {
		t.Errorf("rows with the default = %s, want 2", got)
	}

	// SQLite cannot say `SET label = DEFAULT`.
	_, err := svc.PreviewChanges(context.Background(),
		changes(id, ref, update(1, map[string]CellValue{"label": dflt})))
	if err == nil || !strings.Contains(err.Error(), "label") {
		t.Errorf("err = %v, want a refusal naming the column", err)
	}
}

func TestTablesWithoutAKeyAndViewsAreRejected(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 1)
	mustRun(t, svc, id, `CREATE TABLE nokey (a INTEGER, b TEXT)`)
	mustRun(t, svc, id, `INSERT INTO nokey VALUES (1, 'x')`)

	for _, name := range []string{"nokey", "big_orders"} {
		req := changes(id, driver.ObjectRef{Database: "main", Name: name},
			RowChange{Op: "insert", Set: map[string]CellValue{"a": val("2")}})
		if _, err := svc.ApplyChanges(context.Background(), req); err == nil ||
			!strings.Contains(err.Error(), "cannot be edited") {
			t.Errorf("%s: err = %v, want it rejected as read-only", name, err)
		}
		if _, err := svc.PreviewChanges(context.Background(), req); err == nil {
			t.Errorf("%s: preview should reject too", name)
		}
	}
	if got := scalar(t, svc, id, `SELECT count(*) FROM nokey`); got != "1" {
		t.Errorf("a rejected change wrote anyway: %s rows", got)
	}
}

func TestChangesThatDisagreeWithTheTableAreRejected(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 2)
	mustRun(t, svc, id, `CREATE TABLE files (id INTEGER PRIMARY KEY, data BLOB, n INTEGER)`)
	mustRun(t, svc, id, `INSERT INTO files (id) VALUES (1)`)
	files := driver.ObjectRef{Database: "main", Name: "files"}

	cases := []struct {
		name    string
		req     ChangesRequest
		wantErr string
	}{
		{"key with an extra column", changes(id, ordersRef, RowChange{Op: "update",
			Key: map[string]any{"id": 1.0, "customer": "cust-1"},
			Set: map[string]CellValue{"note": val("x")}}), "not part of the key"},
		{"key missing its column", changes(id, ordersRef, RowChange{Op: "delete",
			Key: map[string]any{}}), "missing"},
		{"key on the wrong column", changes(id, ordersRef, RowChange{Op: "delete",
			Key: map[string]any{"customer": "cust-1"}}), "not part of the key"},
		{"NULL key", changes(id, ordersRef, RowChange{Op: "delete",
			Key: map[string]any{"id": nil}}), "NULL"},
		{"unknown column", changes(id, ordersRef, update(1,
			map[string]CellValue{"nope": val("x")})), `no column "nope"`},
		{"read-only column", changes(id, files, update(1,
			map[string]CellValue{"data": val("abc")})), "read-only"},
		{"update with nothing to set", changes(id, ordersRef, update(1, nil)), "at least one"},
		{"delete with values", changes(id, ordersRef, RowChange{Op: "delete",
			Key: map[string]any{"id": 1.0}, Set: map[string]CellValue{"note": null}}), "no values"},
		{"insert with a key", changes(id, ordersRef, RowChange{Op: "insert",
			Key: map[string]any{"id": 1.0}}), "no key"},
		{"unknown op", changes(id, ordersRef, RowChange{Op: "truncate"}), "unknown op"},
		{"unknown kind", changes(id, ordersRef, update(1,
			map[string]CellValue{"note": {Kind: "sql", Value: "1; drop table orders"}})), "unknown value kind"},
		{"unparsable number names the column", changes(id, files, update(1,
			map[string]CellValue{"n": val("twelve")})), `column "n"`},
		{"no changes", changes(id, ordersRef), "no changes"},
	}
	for _, c := range cases {
		for _, run := range []struct {
			name string
			fn   func() error
		}{
			{"preview", func() error { _, err := svc.PreviewChanges(context.Background(), c.req); return err }},
			{"apply", func() error { _, err := svc.ApplyChanges(context.Background(), c.req); return err }},
		} {
			if err := run.fn(); err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Errorf("%s (%s): err = %v, want one containing %q", c.name, run.name, err, c.wantErr)
			}
		}
	}
	if got := scalar(t, svc, id, `SELECT count(*) FROM orders`); got != "2" {
		t.Errorf("a rejected change wrote anyway: %s rows", got)
	}
}

func TestPreviewRunsNothingAndMatchesWhatApplyRuns(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 3)
	req := changes(id, ordersRef,
		update(1, map[string]CellValue{"customer": val("it's"), "note": null}),
		RowChange{Op: "delete", Key: map[string]any{"id": 2.0}},
	)
	svc.ClearQueryHistory()

	prev, err := svc.PreviewChanges(context.Background(), req)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if got := scalar(t, svc, id, `SELECT count(*) FROM orders`); got != "3" {
		t.Fatalf("preview changed the table: %s rows", got)
	}
	if got := scalar(t, svc, id, `SELECT customer FROM orders WHERE id = 1`); got != "cust-1" {
		t.Fatalf("preview wrote: customer = %q", got)
	}
	for _, q := range svc.Activity().Queries {
		if q.Kind == activity.KindWrite {
			t.Error("a preview left a write in the activity log")
		}
	}

	want := []Statement{
		{`UPDATE "orders" SET "customer" = ?, "note" = ? WHERE "id" = ?`,
			`UPDATE "orders" SET "customer" = 'it''s', "note" = NULL WHERE "id" = 1`},
		{`DELETE FROM "orders" WHERE "id" = ?`, `DELETE FROM "orders" WHERE "id" = 2`},
	}
	if fmt.Sprint(prev.Statements) != fmt.Sprint(want) {
		t.Errorf("statements\n got %v\nwant %v", prev.Statements, want)
	}

	if res := apply(t, svc, req); res.Applied != 2 {
		t.Fatalf("apply = %+v", res)
	}
	if got := scalar(t, svc, id, `SELECT customer FROM orders WHERE id = 1`); got != "it's" {
		t.Errorf("apply stored %q", got)
	}
}

// Writes are tracked and logged like every other query, and a conflict is
// recorded as a failed write rather than a clean one.
func TestApplyChangesAppearsInTheActivityLog(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 1)
	svc.ClearQueryHistory()

	apply(t, svc, changes(id, ordersRef, update(1, map[string]CellValue{"note": val("a")})))
	apply(t, svc, changes(id, ordersRef, update(404, map[string]CellValue{"note": val("b")})))

	var writes []activity.Info
	for _, q := range svc.Activity().Queries {
		if q.Kind == activity.KindWrite {
			writes = append(writes, q)
		}
	}
	if len(writes) != 2 {
		t.Fatalf("%d write entries, want 2", len(writes))
	}
	phases := map[activity.Phase]bool{writes[0].Phase: true, writes[1].Phase: true}
	if !phases[activity.PhaseDone] || !phases[activity.PhaseFailed] {
		t.Errorf("phases = %v, want one done and one failed", phases)
	}
	for _, w := range writes {
		if !strings.Contains(w.SQL, `UPDATE "orders"`) || strings.Contains(w.SQL, "'a'") {
			t.Errorf("logged SQL = %q, want the parameterised statement without its values", w.SQL)
		}
	}
}

func TestRowCountMessages(t *testing.T) {
	for _, c := range []struct {
		op   string
		n    int64
		want string
	}{
		{"update", 0, "changed or deleted"},
		{"delete", 2, "does not identify a single row"},
		{"insert", 0, "insert"},
	} {
		if got := rowCountMessage(c.op, c.n); !strings.Contains(got, c.want) {
			t.Errorf("rowCountMessage(%s, %d) = %q, want it to mention %q", c.op, c.n, got, c.want)
		}
	}
}

func TestCompositeKeyIsWholeKeyOrNothing(t *testing.T) {
	svc, id := newTestService(t)
	mustRun(t, svc, id, `CREATE TABLE lines (o INTEGER NOT NULL, n INTEGER NOT NULL, qty INTEGER, PRIMARY KEY (o, n))`)
	mustRun(t, svc, id, `INSERT INTO lines VALUES (1, 1, 5), (1, 2, 6)`)
	ref := driver.ObjectRef{Database: "main", Name: "lines"}

	partial := RowChange{Op: "update", Key: map[string]any{"o": 1.0}, Set: map[string]CellValue{"qty": val("9")}}
	if _, err := svc.ApplyChanges(context.Background(), changes(id, ref, partial)); err == nil {
		t.Fatal("half a composite key must be refused, or it updates both rows")
	}
	full := RowChange{Op: "update", Key: map[string]any{"o": 1.0, "n": 2.0}, Set: map[string]CellValue{"qty": val("9")}}
	apply(t, svc, changes(id, ref, full))
	if got := scalar(t, svc, id, `SELECT group_concat(qty) FROM (SELECT qty FROM lines ORDER BY n)`); got != "5,9" {
		t.Errorf("quantities = %s, want 5,9", got)
	}
}
