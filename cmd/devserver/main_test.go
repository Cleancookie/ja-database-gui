package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
