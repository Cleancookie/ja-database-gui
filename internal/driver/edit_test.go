package driver

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func col(name, typ string, nullable bool) Column {
	return Column{Name: name, DataType: typ, Nullable: nullable}
}

func TestEditKeyPrefersThePrimaryKey(t *testing.T) {
	cols := []Column{col("a", "int", false), col("b", "int", false)}
	idx := []Index{
		{Name: "pk", Primary: true, Unique: true, Columns: []string{"b", "a"}},
		{Name: "u", Unique: true, Columns: []string{"a"}},
	}
	got := newEditFacts(cols, idx, false)
	if !reflect.DeepEqual(got.EditKey, []string{"b", "a"}) {
		t.Errorf("EditKey = %v, want the primary key in index order", got.EditKey)
	}
	if got.ReadOnlyReason != "" {
		t.Errorf("a table with a primary key is editable, got %q", got.ReadOnlyReason)
	}
}

func TestEditKeyFallsBackToAUsableUniqueIndex(t *testing.T) {
	cols := []Column{col("nullable_u", "int", true), col("code", "text", false), col("x", "int", false)}
	idx := []Index{
		{Name: "u_nullable", Unique: true, Columns: []string{"nullable_u"}},
		{Name: "u_partial", Unique: true, partial: true, Columns: []string{"x"}},
		{Name: "not_unique", Columns: []string{"x"}},
		{Name: "u_code", Unique: true, Columns: []string{"code"}},
	}
	got := newEditFacts(cols, idx, false)
	if !reflect.DeepEqual(got.EditKey, []string{"code"}) {
		t.Errorf("EditKey = %v, want [code]: nullable, partial and non-unique indexes are no key", got.EditKey)
	}
}

func TestNoUsableKeyMakesTheTableReadOnly(t *testing.T) {
	cols := []Column{col("a", "int", true)}
	idx := []Index{{Name: "u", Unique: true, Columns: []string{"a"}}}
	got := newEditFacts(cols, idx, false)
	if len(got.EditKey) != 0 || got.ReadOnlyReason == "" {
		t.Errorf("got key %v, reason %q; want no key and a reason", got.EditKey, got.ReadOnlyReason)
	}
}

func TestViewsAreReadOnly(t *testing.T) {
	cols := []Column{{Name: "id", PrimaryKey: true}}
	got := newEditFacts(cols, nil, true)
	if got.ReadOnlyReason != reasonView {
		t.Errorf("reason = %q, want the view reason", got.ReadOnlyReason)
	}
}

func TestBinaryAndGeneratedColumnsAreReadOnly(t *testing.T) {
	cols := []Column{
		{Name: "id", DataType: "int", PrimaryKey: true},
		{Name: "pic", DataType: "longblob", Nullable: true},
		{Name: "h", DataType: "varbinary(16)", Nullable: true},
		{Name: "raw", DataType: "bytea", Nullable: true},
		{Name: "total", DataType: "int", Generated: true},
		{Name: "name", DataType: "varchar(20)"},
	}
	got := newEditFacts(cols, nil, false)
	for _, name := range []string{"pic", "h", "raw", "total"} {
		if got.ReadOnlyColumns[name] == "" {
			t.Errorf("%s should be read-only", name)
		}
	}
	for _, name := range []string{"id", "name"} {
		if got.ReadOnlyColumns[name] != "" {
			t.Errorf("%s should stay editable", name)
		}
	}
}

func TestIndexWithAnExpressionIsNoKey(t *testing.T) {
	a := newIndexAccum()
	a.add("u_expr", "a", true, false, "")
	a.add("u_expr", "", true, false, "") // a position with no column is an expression
	if ix := a.result()[0]; !ix.partial {
		t.Error("an index with an expression in it is not unique by its listed columns alone")
	}
}

// The real thing, against a real SQLite file: every rule above as the catalogue
// reports it rather than as a hand-built Index.
func TestSQLiteEditFacts(t *testing.T) {
	db, err := sql.Open("sqlite", "file:"+filepath.Join(t.TempDir(), "e.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

	for _, stmt := range []string{
		`CREATE TABLE with_pk (id INTEGER PRIMARY KEY, name TEXT)`,
		`CREATE TABLE composite (b INTEGER NOT NULL, a INTEGER NOT NULL, v TEXT, PRIMARY KEY (b, a))`,
		`CREATE TABLE uniq (code TEXT NOT NULL, n INTEGER)`,
		`CREATE UNIQUE INDEX uniq_code ON uniq (code)`,
		`CREATE TABLE uniq_null (code TEXT, n INTEGER)`,
		`CREATE UNIQUE INDEX uniq_null_code ON uniq_null (code)`,
		`CREATE TABLE uniq_partial (code TEXT NOT NULL, live INTEGER)`,
		`CREATE UNIQUE INDEX uniq_partial_code ON uniq_partial (code) WHERE live = 1`,
		`CREATE TABLE uniq_expr (code TEXT NOT NULL)`,
		`CREATE UNIQUE INDEX uniq_expr_code ON uniq_expr (lower(code))`,
		`CREATE TABLE nokey (a INTEGER, b TEXT)`,
		`CREATE TABLE typed (id INTEGER PRIMARY KEY, pic BLOB, total INTEGER GENERATED ALWAYS AS (id * 2) VIRTUAL)`,
		`CREATE VIEW v AS SELECT id FROM with_pk`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}

	cases := []struct {
		table    string
		key      []string
		readOnly bool
	}{
		{"with_pk", []string{"id"}, false},
		{"composite", []string{"b", "a"}, false},
		{"uniq", []string{"code"}, false},
		{"uniq_null", nil, true},
		{"uniq_partial", nil, true},
		{"uniq_expr", nil, true},
		{"nokey", nil, true},
		{"v", nil, true},
	}
	d := sqliteDriver{}
	for _, c := range cases {
		got, err := d.EditFacts(context.Background(), db, ObjectRef{Name: c.table})
		if err != nil {
			t.Fatalf("%s: %v", c.table, err)
		}
		if len(got.EditKey) != len(c.key) || (len(c.key) > 0 && !reflect.DeepEqual(got.EditKey, c.key)) {
			t.Errorf("%s: EditKey = %v, want %v", c.table, got.EditKey, c.key)
		}
		if (got.ReadOnlyReason != "") != c.readOnly {
			t.Errorf("%s: ReadOnlyReason = %q, readOnly want %v", c.table, got.ReadOnlyReason, c.readOnly)
		}
	}

	got, err := d.EditFacts(context.Background(), db, ObjectRef{Name: "typed"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.ReadOnlyColumns["pic"], "binary") || got.ReadOnlyColumns["total"] != reasonComputed {
		t.Errorf("ReadOnlyColumns = %v, want the blob and the generated column", got.ReadOnlyColumns)
	}
	if got.ReadOnlyColumns["id"] != "" {
		t.Errorf("id should stay editable: %v", got.ReadOnlyColumns)
	}
}
