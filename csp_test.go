package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestWithCSPSetsTheHeader(t *testing.T) {
	rec := httptest.NewRecorder()
	withCSP(http.NotFoundHandler()).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	got := rec.Header().Get("Content-Security-Policy")
	if got != contentSecurityPolicy || !strings.Contains(got, "script-src 'self'") {
		t.Errorf("header = %q", got)
	}
}

// The policy forbids inline script. If the source page ever gains one, the
// webview would show a blank window; fail here instead.
func TestIndexHTMLHasNoInlineScript(t *testing.T) {
	b, err := os.ReadFile("frontend/index.html")
	if err != nil {
		t.Fatal(err)
	}
	for _, tag := range regexp.MustCompile(`(?is)<script[^>]*>`).FindAll(b, -1) {
		if !regexp.MustCompile(`(?i)\bsrc=`).Match(tag) {
			t.Errorf("inline script in index.html: %s", tag)
		}
	}
	if m := regexp.MustCompile(`(?i)\son[a-z]+\s*=`).Find(b); m != nil {
		t.Errorf("inline event handler in index.html: %s", m)
	}
}
