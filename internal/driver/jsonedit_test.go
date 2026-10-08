package driver

import (
	"reflect"
	"strings"
	"testing"
)

func key(s string) PathStep { return PathStep{Key: s} }
func idx(i int) PathStep    { return PathStep{Index: i, IsIndex: true} }

// One case per op, a nest of two, and keys that need quoting: a quote, a dot, a
// backslash and a non-ASCII letter.
var jsonEditCases = map[string][]JSONEdit{
	"set":    {{Op: JSONSet, Path: []PathStep{key("a"), idx(2)}, Value: `{"x":1}`}},
	"remove": {{Op: JSONRemove, Path: []PathStep{key("a")}}},
	"append": {{Op: JSONAppend, Path: []PathStep{key("tags")}, Value: `"it's"`}},
	"rename": {{Op: JSONRename, Path: []PathStep{key("o"), key("old")}, NewKey: "new"}},
	"nest":   {{Op: JSONSet, Path: []PathStep{key("a")}, Value: `1`}, {Op: JSONRemove, Path: []PathStep{key("b")}}},
	"keys":   {{Op: JSONSet, Path: []PathStep{key(`q"k`), key(`a.b`), key(`back\s`), key("é")}, Value: `null`}},
}

func jsonEditChange(edits []JSONEdit, dataType string) Change {
	return Change{Op: ChangeUpdate, Key: []KeyCond{{Column: "id", Value: int64(7)}},
		Set: []Assignment{{Column: "doc", DataType: dataType, Edits: edits}}}
}

func TestBuildChangeJSONEditsPerDialect(t *testing.T) {
	cases := []struct {
		kind         Kind
		name         string
		sql, display string
		args         []any
	}{
		{"sqlite", "set",
			"UPDATE \"orders\" SET \"doc\" = json_set(\"doc\", ?, json(?)) WHERE \"id\" = ?",
			"UPDATE \"orders\" SET \"doc\" = json_set(\"doc\", '$.\"a\"[2]', json('{\"x\":1}')) WHERE \"id\" = 7",
			[]any{"$.\"a\"[2]", "{\"x\":1}", int64(7)}},
		{"sqlite", "remove",
			"UPDATE \"orders\" SET \"doc\" = json_remove(\"doc\", ?) WHERE \"id\" = ?",
			"UPDATE \"orders\" SET \"doc\" = json_remove(\"doc\", '$.\"a\"') WHERE \"id\" = 7",
			[]any{"$.\"a\"", int64(7)}},
		{"sqlite", "append",
			"UPDATE \"orders\" SET \"doc\" = json_insert(\"doc\", ?, json(?)) WHERE \"id\" = ?",
			"UPDATE \"orders\" SET \"doc\" = json_insert(\"doc\", '$.\"tags\"[#]', json('\"it''s\"')) WHERE \"id\" = 7",
			[]any{"$.\"tags\"[#]", "\"it's\"", int64(7)}},
		{"sqlite", "rename",
			"UPDATE \"orders\" SET \"doc\" = json_set(json_remove(\"doc\", ?), ?, \"doc\" -> ?) WHERE \"id\" = ?",
			"UPDATE \"orders\" SET \"doc\" = json_set(json_remove(\"doc\", '$.\"o\".\"old\"'), '$.\"o\".\"new\"', \"doc\" -> '$.\"o\".\"old\"') WHERE \"id\" = 7",
			[]any{"$.\"o\".\"old\"", "$.\"o\".\"new\"", "$.\"o\".\"old\"", int64(7)}},
		{"sqlite", "nest",
			"UPDATE \"orders\" SET \"doc\" = json_remove(json_set(\"doc\", ?, json(?)), ?) WHERE \"id\" = ?",
			"UPDATE \"orders\" SET \"doc\" = json_remove(json_set(\"doc\", '$.\"a\"', json('1')), '$.\"b\"') WHERE \"id\" = 7",
			[]any{"$.\"a\"", "1", "$.\"b\"", int64(7)}},
		{"sqlite", "keys",
			"UPDATE \"orders\" SET \"doc\" = json_set(\"doc\", ?, json(?)) WHERE \"id\" = ?",
			"UPDATE \"orders\" SET \"doc\" = json_set(\"doc\", '$.\"q\\\"k\".\"a.b\".\"back\\\\s\".\"é\"', json('null')) WHERE \"id\" = 7",
			[]any{"$.\"q\\\"k\".\"a.b\".\"back\\\\s\".\"é\"", "null", int64(7)}},
		{"mysql", "set",
			"UPDATE `shop`.`orders` SET `doc` = JSON_SET(`doc`, ?, JSON_EXTRACT(?, '$')) WHERE `id` = ?",
			"UPDATE `shop`.`orders` SET `doc` = JSON_SET(`doc`, '$.\"a\"[2]', JSON_EXTRACT('{\"x\":1}', '$')) WHERE `id` = 7",
			[]any{"$.\"a\"[2]", "{\"x\":1}", int64(7)}},
		{"mysql", "remove",
			"UPDATE `shop`.`orders` SET `doc` = JSON_REMOVE(`doc`, ?) WHERE `id` = ?",
			"UPDATE `shop`.`orders` SET `doc` = JSON_REMOVE(`doc`, '$.\"a\"') WHERE `id` = 7",
			[]any{"$.\"a\"", int64(7)}},
		{"mysql", "append",
			"UPDATE `shop`.`orders` SET `doc` = JSON_ARRAY_APPEND(`doc`, ?, JSON_EXTRACT(?, '$')) WHERE `id` = ?",
			"UPDATE `shop`.`orders` SET `doc` = JSON_ARRAY_APPEND(`doc`, '$.\"tags\"', JSON_EXTRACT('\"it''s\"', '$')) WHERE `id` = 7",
			[]any{"$.\"tags\"", "\"it's\"", int64(7)}},
		{"mysql", "rename",
			"UPDATE `shop`.`orders` SET `doc` = JSON_SET(JSON_REMOVE(`doc`, ?), ?, JSON_EXTRACT(`doc`, ?)) WHERE `id` = ?",
			"UPDATE `shop`.`orders` SET `doc` = JSON_SET(JSON_REMOVE(`doc`, '$.\"o\".\"old\"'), '$.\"o\".\"new\"', JSON_EXTRACT(`doc`, '$.\"o\".\"old\"')) WHERE `id` = 7",
			[]any{"$.\"o\".\"old\"", "$.\"o\".\"new\"", "$.\"o\".\"old\"", int64(7)}},
		{"mysql", "nest",
			"UPDATE `shop`.`orders` SET `doc` = JSON_REMOVE(JSON_SET(`doc`, ?, JSON_EXTRACT(?, '$')), ?) WHERE `id` = ?",
			"UPDATE `shop`.`orders` SET `doc` = JSON_REMOVE(JSON_SET(`doc`, '$.\"a\"', JSON_EXTRACT('1', '$')), '$.\"b\"') WHERE `id` = 7",
			[]any{"$.\"a\"", "1", "$.\"b\"", int64(7)}},
		{"mysql", "keys",
			"UPDATE `shop`.`orders` SET `doc` = JSON_SET(`doc`, ?, JSON_EXTRACT(?, '$')) WHERE `id` = ?",
			"UPDATE `shop`.`orders` SET `doc` = JSON_SET(`doc`, '$.\"q\\\\\"k\".\"a.b\".\"back\\\\\\\\s\".\"é\"', JSON_EXTRACT('null', '$')) WHERE `id` = 7",
			[]any{"$.\"q\\\"k\".\"a.b\".\"back\\\\s\".\"é\"", "null", int64(7)}},
		{"postgres", "set",
			"UPDATE \"sales\".\"orders\" SET \"doc\" = (jsonb_set(\"doc\"::jsonb, ARRAY[$1, $2]::text[], $3::jsonb, true))::text WHERE \"id\" = $4",
			"UPDATE \"sales\".\"orders\" SET \"doc\" = (jsonb_set(\"doc\"::jsonb, ARRAY['a', '2']::text[], '{\"x\":1}'::jsonb, true))::text WHERE \"id\" = 7",
			[]any{"a", "2", "{\"x\":1}", int64(7)}},
		{"postgres", "remove",
			"UPDATE \"sales\".\"orders\" SET \"doc\" = ((\"doc\"::jsonb #- ARRAY[$1]::text[]))::text WHERE \"id\" = $2",
			"UPDATE \"sales\".\"orders\" SET \"doc\" = ((\"doc\"::jsonb #- ARRAY['a']::text[]))::text WHERE \"id\" = 7",
			[]any{"a", int64(7)}},
		{"postgres", "append",
			"UPDATE \"sales\".\"orders\" SET \"doc\" = (jsonb_insert(\"doc\"::jsonb, ARRAY[$1, $2]::text[], $3::jsonb, true))::text WHERE \"id\" = $4",
			"UPDATE \"sales\".\"orders\" SET \"doc\" = (jsonb_insert(\"doc\"::jsonb, ARRAY['tags', '-1']::text[], '\"it''s\"'::jsonb, true))::text WHERE \"id\" = 7",
			[]any{"tags", "-1", "\"it's\"", int64(7)}},
		{"postgres", "rename",
			"UPDATE \"sales\".\"orders\" SET \"doc\" = (jsonb_set((\"doc\"::jsonb #- ARRAY[$1, $2]::text[]), ARRAY[$3, $4]::text[], COALESCE(\"doc\"::jsonb #> ARRAY[$5, $6]::text[], 'null'), true))::text WHERE \"id\" = $7",
			"UPDATE \"sales\".\"orders\" SET \"doc\" = (jsonb_set((\"doc\"::jsonb #- ARRAY['o', 'old']::text[]), ARRAY['o', 'new']::text[], COALESCE(\"doc\"::jsonb #> ARRAY['o', 'old']::text[], 'null'), true))::text WHERE \"id\" = 7",
			[]any{"o", "old", "o", "new", "o", "old", int64(7)}},
		{"postgres", "nest",
			"UPDATE \"sales\".\"orders\" SET \"doc\" = ((jsonb_set(\"doc\"::jsonb, ARRAY[$1]::text[], $2::jsonb, true) #- ARRAY[$3]::text[]))::text WHERE \"id\" = $4",
			"UPDATE \"sales\".\"orders\" SET \"doc\" = ((jsonb_set(\"doc\"::jsonb, ARRAY['a']::text[], '1'::jsonb, true) #- ARRAY['b']::text[]))::text WHERE \"id\" = 7",
			[]any{"a", "1", "b", int64(7)}},
		{"postgres", "keys",
			"UPDATE \"sales\".\"orders\" SET \"doc\" = (jsonb_set(\"doc\"::jsonb, ARRAY[$1, $2, $3, $4]::text[], $5::jsonb, true))::text WHERE \"id\" = $6",
			"UPDATE \"sales\".\"orders\" SET \"doc\" = (jsonb_set(\"doc\"::jsonb, ARRAY['q\"k', 'a.b', 'back\\s', 'é']::text[], 'null'::jsonb, true))::text WHERE \"id\" = 7",
			[]any{"q\"k", "a.b", "back\\s", "é", "null", int64(7)}},
		{"mssql", "set",
			"UPDATE [shop].[sales].[orders] SET [doc] = JSON_MODIFY([doc], @p1, JSON_QUERY(@p2)) WHERE [id] = @p3",
			"UPDATE [shop].[sales].[orders] SET [doc] = JSON_MODIFY([doc], N'$.\"a\"[2]', JSON_QUERY(N'{\"x\":1}')) WHERE [id] = 7",
			[]any{"$.\"a\"[2]", "{\"x\":1}", int64(7)}},
		{"mssql", "remove",
			"UPDATE [shop].[sales].[orders] SET [doc] = JSON_MODIFY([doc], @p1, NULL) WHERE [id] = @p2",
			"UPDATE [shop].[sales].[orders] SET [doc] = JSON_MODIFY([doc], N'$.\"a\"', NULL) WHERE [id] = 7",
			[]any{"$.\"a\"", int64(7)}},
		{"mssql", "append",
			"UPDATE [shop].[sales].[orders] SET [doc] = JSON_MODIFY([doc], @p1, @p2) WHERE [id] = @p3",
			"UPDATE [shop].[sales].[orders] SET [doc] = JSON_MODIFY([doc], N'append $.\"tags\"', N'it''s') WHERE [id] = 7",
			[]any{"append $.\"tags\"", "it's", int64(7)}},
		{"mssql", "rename",
			"UPDATE [shop].[sales].[orders] SET [doc] = JSON_MODIFY([doc], @p1, JSON_QUERY((SELECT N'{' + ISNULL(STRING_AGG(CAST(N'\"' + STRING_ESCAPE(IIF([key] = @p2, @p3, [key]), 'json') + N'\":' + CASE [type] WHEN 0 THEN N'null' WHEN 1 THEN N'\"' + STRING_ESCAPE([value], 'json') + N'\"' ELSE [value] END AS nvarchar(max)), N','), N'') + N'}' FROM OPENJSON([doc], @p4) WHERE [key] <> @p5))) WHERE [id] = @p6",
			"UPDATE [shop].[sales].[orders] SET [doc] = JSON_MODIFY([doc], N'$.\"o\"', JSON_QUERY((SELECT N'{' + ISNULL(STRING_AGG(CAST(N'\"' + STRING_ESCAPE(IIF([key] = N'old', N'new', [key]), 'json') + N'\":' + CASE [type] WHEN 0 THEN N'null' WHEN 1 THEN N'\"' + STRING_ESCAPE([value], 'json') + N'\"' ELSE [value] END AS nvarchar(max)), N','), N'') + N'}' FROM OPENJSON([doc], N'$.\"o\"') WHERE [key] <> N'new'))) WHERE [id] = 7",
			[]any{"$.\"o\"", "old", "new", "$.\"o\"", "new", int64(7)}},
		{"mssql", "nest",
			"UPDATE [shop].[sales].[orders] SET [doc] = JSON_MODIFY(JSON_MODIFY([doc], @p1, @p2), @p3, NULL) WHERE [id] = @p4",
			"UPDATE [shop].[sales].[orders] SET [doc] = JSON_MODIFY(JSON_MODIFY([doc], N'$.\"a\"', 1), N'$.\"b\"', NULL) WHERE [id] = 7",
			[]any{"$.\"a\"", int64(1), "$.\"b\"", int64(7)}},
		{"mssql", "keys",
			"UPDATE [shop].[sales].[orders] SET [doc] = JSON_MODIFY(JSON_MODIFY([doc], @p1, N''), @p2, NULL) WHERE [id] = @p3",
			"UPDATE [shop].[sales].[orders] SET [doc] = JSON_MODIFY(JSON_MODIFY([doc], N'$.\"q\\\"k\".\"a.b\".\"back\\\\s\".\"é\"', N''), N'strict $.\"q\\\"k\".\"a.b\".\"back\\\\s\".\"é\"', NULL) WHERE [id] = 7",
			[]any{"$.\"q\\\"k\".\"a.b\".\"back\\\\s\".\"é\"", "strict $.\"q\\\"k\".\"a.b\".\"back\\\\s\".\"é\"", int64(7)}},
	}
	for _, c := range cases {
		got, err := mustGet(t, c.kind).BuildChange(writeRef, jsonEditChange(jsonEditCases[c.name], "text"))
		if err != nil {
			t.Fatalf("%s %s: %v", c.kind, c.name, err)
		}
		if got.SQL != c.sql {
			t.Errorf("%s %s SQL\n got %s\nwant %s", c.kind, c.name, got.SQL, c.sql)
		}
		if got.Display != c.display {
			t.Errorf("%s %s Display\n got %s\nwant %s", c.kind, c.name, got.Display, c.display)
		}
		if !reflect.DeepEqual(got.Args, c.args) {
			t.Errorf("%s %s Args = %#v, want %#v", c.kind, c.name, got.Args, c.args)
		}
	}
}

// Postgres edits in jsonb, so other column types are cast in and back out.
func TestPostgresJSONEditCastsByColumnType(t *testing.T) {
	edits := jsonEditCases["remove"]
	for dataType, want := range map[string]string{
		"jsonb":                  `"doc" = ("doc" #- ARRAY[$1]::text[])`,
		"json":                   `"doc" = (("doc"::jsonb #- ARRAY[$1]::text[]))::json`,
		"character varying(200)": `"doc" = (("doc"::jsonb #- ARRAY[$1]::text[]))::text`,
	} {
		got, err := mustGet(t, KindPostgres).BuildChange(writeRef, jsonEditChange(edits, dataType))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(got.SQL, want) {
			t.Errorf("%s: %s\nwant it to contain %s", dataType, got.SQL, want)
		}
	}
}

// A rename reads the value before it twice, so an earlier edit's values are
// bound twice too, in the order the placeholders appear.
func TestJSONRenameRepeatsTheEditsBeforeIt(t *testing.T) {
	edits := []JSONEdit{
		{Op: JSONSet, Path: []PathStep{key("a")}, Value: `1`},
		{Op: JSONRename, Path: []PathStep{key("a")}, NewKey: "b"},
	}
	got, err := mustGet(t, KindSQLite).BuildChange(writeRef, jsonEditChange(edits, "text"))
	if err != nil {
		t.Fatal(err)
	}
	wantSQL := `UPDATE "orders" SET "doc" = json_set(json_remove(json_set("doc", ?, json(?)), ?), ?, json_set("doc", ?, json(?)) -> ?) WHERE "id" = ?`
	if got.SQL != wantSQL {
		t.Errorf("SQL\n got %s\nwant %s", got.SQL, wantSQL)
	}
	wantArgs := []any{`$."a"`, "1", `$."a"`, `$."b"`, `$."a"`, "1", `$."a"`, int64(7)}
	if !reflect.DeepEqual(got.Args, wantArgs) {
		t.Errorf("Args = %#v, want %#v", got.Args, wantArgs)
	}
}

func TestJSONAppendToTheRootArray(t *testing.T) {
	edits := []JSONEdit{{Op: JSONAppend, Value: `2`}}
	for kind, want := range map[Kind]string{
		KindSQLite:   `json_insert("doc", '$[#]', json('2'))`,
		KindMySQL:    "JSON_ARRAY_APPEND(`doc`, '$', JSON_EXTRACT('2', '$'))",
		KindPostgres: `jsonb_insert("doc"::jsonb, ARRAY['-1']::text[], '2'::jsonb, true)`,
		KindMSSQL:    `JSON_MODIFY([doc], N'append $', 2)`,
	} {
		got, err := mustGet(t, kind).BuildChange(writeRef, jsonEditChange(edits, "text"))
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		if !strings.Contains(got.Display, want) {
			t.Errorf("%s: %s\nwant it to contain %s", kind, got.Display, want)
		}
	}
}

// JSON_MODIFY stores a value by its SQL type, so each JSON type is bound as the
// SQL type that writes it back unchanged.
func TestMSSQLJSONValuesKeepTheirJSONType(t *testing.T) {
	cases := map[string]string{
		`{"a":[1]}`: `JSON_MODIFY([doc], N'$."k"', JSON_QUERY(N'{"a":[1]}'))`,
		`"s"`:       `JSON_MODIFY([doc], N'$."k"', N's')`,
		`true`:      `JSON_MODIFY([doc], N'$."k"', CAST(1 AS bit))`,
		`-42`:       `JSON_MODIFY([doc], N'$."k"', -42)`,
		`1.50`:      `JSON_MODIFY([doc], N'$."k"', CAST(N'1.50' AS decimal(3, 2)))`,
		`1.5e-3`:    `JSON_MODIFY([doc], N'$."k"', CAST(N'0.0015' AS decimal(5, 4)))`,
		`-2E+3`:     `JSON_MODIFY([doc], N'$."k"', CAST(N'-2000' AS decimal(4, 0)))`,
		` null `:    `JSON_MODIFY(JSON_MODIFY([doc], N'$."k"', N''), N'strict $."k"', NULL)`,
	}
	for v, want := range cases {
		edits := []JSONEdit{{Op: JSONSet, Path: []PathStep{key("k")}, Value: v}}
		got, err := mustGet(t, KindMSSQL).BuildChange(writeRef, jsonEditChange(edits, "nvarchar(max)"))
		if err != nil {
			t.Fatalf("%s: %v", v, err)
		}
		if !strings.Contains(got.Display, want) {
			t.Errorf("%s: %s\nwant it to contain %s", v, got.Display, want)
		}
	}
	edits := []JSONEdit{{Op: JSONAppend, Path: []PathStep{key("a")}, Value: `null`}}
	got, _ := mustGet(t, KindMSSQL).BuildChange(writeRef, jsonEditChange(edits, "nvarchar(max)"))
	if want := `JSON_MODIFY([doc], N'append strict $."a"', NULL)`; !strings.Contains(got.Display, want) {
		t.Errorf("append null: %s", got.Display)
	}
}

func TestMSSQLRefusesWhatJSONModifyCannotDo(t *testing.T) {
	for name, edits := range map[string][]JSONEdit{
		"array element": {{Op: JSONRemove, Path: []PathStep{key("a"), idx(0)}}},
		"39 digits":     {{Op: JSONSet, Path: []PathStep{key("a")}, Value: "1." + strings.Repeat("1", 38)}},
	} {
		_, err := mustGet(t, KindMSSQL).BuildChange(writeRef, jsonEditChange(edits, "nvarchar(max)"))
		if err == nil {
			t.Errorf("%s: built, want refused", name)
		} else if !strings.Contains(err.Error(), "whole value") {
			t.Errorf("%s: %v, want it to point at editing the whole value", name, err)
		}
	}
}

// JSON_MODIFY cannot address "$", so a rename at the root is the rebuilt object.
func TestMSSQLRootRenameIsTheRebuiltObject(t *testing.T) {
	edits := []JSONEdit{{Op: JSONRename, Path: []PathStep{key("a")}, NewKey: "b"}}
	got, err := mustGet(t, KindMSSQL).BuildChange(writeRef, jsonEditChange(edits, "nvarchar(max)"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got.SQL, "UPDATE [shop].[sales].[orders] SET [doc] = (SELECT N'{'") || strings.Contains(got.SQL, "JSON_MODIFY") {
		t.Errorf("SQL = %s", got.SQL)
	}
	if want := []any{"a", "b", "$", "b", int64(7)}; !reflect.DeepEqual(got.Args, want) {
		t.Errorf("Args = %#v, want %#v", got.Args, want)
	}
}

func TestJSONEditsOnAnInsertAreRefused(t *testing.T) {
	ch := Change{Op: ChangeInsert, Set: []Assignment{{Column: "doc", Edits: jsonEditCases["set"]}}}
	if _, err := mustGet(t, KindSQLite).BuildChange(writeRef, ch); err == nil {
		t.Fatal("an insert with JSON edits was built")
	}
}

// Short cuts a long JSON value like any other literal; SQL and Args keep it whole.
func TestJSONEditShortCutsALongValue(t *testing.T) {
	long := `"` + strings.Repeat("x", 300) + `"`
	edits := []JSONEdit{{Op: JSONSet, Path: []PathStep{key("a")}, Value: long}}
	got, err := mustGet(t, KindSQLite).BuildChange(writeRef, jsonEditChange(edits, "text"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.Short, "…(+142 more chars)") || !strings.Contains(got.Display, long) || got.Args[1] != long {
		t.Errorf("Short = %s", got.Short)
	}
}
