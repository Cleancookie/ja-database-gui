package sample

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func open(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func count(t *testing.T, db *sql.DB, q string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(q).Scan(&n); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
	return n
}

func TestEnsureBuildsExpectedSchemaAndRows(t *testing.T) {
	dir := t.TempDir()
	p, err := Ensure(dir)
	if err != nil {
		t.Fatal(err)
	}
	if p != filepath.Join(dir, "sample.sqlite") {
		t.Fatalf("path = %s", p)
	}
	db := open(t, p)

	rows := map[string]int{
		"categories": 9, "customers": 120, "products": 40, "orders": 400,
		"events": 6000, "audit_log": 40,
	}
	for table, want := range rows {
		if got := count(t, db, "SELECT COUNT(*) FROM "+table); got != want {
			t.Errorf("%s has %d rows, want %d", table, got, want)
		}
	}
	if n := count(t, db, "SELECT COUNT(*) FROM order_items"); n < 400 {
		t.Errorf("order_items has %d rows", n)
	}
	if n := count(t, db, "SELECT COUNT(*) FROM order_totals"); n != 400 {
		t.Errorf("order_totals view has %d rows, want 400", n)
	}
	if n := count(t, db, "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_orders_customer'"); n != 1 {
		t.Error("idx_orders_customer missing")
	}
	// audit_log is the table without a primary key; order_items has a composite one.
	if n := count(t, db, "SELECT COUNT(*) FROM pragma_table_info('audit_log') WHERE pk > 0"); n != 0 {
		t.Errorf("audit_log has %d pk columns, want 0", n)
	}
	if n := count(t, db, "SELECT COUNT(*) FROM pragma_table_info('order_items') WHERE pk > 0"); n != 2 {
		t.Errorf("order_items has %d pk columns, want 2", n)
	}
	// Grid edge cases the sample exists to show.
	for _, q := range []string{
		"SELECT COUNT(*) FROM customers WHERE phone IS NULL",
		"SELECT COUNT(*) FROM customers WHERE company = ''",
		"SELECT COUNT(*) FROM customers WHERE length(notes) >= 300",
		"SELECT COUNT(*) FROM products WHERE json_valid(attributes)",
	} {
		if count(t, db, q) == 0 {
			t.Errorf("no rows for: %s", q)
		}
	}
	var violations int
	if err := db.QueryRow("SELECT COUNT(*) FROM pragma_foreign_key_check").Scan(&violations); err != nil || violations != 0 {
		t.Errorf("foreign key violations %d err %v", violations, err)
	}
	if fi, _ := os.Stat(p); fi.Size() > 2<<20 {
		t.Errorf("sample is %d bytes, want under 2 MB", fi.Size())
	}
}

func TestEnsureReusesExistingFile(t *testing.T) {
	dir := t.TempDir()
	p, _ := Ensure(dir)
	db := open(t, p)
	if _, err := db.Exec("DELETE FROM audit_log"); err != nil {
		t.Fatal(err)
	}
	if _, err := Ensure(dir); err != nil {
		t.Fatal(err)
	}
	if n := count(t, db, "SELECT COUNT(*) FROM audit_log"); n != 0 {
		t.Errorf("Ensure overwrote an existing file: %d rows", n)
	}
}

func TestResetRecreatesFile(t *testing.T) {
	dir := t.TempDir()
	p, _ := Ensure(dir)
	db := open(t, p)
	if _, err := db.Exec("DELETE FROM audit_log"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if _, err := Reset(dir); err != nil {
		t.Fatal(err)
	}
	if n := count(t, open(t, p), "SELECT COUNT(*) FROM audit_log"); n != 40 {
		t.Errorf("after reset audit_log has %d rows, want 40", n)
	}
	left, _ := filepath.Glob(filepath.Join(dir, "*.tmp-*"))
	if len(left) != 0 {
		t.Errorf("temp files left behind: %v", left)
	}
}

func TestSeedIsDeterministic(t *testing.T) {
	dump := func() map[string]string {
		p, err := Ensure(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		db := open(t, p)
		out := map[string]string{}
		for _, table := range []string{"categories", "customers", "products", "orders", "order_items", "events", "audit_log"} {
			rows, err := db.Query("SELECT * FROM " + table)
			if err != nil {
				t.Fatal(err)
			}
			cols, _ := rows.Columns()
			var s string
			for rows.Next() {
				vals := make([]any, len(cols))
				ptrs := make([]any, len(cols))
				for i := range vals {
					ptrs[i] = &vals[i]
				}
				if err := rows.Scan(ptrs...); err != nil {
					t.Fatal(err)
				}
				s += fmtRow(vals) + "\n"
			}
			rows.Close()
			out[table] = s
		}
		return out
	}
	a, b := dump(), dump()
	for table := range a {
		if a[table] != b[table] {
			t.Errorf("%s differs between two builds", table)
		}
		if a[table] == "" {
			t.Errorf("%s is empty", table)
		}
	}
}

func fmtRow(vals []any) string {
	s := ""
	for _, v := range vals {
		switch x := v.(type) {
		case []byte:
			s += string(x) + "|"
		default:
			s += fmt.Sprint(x) + "|"
		}
	}
	return s
}
