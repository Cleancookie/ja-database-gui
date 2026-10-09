package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// fakeGitHub serves one release with the given exe body and sums file.
func fakeGitHub(t *testing.T, tag string, exe []byte, sums string) *Checker {
	t.Helper()
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	mux.HandleFunc("/latest", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": tag,
			"body":     "notes",
			"html_url": "https://example.test/" + tag,
			"assets": []map[string]string{
				{"name": Asset, "browser_download_url": srv.URL + "/exe"},
				{"name": Sums, "browser_download_url": srv.URL + "/sums"},
			},
		})
	})
	mux.HandleFunc("/exe", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(exe) })
	mux.HandleFunc("/sums", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(sums)) })
	return &Checker{LatestURL: srv.URL + "/latest", HTTP: srv.Client()}
}

func sumsFor(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]) + "  " + Asset + "\n"
}

func TestCheckComparesVersions(t *testing.T) {
	cases := []struct {
		current, latest string
		newer           bool
	}{
		{"v0.1.0", "v0.2.0", true},
		{"v0.2.0", "v0.2.0", false},
		{"v0.10.0", "v0.9.0", false},
		{"v0.1.0-3-gabc123-dirty", "v0.1.1", true},
		{"v0.1.0-3-gabc123", "v0.1.0", false},
		{"dev", "v9.9.9", false},
		{"df1d85a", "v0.1.0", false},
	}
	for _, c := range cases {
		r, err := fakeGitHub(t, c.latest, nil, "").Check(context.Background(), c.current)
		if err != nil {
			t.Fatal(err)
		}
		if r.Newer != c.newer {
			t.Errorf("%s → %s: newer = %v, want %v", c.current, c.latest, r.Newer, c.newer)
		}
	}
}

func TestCheckWithNoReleases(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(srv.Close)
	r, err := (&Checker{LatestURL: srv.URL, HTTP: srv.Client()}).Check(context.Background(), "v0.1.0")
	if err != nil || r.Newer || r.Latest != "" {
		t.Fatalf("got %+v, %v", r, err)
	}
}

func TestApplySwapsTheExe(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, Asset)
	if err := os.WriteFile(exe, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte("new build")
	if _, err := fakeGitHub(t, "v0.2.0", body, sumsFor(body)).Apply(context.Background(), "v0.1.0", exe); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(exe); string(got) != "new build" {
		t.Fatalf("exe = %q", got)
	}
	if got, _ := os.ReadFile(exe + ".old"); string(got) != "old" {
		t.Fatalf("exe.old = %q", got)
	}
	Cleanup(exe)
	if _, err := os.Stat(exe + ".old"); !os.IsNotExist(err) {
		t.Fatalf("exe.old survived cleanup: %v", err)
	}
}

func TestApplyRefusesABadChecksum(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, Asset)
	if err := os.WriteFile(exe, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	c := fakeGitHub(t, "v0.2.0", []byte("tampered"), sumsFor([]byte("genuine")))
	if _, err := c.Apply(context.Background(), "v0.1.0", exe); err == nil {
		t.Fatal("applied a build that does not match its checksum")
	}
	if got, _ := os.ReadFile(exe); string(got) != "old" {
		t.Fatalf("exe = %q, want it untouched", got)
	}
	if _, err := os.Stat(exe + ".new"); !os.IsNotExist(err) {
		t.Fatalf("partial download left behind: %v", err)
	}
}

func TestApplyWhenUpToDate(t *testing.T) {
	if _, err := fakeGitHub(t, "v0.1.0", nil, "").Apply(context.Background(), "v0.1.0", "unused"); err == nil {
		t.Fatal("applied when already up to date")
	}
}
