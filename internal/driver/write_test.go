package driver

import (
	"reflect"
	"strings"
	"testing"
)

var writeRef = ObjectRef{Database: "shop", Schema: "sales", Name: "orders"}

func TestBuildChangeUpdatePerDialect(t *testing.T) {
	ch := Change{
		Op:  ChangeUpdate,
		Set: []Assignment{{Column: "qty", Value: int64(5)}, {Column: "note", Value: nil}},
		Key: []KeyCond{{Column: "id", Value: int64(7)}},
	}
	cases := []struct {
		kind         Kind
		sql, display string
	}{
		{KindMySQL,
			"UPDATE `shop`.`orders` SET `qty` = ?, `note` = ? WHERE `id` = ?",
			"UPDATE `shop`.`orders` SET `qty` = 5, `note` = NULL WHERE `id` = 7"},
		{KindPostgres,
			`UPDATE "sales"."orders" SET "qty" = $1, "note" = $2 WHERE "id" = $3`,
			`UPDATE "sales"."orders" SET "qty" = 5, "note" = NULL WHERE "id" = 7`},
		{KindMSSQL,
			"UPDATE [shop].[sales].[orders] SET [qty] = @p1, [note] = @p2 WHERE [id] = @p3",
			"UPDATE [shop].[sales].[orders] SET [qty] = 5, [note] = NULL WHERE [id] = 7"},
		{KindSQLite,
			`UPDATE "orders" SET "qty" = ?, "note" = ? WHERE "id" = ?`,
			`UPDATE "orders" SET "qty" = 5, "note" = NULL WHERE "id" = 7`},
	}
	for _, c := range cases {
		got, err := mustGet(t, c.kind).BuildChange(writeRef, ch)
		if err != nil {
			t.Fatalf("%s: %v", c.kind, err)
		}
		if got.SQL != c.sql {
			t.Errorf("%s SQL\n got %s\nwant %s", c.kind, got.SQL, c.sql)
		}
		if got.Display != c.display {
			t.Errorf("%s Display\n got %s\nwant %s", c.kind, got.Display, c.display)
		}
		if want := []any{int64(5), nil, int64(7)}; !reflect.DeepEqual(got.Args, want) {
			t.Errorf("%s Args = %#v, want %#v", c.kind, got.Args, want)
		}
	}
}

func TestBuildChangeDeleteUsesEveryKeyColumn(t *testing.T) {
	ch := Change{Op: ChangeDelete, Key: []KeyCond{{Column: "a", Value: int64(1)}, {Column: "b", Value: "x"}}}
	cases := map[Kind]string{
		KindMySQL:    "DELETE FROM `shop`.`orders` WHERE `a` = ? AND `b` = ?",
		KindPostgres: `DELETE FROM "sales"."orders" WHERE "a" = $1 AND "b" = $2`,
		KindMSSQL:    "DELETE FROM [shop].[sales].[orders] WHERE [a] = @p1 AND [b] = @p2",
		KindSQLite:   `DELETE FROM "orders" WHERE "a" = ? AND "b" = ?`,
	}
	for kind, want := range cases {
		got, err := mustGet(t, kind).BuildChange(writeRef, ch)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if got.SQL != want {
			t.Errorf("%s\n got %s\nwant %s", kind, got.SQL, want)
		}
	}
}

func TestBuildChangeInsertPerDialect(t *testing.T) {
	ch := Change{Op: ChangeInsert, Set: []Assignment{
		{Column: "name", Value: "it's"},
		{Column: "created", Default: true},
	}}
	cases := []struct {
		kind         Kind
		sql, display string
	}{
		{KindMySQL,
			"INSERT INTO `shop`.`orders` (`name`, `created`) VALUES (?, DEFAULT)",
			"INSERT INTO `shop`.`orders` (`name`, `created`) VALUES ('it''s', DEFAULT)"},
		{KindPostgres,
			`INSERT INTO "sales"."orders" ("name", "created") VALUES ($1, DEFAULT)`,
			`INSERT INTO "sales"."orders" ("name", "created") VALUES ('it''s', DEFAULT)`},
		{KindMSSQL,
			"INSERT INTO [shop].[sales].[orders] ([name], [created]) VALUES (@p1, DEFAULT)",
			"INSERT INTO [shop].[sales].[orders] ([name], [created]) VALUES (N'it''s', DEFAULT)"},
		// No DEFAULT keyword: leaving the column out of an insert means the same.
		{KindSQLite,
			`INSERT INTO "orders" ("name") VALUES (?)`,
			`INSERT INTO "orders" ("name") VALUES ('it''s')`},
	}
	for _, c := range cases {
		got, err := mustGet(t, c.kind).BuildChange(writeRef, ch)
		if err != nil {
			t.Fatalf("%s: %v", c.kind, err)
		}
		if got.SQL != c.sql || got.Display != c.display {
			t.Errorf("%s\n got %s\n     %s\nwant %s\n     %s", c.kind, got.SQL, got.Display, c.sql, c.display)
		}
	}
}

func TestBuildChangeInsertWithNoColumns(t *testing.T) {
	ch := Change{Op: ChangeInsert}
	cases := map[Kind]string{
		KindMySQL:    "INSERT INTO `shop`.`orders` () VALUES ()",
		KindPostgres: `INSERT INTO "sales"."orders" DEFAULT VALUES`,
		KindMSSQL:    "INSERT INTO [shop].[sales].[orders] DEFAULT VALUES",
		KindSQLite:   `INSERT INTO "orders" DEFAULT VALUES`,
	}
	for kind, want := range cases {
		got, err := mustGet(t, kind).BuildChange(writeRef, ch)
		if err != nil || got.SQL != want {
			t.Errorf("%s: got %q, %v; want %q", kind, got.SQL, err, want)
		}
	}
}

func TestBuildChangeSetToDefaultOnUpdate(t *testing.T) {
	ch := Change{
		Op:  ChangeUpdate,
		Set: []Assignment{{Column: "created", Default: true}},
		Key: []KeyCond{{Column: "id", Value: int64(1)}},
	}
	got, err := mustGet(t, KindPostgres).BuildChange(writeRef, ch)
	if err != nil {
		t.Fatal(err)
	}
	if want := `UPDATE "sales"."orders" SET "created" = DEFAULT WHERE "id" = $1`; got.SQL != want {
		t.Errorf("got %s, want %s", got.SQL, want)
	}
	if len(got.Args) != 1 {
		t.Errorf("DEFAULT must not take a parameter, Args = %v", got.Args)
	}

	_, err = mustGet(t, KindSQLite).BuildChange(writeRef, ch)
	if err == nil || !strings.Contains(err.Error(), "created") {
		t.Errorf("SQLite has no DEFAULT for an UPDATE; got err %v", err)
	}
}

// The whole point: a value is never part of the statement that runs.
func TestValuesAreBoundNeverConcatenated(t *testing.T) {
	evil := `x'; DROP TABLE orders; --`
	ch := Change{
		Op:  ChangeUpdate,
		Set: []Assignment{{Column: "note", Value: evil}},
		Key: []KeyCond{{Column: "id", Value: evil}},
	}
	for _, kind := range Kinds() {
		got, err := mustGet(t, kind).BuildChange(writeRef, ch)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(got.SQL, "DROP") {
			t.Errorf("%s: a value reached the executed SQL: %s", kind, got.SQL)
		}
		if !reflect.DeepEqual(got.Args, []any{evil, evil}) {
			t.Errorf("%s: Args = %v", kind, got.Args)
		}
	}
}

func TestIdentifiersAreQuotedInChanges(t *testing.T) {
	ch := Change{
		Op:  ChangeUpdate,
		Set: []Assignment{{Column: "we`ird", Value: int64(1)}},
		Key: []KeyCond{{Column: "id", Value: int64(1)}},
	}
	got, err := mustGet(t, KindMySQL).BuildChange(ObjectRef{Database: "d", Name: "t`x"}, ch)
	if err != nil {
		t.Fatal(err)
	}
	if want := "UPDATE `d`.`t``x` SET `we``ird` = ? WHERE `id` = ?"; got.SQL != want {
		t.Errorf("got %s, want %s", got.SQL, want)
	}
}

func TestMySQLDisplayDoublesBackslashes(t *testing.T) {
	ch := Change{Op: ChangeInsert, Set: []Assignment{{Column: "p", Value: `C:\tmp`}}}
	got, _ := mustGet(t, KindMySQL).BuildChange(writeRef, ch)
	if !strings.Contains(got.Display, `'C:\\tmp'`) {
		t.Errorf("Display = %s", got.Display)
	}
}

func TestBuildChangeRefusesUnsafeShapes(t *testing.T) {
	d := mustGet(t, KindPostgres)
	for name, ch := range map[string]Change{
		"update without a key":     {Op: ChangeUpdate, Set: []Assignment{{Column: "a", Value: "x"}}},
		"update without a change":  {Op: ChangeUpdate, Key: []KeyCond{{Column: "id", Value: int64(1)}}},
		"delete without a key":     {Op: ChangeDelete},
		"delete by a NULL key":     {Op: ChangeDelete, Key: []KeyCond{{Column: "id", Value: nil}}},
		"an operation nobody knew": {Op: "truncate"},
	} {
		if _, err := d.BuildChange(writeRef, ch); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

func TestEveryDialectStatesWhetherItHasDefault(t *testing.T) {
	for _, k := range Kinds() {
		want := k != KindSQLite
		if got := mustGet(t, k).Caps().SetToDefault; got != want {
			t.Errorf("%s SetToDefault = %v, want %v", k, got, want)
		}
	}
}

func TestCoerceValueByColumnType(t *testing.T) {
	cases := []struct {
		dataType, in string
		want         any
	}{
		{"int", " 42 ", int64(42)},
		{"bigint unsigned", "18446744073709551615", "18446744073709551615"},
		{"tinyint(1)", "true", int64(1)},
		{"integer", "-7", int64(-7)},
		{"boolean", "f", false},
		{"bit", "1", true},
		{"double precision", "1.5", 1.5},
		{"decimal(10,2)", "12.50", "12.50"},
		{"numeric", "-.5e3", "-.5e3"},
		{"varchar(20)", " keep me ", " keep me "},
		{"text", "", ""},
		{"jsonb", `{"a":1}`, `{"a":1}`},
		{"timestamp with time zone", "2024-01-02 03:04:05+00", "2024-01-02 03:04:05+00"},
		{"", "anything", "anything"}, // SQLite column with no declared type
	}
	for _, c := range cases {
		got, err := CoerceValue(Column{Name: "c", DataType: c.dataType}, c.in)
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s %q = %#v, %v; want %#v", c.dataType, c.in, got, err, c.want)
		}
	}
}

func TestCoerceValueRejectsWhatItCannotParseAndNamesTheColumn(t *testing.T) {
	for _, c := range []struct{ dataType, in string }{
		{"int", "abc"}, {"int", "1.5"}, {"boolean", "maybe"},
		{"float", "NaN"}, {"decimal(5,2)", "1,5"}, {"bigint", ""},
	} {
		_, err := CoerceValue(Column{Name: "qty", DataType: c.dataType}, c.in)
		if err == nil || !strings.Contains(err.Error(), `"qty"`) {
			t.Errorf("%s %q: err = %v, want one naming the column", c.dataType, c.in, err)
		}
	}
}

func TestCoerceKeyAcceptsTheWireFormat(t *testing.T) {
	cases := []struct {
		dataType string
		in, want any
	}{
		{"int", float64(7), int64(7)},
		{"bigint", "9007199254740993", int64(9007199254740993)},
		{"varchar(10)", "abc", "abc"},
		{"decimal(10,2)", "12.50", "12.50"},
		{"boolean", true, true},
		{"real", 1.5, 1.5},
	}
	for _, c := range cases {
		got, err := CoerceKey(Column{Name: "k", DataType: c.dataType}, c.in)
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s %#v = %#v, %v; want %#v", c.dataType, c.in, got, err, c.want)
		}
	}
	for _, in := range []any{nil, 1.5, []any{1}} {
		if _, err := CoerceKey(Column{Name: "k", DataType: "int"}, in); err == nil {
			t.Errorf("CoerceKey(int, %#v) should fail", in)
		}
	}
}
