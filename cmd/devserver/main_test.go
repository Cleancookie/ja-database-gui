package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Cleancookie/ja-db/internal/api"
	"github.com/Cleancookie/ja-db/internal/config"
	"github.com/Cleancookie/ja-db/internal/driver"
)

func testHandler(t *testing.T) http.Handler {
	t.Helper()
	svc, err := build(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Shutdown)
	return newHandler(svc)
}

func post(h http.Handler, method, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/"+method, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	return rec
}

func TestDriversEndpoint(t *testing.T) {
	rec := post(testHandler(t), "Drivers", `{}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body)
	}
	var got map[string]driver.Capabilities
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 4 {
		t.Errorf("want four dialects, got %d", len(got))
	}
}

// One request through the real stack, in the body shape api.ts sends.
func TestReadRowsOverHTTP(t *testing.T) {
	dir := t.TempDir()
	svc, err := build(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Shutdown)
	h := newHandler(svc)

	conn, err := svc.SaveConnection(api.SaveConnectionRequest{Connection: config.Connection{
		Name: "t", Kind: driver.KindSQLite, File: filepath.Join(dir, "t.db"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if rec := post(h, "RunSQL", `{"connectionId":"`+conn.ID+`","sql":"create table t(id integer primary key); insert into t values (1),(2)"}`); rec.Code != http.StatusOK {
		t.Fatalf("RunSQL: %d %s", rec.Code, rec.Body)
	}

	body := `{"connectionId":"` + conn.ID + `","ref":{"database":"main","name":"t","type":"table"},"filter":"","orderBy":[],"applyDefaultSort":true,"pagination":{"enabled":true,"page":1,"pageSize":50}}`
	rec := post(h, "ReadRows", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("ReadRows: %d %s", rec.Code, rec.Body)
	}
	var got api.ReadRowsResult
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Result.Rows) != 2 {
		t.Errorf("rows = %d, want 2", len(got.Result.Rows))
	}
}

func TestUnknownMethodIs404(t *testing.T) {
	if rec := post(testHandler(t), "DropEverything", `{}`); rec.Code != http.StatusNotFound {
		t.Errorf("status %d, want 404", rec.Code)
	}
}

func TestGetIsRejected(t *testing.T) {
	rec := httptest.NewRecorder()
	testHandler(t).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/Drivers", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("status %d, want 405", rec.Code)
	}
}

// A cross-origin form can POST text/plain to loopback without a preflight.
func TestNonJSONContentTypeIsRejected(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/Drivers", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "text/plain")
	testHandler(t).ServeHTTP(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("status %d, want 415", rec.Code)
	}
}

func TestAnErrorBecomesA500WithAMessage(t *testing.T) {
	rec := post(testHandler(t), "Connect", `{"id":"nope"}`)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"error"`) {
		t.Errorf("want an error field, got %s", rec.Body)
	}
}

func TestOnlyLoopbackIsServed(t *testing.T) {
	for addr, ok := range map[string]bool{
		"127.0.0.1:34567": true,
		"localhost:1":     true,
		"[::1]:34567":     true,
		":34567":          false,
		"0.0.0.0:34567":   false,
		"192.168.1.5:80":  false,
	} {
		if err := requireLoopback(addr); (err == nil) != ok {
			t.Errorf("requireLoopback(%q) = %v, want ok=%v", addr, err, ok)
		}
	}
}

// The two new routes, in the body shape api.ts sends: a conflict is a 200 with a
// result, and a change that does not fit the table is a 500 with a message.
func TestChangesOverHTTP(t *testing.T) {
	dir := t.TempDir()
	svc, err := build(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Shutdown)
	h := newHandler(svc)

	conn, err := svc.SaveConnection(api.SaveConnectionRequest{Connection: config.Connection{
		Name: "t", Kind: driver.KindSQLite, File: filepath.Join(dir, "t.db"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if rec := post(h, "RunSQL", `{"connectionId":"`+conn.ID+`","sql":"create table t(id integer primary key, n text); insert into t values (1,'a')"}`); rec.Code != http.StatusOK {
		t.Fatalf("RunSQL: %d %s", rec.Code, rec.Body)
	}
	target := `"connectionId":"` + conn.ID + `"`
	ref := `"ref":{"database":"main","schema":"","name":"t"},`

	rec := post(h, "PreviewChanges", `{`+target+`,"changes":[{`+ref+`"op":"update","key":{"id":1},"set":{"n":{"kind":"value","value":"b"}}}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("PreviewChanges: %d %s", rec.Code, rec.Body)
	}
	var prev api.ChangesPreview
	if err := json.Unmarshal(rec.Body.Bytes(), &prev); err != nil || len(prev.Statements) != 1 {
		t.Fatalf("preview = %s (%v)", rec.Body, err)
	}

	rec = post(h, "ApplyChanges", `{`+target+`,"changes":[{`+ref+`"op":"update","key":{"id":99},"set":{"n":{"kind":"null"}}}]}`)
	var res api.ApplyResult
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil || rec.Code != http.StatusOK {
		t.Fatalf("ApplyChanges: %d %s", rec.Code, rec.Body)
	}
	if res.Conflict == nil || res.Applied != 0 {
		t.Errorf("result = %+v, want a conflict", res)
	}

	rec = post(h, "ApplyChanges", `{`+target+`,"changes":[{`+ref+`"op":"update","key":{"nope":1},"set":{"n":{"kind":"null"}}}]}`)
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), "not part of the key") {
		t.Errorf("a mismatched key: %d %s, want a 500 saying why", rec.Code, rec.Body)
	}
}

// A Service method with no route is a capability the browser transport silently
// lacks. Shutdown is the lifecycle hook, not API.
// api.ts sends one loose scalar as {id}; an id nothing kept is an answer, not
// an error.
func TestQuerySQLOverHTTP(t *testing.T) {
	rec := post(testHandler(t), "QuerySQL", `{"id":"q999999"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d, body %s", rec.Code, rec.Body)
	}
	var got api.QuerySQLResult
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || got.Kept {
		t.Fatalf("body %s, err %v, want kept=false", rec.Body, err)
	}
}

func TestEveryServiceMethodHasARoute(t *testing.T) {
	svc, err := build(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Shutdown)
	table := routes(svc)

	typ := reflect.TypeOf(svc)
	for i := 0; i < typ.NumMethod(); i++ {
		name := typ.Method(i).Name
		if _, ok := table[name]; !ok && name != "Shutdown" {
			t.Errorf("api.Service.%s has no devserver route", name)
		}
	}
}
