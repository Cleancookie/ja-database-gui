package api

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/Cleancookie/ja-db/internal/driver"
)

func jsonCell(edits ...JSONEdit) CellValue { return CellValue{Kind: "json", Edits: edits} }

func set(v string, path ...any) JSONEdit      { return JSONEdit{Op: "set", Path: path, Value: v} }
func appendTo(v string, path ...any) JSONEdit { return JSONEdit{Op: "append", Path: path, Value: v} }
func remove(path ...any) JSONEdit             { return JSONEdit{Op: "remove", Path: path} }
func rename(to string, path ...any) JSONEdit {
	return JSONEdit{Op: "rename", Path: path, NewKey: to}
}

// jsonScenario is one cell's worth of every op, run on SQLite here and on live
// servers in live_test.go. Index steps are float64, as JSON decodes them.
var jsonScenario = struct {
	before string
	edits  []JSONEdit
	after  string
}{
	before: `{"a":{"old":[1,{"x":"y"}],"keep":true},"tags":["t1"],"n":1,"str":"v","flag":false,"q\"k":{"a.b":1},"gone":0}`,
	edits: []JSONEdit{
		set(`{"deep":[null,1.50]}`, "a", "keep"),
		set(`"str\"\\é"`, "added"),
		set(`2`, `q"k`, "a.b"),
		rename("new", "a", "old"),
		rename("num", "n"),
		rename("str2", "str"),
		rename("flag2", "flag"),
		appendTo(`{"t":2}`, "tags"),
		appendTo(`null`, "tags"),
		remove("gone"),
		remove("tags", float64(0)),
		set(`null`, "s"),
	},
	after: `{"a":{"new":[1,{"x":"y"}],"keep":{"deep":[null,1.5]}},"tags":[{"t":2},null],"num":1,"str2":"v","flag2":false,"q\"k":{"a.b":2},"added":"str\"\\é","s":null}`,
}

// sameJSON compares by meaning: key order and number spelling may differ.
func sameJSON(t *testing.T, got, want string) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal([]byte(got), &g); err != nil {
		t.Fatalf("stored value is not JSON: %v\n%s", err, got)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Errorf("JSON\n got %s\nwant %s", got, want)
	}
}

func jsonTable(t *testing.T) (*Service, string, driver.ObjectRef) {
	t.Helper()
	svc, id := newTestService(t)
	mustRun(t, svc, id, `CREATE TABLE docs (id INTEGER PRIMARY KEY, doc TEXT, n INTEGER)`)
	ref := driver.ObjectRef{Database: "main", Name: "docs"}
	res := apply(t, svc, changes(id, ref, RowChange{Op: "insert", Set: map[string]CellValue{"id": val("1"), "doc": val(jsonScenario.before)}}))
	if res.Conflict != nil {
		t.Fatal(res.Conflict.Message)
	}
	return svc, id, ref
}

func TestJSONEditsApplyInOrderOnSQLite(t *testing.T) {
	svc, id, ref := jsonTable(t)
	res := apply(t, svc, changes(id, ref, update(1, map[string]CellValue{"doc": jsonCell(jsonScenario.edits...)})))
	if res.Conflict != nil {
		t.Fatal(res.Conflict.Message)
	}
	sameJSON(t, scalar(t, svc, id, `SELECT doc FROM docs WHERE id = 1`), jsonScenario.after)
}

func TestJSONEditsAppendToARootArray(t *testing.T) {
	svc, id, ref := jsonTable(t)
	apply(t, svc, changes(id, ref, update(1, map[string]CellValue{"doc": val(`[1]`)})))
	apply(t, svc, changes(id, ref, update(1, map[string]CellValue{"doc": jsonCell(appendTo(`[2]`))})))
	sameJSON(t, scalar(t, svc, id, `SELECT doc FROM docs WHERE id = 1`), `[1,[2]]`)
}

func TestJSONEditStatementCell(t *testing.T) {
	svc, id, ref := jsonTable(t)
	prev, err := svc.PreviewChanges(context.Background(), changes(id, ref, update(1, map[string]CellValue{
		"doc": jsonCell(set(`"héllo"`, "a"), remove("b"), set(`[1]`, "c")),
	})))
	if err != nil {
		t.Fatal(err)
	}
	want := []StatementCell{{Column: "doc", Kind: "json", Chars: 10, Edits: 3}}
	if got := prev.Statements[0].Cells; !reflect.DeepEqual(got, want) {
		t.Errorf("cells = %+v, want %+v", got, want)
	}
	if !strings.Contains(prev.Statements[0].Display, `json_set(json_remove(json_set("doc", '$."a"', json('"héllo"')), '$."b"'), '$."c"', json('[1]'))`) {
		t.Errorf("display = %s", prev.Statements[0].Display)
	}
}

func TestJSONEditsThatAreMalformedAreRefused(t *testing.T) {
	svc, id, ref := jsonTable(t)
	cases := []struct {
		name   string
		change RowChange
		want   string
	}{
		{"insert", RowChange{Op: "insert", Set: map[string]CellValue{"id": val("2"), "doc": jsonCell(set("1", "a"))}}, "only an update"},
		{"no edits", update(1, map[string]CellValue{"doc": jsonCell()}), "no JSON edits"},
		{"integer column", update(1, map[string]CellValue{"n": jsonCell(set("1", "a"))}), "cannot hold JSON"},
		{"bad value", update(1, map[string]CellValue{"doc": jsonCell(set("{nope", "a"))}), "not valid JSON"},
		{"empty set path", update(1, map[string]CellValue{"doc": jsonCell(set("1"))}), "path is empty"},
		{"empty remove path", update(1, map[string]CellValue{"doc": jsonCell(remove())}), "path is empty"},
		{"negative index", update(1, map[string]CellValue{"doc": jsonCell(remove("a", float64(-1)))}), "neither"},
		{"fractional index", update(1, map[string]CellValue{"doc": jsonCell(remove("a", 1.5))}), "neither"},
		{"bool step", update(1, map[string]CellValue{"doc": jsonCell(remove(true))}), "neither"},
		{"rename index", update(1, map[string]CellValue{"doc": jsonCell(rename("b", "a", float64(0)))}), "object key"},
		{"rename no key", update(1, map[string]CellValue{"doc": jsonCell(rename("", "a"))}), "no new key"},
		{"rename same", update(1, map[string]CellValue{"doc": jsonCell(rename("a", "a"))}), "already has"},
		{"unknown op", update(1, map[string]CellValue{"doc": jsonCell(JSONEdit{Op: "merge", Path: []any{"a"}})}), "unknown op"},
	}
	for _, c := range cases {
		_, err := svc.PreviewChanges(context.Background(), changes(id, ref, c.change))
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want it to mention %q", c.name, err, c.want)
		}
	}
}

func TestJSONEditTypesTheColumnMustBe(t *testing.T) {
	for typ, ok := range map[string]bool{
		"json": true, "jsonb": true, "text": true, "longtext": true, "character varying(20)": true,
		"nvarchar(max)": true, "": true, "integer": false, "bytea": false, "timestamp": false,
	} {
		if got := driver.HoldsJSON(driver.Column{DataType: typ}); got != ok {
			t.Errorf("%q: HoldsJSON = %v, want %v", typ, got, ok)
		}
	}
}
