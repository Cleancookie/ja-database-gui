package api

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Cleancookie/ja-db/internal/driver"
)

func readOrders(t *testing.T, svc *Service, id, table string) *ReadRowsResult {
	t.Helper()
	res, err := svc.ReadRows(context.Background(), ReadRowsRequest{
		ConnectionID: id,
		Ref:          driver.ObjectRef{Database: "main", Name: table},
		Pagination:   Pagination{Enabled: true, Page: 1, PageSize: 50},
	})
	if err != nil {
		t.Fatalf("reading %s: %v", table, err)
	}
	return res
}

func TestReadRowsReportsTheEditKey(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 2)

	res := readOrders(t, svc, id, "orders")
	if len(res.EditKey) != 1 || res.EditKey[0] != "id" || res.ReadOnlyReason != "" {
		t.Errorf("EditKey = %v, reason %q; want [id] and no reason", res.EditKey, res.ReadOnlyReason)
	}
	for _, c := range res.Columns {
		if !c.Editable {
			t.Errorf("column %s should be editable", c.Name)
		}
	}
}

func TestReadRowsMarksViewsAndKeylessTablesReadOnly(t *testing.T) {
	svc, id := newTestService(t)
	seed(t, svc, id, 1)
	mustRun(t, svc, id, `CREATE TABLE nokey (a INTEGER, b TEXT)`)

	for _, table := range []string{"big_orders", "nokey"} {
		res := readOrders(t, svc, id, table)
		if len(res.EditKey) != 0 || res.ReadOnlyReason == "" {
			t.Errorf("%s: EditKey = %v, reason %q; want no key and a reason", table, res.EditKey, res.ReadOnlyReason)
		}
		for _, c := range res.Columns {
			if c.Editable || c.ReadOnlyReason == "" {
				t.Errorf("%s.%s: editable=%v reason=%q; want read-only with a reason", table, c.Name, c.Editable, c.ReadOnlyReason)
			}
		}
	}
}

func TestReadRowsMarksBinaryColumnsReadOnly(t *testing.T) {
	svc, id := newTestService(t)
	mustRun(t, svc, id, `CREATE TABLE files (id INTEGER PRIMARY KEY, name TEXT, data BLOB)`)

	res := readOrders(t, svc, id, "files")
	got := map[string]bool{}
	for _, c := range res.Columns {
		got[c.Name] = c.Editable
	}
	if !got["id"] || !got["name"] || got["data"] {
		t.Errorf("editable = %v, want id and name editable and data not", got)
	}
}

// The grid's column shape must stay a superset of driver.Column on the wire.
func TestGridColumnFlattensIntoTheColumnShape(t *testing.T) {
	b, err := json.Marshal(GridColumn{Column: driver.Column{Name: "id", DataType: "int"}, Editable: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"name":"id"`, `"dataType":"int"`, `"editable":true`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("%s missing %s", b, want)
		}
	}
}
