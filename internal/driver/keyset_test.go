package driver

import (
	"reflect"
	"strings"
	"testing"
)

func keyedCols() []Column {
	return []Column{
		{Name: "id", DataType: "INTEGER", PrimaryKey: true},
		{Name: "name", DataType: "VARCHAR(20)"},
		{Name: "score", DataType: "INTEGER", Nullable: true},
		{Name: "ratio", DataType: "DOUBLE"},
		{Name: "body", DataType: "LONGTEXT"},
		{Name: "blob", DataType: "BLOB"},
	}
}

func TestStableOrderAppendsTheKeyAscending(t *testing.T) {
	full, ok := StableOrder([]Sort{{Column: "name", Desc: true}}, keyedCols(), []string{"id"})
	want := []Sort{{Column: "name", Desc: true}, {Column: "id"}}
	if !reflect.DeepEqual(full, want) || !ok {
		t.Errorf("got %v, %v; want %v, true", full, ok, want)
	}
}

func TestStableOrderLeavesAKeyAlreadyInTheSortAlone(t *testing.T) {
	in := []Sort{{Column: "id", Desc: true}}
	full, ok := StableOrder(in, keyedCols(), []string{"id"})
	if !reflect.DeepEqual(full, in) || !ok {
		t.Errorf("got %v, %v; want %v unchanged and true", full, ok, in)
	}
}

func TestStableOrderWithoutAKeyChangesNothingAndCannotPageByPosition(t *testing.T) {
	in := []Sort{{Column: "name"}}
	full, ok := StableOrder(in, keyedCols(), nil)
	if !reflect.DeepEqual(full, in) || ok {
		t.Errorf("got %v, %v; want the sort untouched and false", full, ok)
	}
}

// A comparison is only as good as the values behind it: NULL is never greater
// or less than anything, a float travels as text and loses digits, and a binary
// preview is not the stored value. Long text is fine — it is checked per row.
func TestStableOrderRefusesColumnsThatCannotBeComparedExactly(t *testing.T) {
	if _, ok := StableOrder([]Sort{{Column: "body"}}, keyedCols(), []string{"id"}); !ok {
		t.Error("a long text column should be allowed to page by position")
	}
	for _, col := range []string{"score", "ratio", "blob"} {
		full, ok := StableOrder([]Sort{{Column: col}}, keyedCols(), []string{"id"})
		if ok {
			t.Errorf("sorting by %s was allowed to page by position", col)
		}
		if last := full[len(full)-1]; last.Column != "id" {
			t.Errorf("sorting by %s: no key tiebreaker, got %v", col, full)
		}
	}
}

func TestBuildReadWithoutACursorIsBuildSelect(t *testing.T) {
	d := mustGet(t, KindSQLite)
	opts := ReadOptions{OrderBy: []Sort{{Column: "id", Desc: true}}, Limit: 11}
	want, _ := d.BuildSelect(ObjectRef{Name: "t"}, opts, nil)
	got, err := BuildRead(d, ObjectRef{Name: "t"}, opts, nil)
	if err != nil || got.SQL != want || len(got.Args) != 0 {
		t.Errorf("got %q %v (%v), want %q", got.SQL, got.Args, err, want)
	}
}

func TestBuildReadBindsTheCursorPerDialect(t *testing.T) {
	order := []Sort{{Column: "name", Desc: true}, {Column: "id"}}
	for _, c := range []struct {
		kind Kind
		want []string
	}{
		{KindSQLite, []string{`WHERE (("name" < ?) OR ("name" = ? AND "id" > ?))`}},
		{KindMySQL, []string{"WHERE ((`name` < ?) OR (`name` = ? AND `id` > ?))"}},
		{KindPostgres, []string{`WHERE (("name" < $1) OR ("name" = $2 AND "id" > $3))`}},
		{KindMSSQL, []string{`WHERE (([name] < @p1) OR ([name] = @p2 AND [id] > @p3))`, "OFFSET 0 ROWS"}},
	} {
		got, err := BuildRead(mustGet(t, c.kind), ObjectRef{Name: "t"},
			ReadOptions{OrderBy: order, After: []any{"bob", int64(7)}, Limit: 11}, nil)
		if err != nil {
			t.Fatalf("%s: %v", c.kind, err)
		}
		for _, w := range c.want {
			if !strings.Contains(got.SQL, w) {
				t.Errorf("%s: %q lacks %q", c.kind, got.SQL, w)
			}
		}
		if !reflect.DeepEqual(got.Args, []any{"bob", "bob", int64(7)}) {
			t.Errorf("%s: args %v", c.kind, got.Args)
		}
		// Display carries the values, never the markers.
		if strings.Contains(got.Display, "?") || strings.Contains(got.Display, "$1") ||
			!strings.Contains(got.Display, "'bob'") || !strings.Contains(got.Display, "7") {
			t.Errorf("%s: display %q", c.kind, got.Display)
		}
	}
}

// The filter is free text and may hold an OR; the cursor condition must not
// bind to half of it.
func TestBuildReadParenthesisesTheFilter(t *testing.T) {
	got, err := BuildRead(mustGet(t, KindSQLite), ObjectRef{Name: "t"}, ReadOptions{
		Filter:  "WHERE a = 1 OR b = 2",
		OrderBy: []Sort{{Column: "id"}},
		After:   []any{int64(3)},
		Limit:   11,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.SQL, `WHERE (a = 1 OR b = 2) AND (("id" > ?))`) {
		t.Errorf("got %q", got.SQL)
	}
}

func TestBuildReadRefusesACursorThatDoesNotMatchTheSort(t *testing.T) {
	_, err := BuildRead(mustGet(t, KindSQLite), ObjectRef{Name: "t"},
		ReadOptions{OrderBy: []Sort{{Column: "id"}}, After: []any{int64(1), int64(2)}}, nil)
	if err == nil {
		t.Error("two values for one sort column were accepted")
	}
}

func TestBuildReadByKeyIgnoresTheFilterAndBinds(t *testing.T) {
	for _, c := range []struct {
		kind Kind
		want string
	}{
		{KindSQLite, `WHERE "id" = ? AND "tenant" = ?`},
		{KindPostgres, `WHERE "id" = $1 AND "tenant" = $2`},
		{KindMSSQL, `WHERE [id] = @p1 AND [tenant] = @p2`},
		{KindMySQL, "WHERE `id` = ? AND `tenant` = ?"},
	} {
		got, err := BuildRead(mustGet(t, c.kind), ObjectRef{Name: "t"}, ReadOptions{
			Filter: "hidden = 1",
			Select: []string{"body"},
			Limit:  1,
			Key:    []KeyCond{{Column: "id", Value: int64(7)}, {Column: "tenant", Value: "acme"}},
		}, nil)
		if err != nil {
			t.Fatalf("%s: %v", c.kind, err)
		}
		if !strings.Contains(got.SQL, c.want) || strings.Contains(got.SQL, "hidden") {
			t.Errorf("%s: %q", c.kind, got.SQL)
		}
		if !reflect.DeepEqual(got.Args, []any{int64(7), "acme"}) {
			t.Errorf("%s: args %v", c.kind, got.Args)
		}
	}
}
