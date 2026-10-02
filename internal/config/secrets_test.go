package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Cleancookie/ja-db/internal/driver"
	"github.com/zalando/go-keyring"
)

// fakeSecrets is an in-memory SecretStore that records what it was asked to do.
type fakeSecrets struct {
	values  map[string]string
	calls   []string
	setErr  map[string]error  // per-ref write failure
	corrupt map[string]string // per-ref value returned by Get regardless of Set
	getErr  error
}

func newFake() *fakeSecrets {
	return &fakeSecrets{values: map[string]string{}, setErr: map[string]error{}, corrupt: map[string]string{}}
}

func (f *fakeSecrets) Get(ref string) (string, error) {
	f.calls = append(f.calls, "get")
	if f.getErr != nil {
		return "", f.getErr
	}
	if v, ok := f.corrupt[ref]; ok {
		return v, nil
	}
	return f.values[ref], nil
}

func (f *fakeSecrets) Set(ref, v string) error {
	f.calls = append(f.calls, "set")
	if err := f.setErr[ref]; err != nil {
		return err
	}
	f.values[ref] = v
	return nil
}

func (f *fakeSecrets) Delete(ref string) error {
	f.calls = append(f.calls, "delete")
	delete(f.values, ref)
	return nil
}

func writeLegacy(t *testing.T, dir string, m map[string]string) string {
	t.Helper()
	b, _ := json.Marshal(m)
	p := filepath.Join(dir, "secrets.json")
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestMigrateFileSecrets(t *testing.T) {
	boom := errors.New("keyring locked")
	tests := []struct {
		name       string
		setErr     map[string]error
		corrupt    map[string]string
		getErr     error
		wantKR     map[string]string
		wantFile   map[string]string // nil means the file must be gone
		wantLegacy bool
	}{
		{
			name:   "success moves everything and removes the file",
			wantKR: map[string]string{"a": "pa", "b": "pb"},
		},
		{
			name:       "partial failure keeps the rest in the file",
			setErr:     map[string]error{"b": boom},
			wantKR:     map[string]string{"a": "pa"},
			wantFile:   map[string]string{"b": "pb"},
			wantLegacy: true,
		},
		{
			name:       "keyring unavailable leaves the file intact",
			setErr:     map[string]error{"a": boom, "b": boom},
			wantKR:     map[string]string{},
			wantFile:   map[string]string{"a": "pa", "b": "pb"},
			wantLegacy: true,
		},
		{
			name:       "read-back mismatch keeps the file and removes the wrong copy",
			corrupt:    map[string]string{"a": "garbled"},
			wantKR:     map[string]string{},
			wantFile:   map[string]string{"a": "pa", "b": "pb"},
			wantLegacy: true,
		},
		{
			name:       "read-back failure keeps the file",
			getErr:     boom,
			wantFile:   map[string]string{"a": "pa", "b": "pb"},
			wantLegacy: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := writeLegacy(t, dir, map[string]string{"a": "pa", "b": "pb"})
			kr := newFake()
			kr.setErr, kr.corrupt, kr.getErr = orEmpty(tc.setErr), orEmptyS(tc.corrupt), tc.getErr

			legacy := migrateFileSecrets(path, kr)

			if (legacy != nil) != tc.wantLegacy {
				t.Fatalf("legacy leftover = %v, want %v", legacy != nil, tc.wantLegacy)
			}
			if tc.wantKR != nil {
				if len(kr.values) != len(tc.wantKR) {
					t.Fatalf("keyring = %v, want %v", kr.values, tc.wantKR)
				}
				for k, v := range tc.wantKR {
					if kr.values[k] != v {
						t.Errorf("keyring[%s] = %q, want %q", k, kr.values[k], v)
					}
				}
			}
			b, err := os.ReadFile(path)
			if tc.wantFile == nil {
				if !os.IsNotExist(err) {
					t.Fatalf("secrets.json should be gone, err=%v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("secrets.json should remain: %v", err)
			}
			var got map[string]string
			_ = json.Unmarshal(b, &got)
			if len(got) != len(tc.wantFile) {
				t.Fatalf("file = %v, want %v", got, tc.wantFile)
			}
			for k, v := range tc.wantFile {
				if got[k] != v {
					t.Errorf("file[%s] = %q, want %q", k, got[k], v)
				}
			}
		})
	}
}

func orEmpty(m map[string]error) map[string]error {
	if m == nil {
		return map[string]error{}
	}
	return m
}

func orEmptyS(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

func TestMigrationIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	writeLegacy(t, dir, map[string]string{"a": "pa"})
	kr := newFake()
	for i := 0; i < 3; i++ {
		s, err := OpenWith(dir, kr, nil)
		if err != nil {
			t.Fatal(err)
		}
		if got, _ := s.Password("a"); got != "pa" {
			t.Fatalf("run %d: password = %q", i, got)
		}
	}
	if kr.values["a"] != "pa" || len(kr.values) != 1 {
		t.Fatalf("keyring = %v", kr.values)
	}
}

func TestUnmigratedPasswordIsStillReadableAndNotResurrected(t *testing.T) {
	dir := t.TempDir()
	writeLegacy(t, dir, map[string]string{"a": "old"})
	kr := newFake()
	kr.setErr["a"] = errors.New("locked")
	s, err := OpenWith(dir, kr, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Password("a"); got != "old" {
		t.Fatalf("got %q, want the legacy password while migration is pending", got)
	}
	delete(kr.setErr, "a")
	if err := s.setSecret("a", "new"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Password("a"); got != "new" {
		t.Fatalf("got %q after save, want new", got)
	}
	s2, _ := OpenWith(dir, kr, nil)
	if got, _ := s2.Password("a"); got != "new" {
		t.Fatalf("restart migrated the stale password over the new one: %q", got)
	}
}

func TestBackendReporting(t *testing.T) {
	boom := errors.New("no secret service")

	t.Run("keyring", func(t *testing.T) {
		s, err := OpenWith(t.TempDir(), newFake(), nil)
		if err != nil {
			t.Fatal(err)
		}
		if got := s.Backend(); got.Kind != BackendKeyring || got.Reason != "" {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("file fallback says why", func(t *testing.T) {
		s, err := OpenWith(t.TempDir(), nil, boom)
		if err != nil {
			t.Fatal(err)
		}
		if got := s.Backend(); got.Kind != BackendFile || got.Reason != boom.Error() {
			t.Errorf("got %+v", got)
		}
	})
	t.Run("no fallback after the keyring has been used", func(t *testing.T) {
		dir := t.TempDir()
		if _, err := OpenWith(dir, newFake(), nil); err != nil {
			t.Fatal(err)
		}
		s, err := OpenWith(dir, nil, boom)
		if err != nil {
			t.Fatal(err)
		}
		if got := s.Backend().Kind; got != BackendUnavailable {
			t.Fatalf("got %q, want unavailable", got)
		}
		if err := s.setSecret("x", "pw"); err == nil {
			t.Error("write must fail, not land in a plaintext file")
		}
		if _, err := os.Stat(filepath.Join(dir, "secrets.json")); !os.IsNotExist(err) {
			t.Errorf("secrets.json must not be created, err=%v", err)
		}
	})
}

func TestOpenTightensLooseDir(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("mode bits are not meaningful on Windows")
	}
	dir := filepath.Join(t.TempDir(), "ja-db")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenWith(dir, newFake(), nil); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(dir)
	if st.Mode().Perm() != 0o700 {
		t.Errorf("dir mode = %v, want 0700", st.Mode().Perm())
	}
}

func TestCreateWritesPasswordToKeyringNotToDisk(t *testing.T) {
	dir := t.TempDir()
	kr := newFake()
	s, _ := OpenWith(dir, kr, nil)
	c, err := s.Create(Connection{Name: "n", Kind: driver.KindMySQL, Host: "h"}, "hunter2")
	if err != nil {
		t.Fatal(err)
	}
	if kr.values[c.ID] != "hunter2" {
		t.Fatalf("keyring = %v", kr.values)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		b, _ := os.ReadFile(filepath.Join(dir, e.Name()))
		if string(b) != "" && strings.Contains(string(b), "hunter2") {
			t.Errorf("%s contains the password", e.Name())
		}
	}
}

func TestKeyringSecretsAndProbe(t *testing.T) {
	keyring.MockInit()
	if err := ProbeKeyring(); err != nil {
		t.Fatalf("probe on a working keyring: %v", err)
	}
	var k KeyringSecrets
	if got, err := k.Get("missing"); got != "" || err != nil {
		t.Errorf("missing = %q, %v; want empty and no error", got, err)
	}
	_ = k.Set("id", "pw")
	if got, _ := k.Get("id"); got != "pw" {
		t.Errorf("got %q", got)
	}
	if err := k.Delete("id"); err != nil {
		t.Fatal(err)
	}
	if err := k.Delete("id"); err != nil {
		t.Errorf("deleting twice should be fine: %v", err)
	}

	keyring.MockInitWithError(errors.New("no dbus"))
	if err := ProbeKeyring(); err == nil {
		t.Error("probe must fail when the keyring does")
	}
	keyring.MockInit()
}

func TestAskPasswordNeverTouchesTheSecretStore(t *testing.T) {
	kr := newFake()
	s, _ := OpenWith(t.TempDir(), kr, nil)
	kr.calls = nil

	c, err := s.Create(Connection{Name: "n", Kind: driver.KindMySQL, Host: "h", AskPassword: true}, "must-not-be-kept")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Update(c, ptr("also-ignored")); err != nil {
		t.Fatal(err)
	}
	if pw, err := s.Password(c.ID); pw != "" || err != nil {
		t.Fatalf("Password = %q, %v", pw, err)
	}
	cfg, err := s.DriverConfig(c.ID, "typed-now")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Password != "typed-now" {
		t.Errorf("driver config password = %q, want the one passed in", cfg.Password)
	}
	if err := s.Delete(c.ID); err != nil {
		t.Fatal(err)
	}
	if len(kr.calls) != 0 || len(kr.values) != 0 {
		t.Errorf("secret store was used: calls=%v values=%v", kr.calls, kr.values)
	}
}

func TestSwitchingToAskRemovesTheStoredPassword(t *testing.T) {
	kr := newFake()
	s, _ := OpenWith(t.TempDir(), kr, nil)
	c, _ := s.Create(Connection{Name: "n", Kind: driver.KindMySQL, Host: "h"}, "stored")
	if kr.values[c.ID] != "stored" {
		t.Fatal("setup: password not stored")
	}
	c.AskPassword = true
	if _, err := s.Update(c, ptr("ignored")); err != nil {
		t.Fatal(err)
	}
	if len(kr.values) != 0 {
		t.Errorf("stored password survived the switch: %v", kr.values)
	}
}

func ptr(s string) *string { return &s }
