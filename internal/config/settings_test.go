package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultTextCapIsAKilobyte(t *testing.T) {
	if got := DefaultSettings().TextCapChars; got != 1024 {
		t.Errorf("default text cap is %d, want 1024", got)
	}
}

// 0 means "do not cap", so it must survive the clamp that exists to rescue
// nonsense values. Treating it as nonsense would make the setting impossible to
// turn off.
func TestTextCapZeroIsKept(t *testing.T) {
	s := DefaultSettings()
	s.TextCapChars = 0
	if got := s.clamp().TextCapChars; got != 0 {
		t.Errorf("a cap of 0 became %d; the cap can no longer be switched off", got)
	}
}

func TestAbsurdTextCapFallsBack(t *testing.T) {
	for _, in := range []int{-1, 2_000_000} {
		s := DefaultSettings()
		s.TextCapChars = in
		if got := s.clamp().TextCapChars; got != DefaultSettings().TextCapChars {
			t.Errorf("cap of %d clamped to %d, want the default", in, got)
		}
	}
}

// The new default must not rewrite a choice already on disk — someone who set
// 512 keeps 512 — while a file written before the setting existed picks the
// default up.
func TestSavedTextCapSurvivesADefaultChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte(`{"fontSizePx":16,"textCapChars":512}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := store.Get().TextCapChars; got != 512 {
		t.Errorf("stored cap became %d, want the 512 that was on disk", got)
	}

	older := filepath.Join(dir, "older.json")
	if err := os.WriteFile(older, []byte(`{"fontSizePx":16}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err = OpenSettings(older)
	if err != nil {
		t.Fatal(err)
	}
	if got := store.Get().TextCapChars; got != DefaultSettings().TextCapChars {
		t.Errorf("a file predating the setting got %d, want the default", got)
	}
}

// 0 ms is a real choice (no animation), so it must survive, while a file
// written before the setting existed must get the default rather than 0.
func TestDrawerDurationKeepsZeroButDefaultsWhenAbsent(t *testing.T) {
	dir := t.TempDir()
	zero := filepath.Join(dir, "zero.json")
	if err := os.WriteFile(zero, []byte(`{"drawerDurationMs":0}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := OpenSettings(zero)
	if err != nil {
		t.Fatal(err)
	}
	if got := store.Get().DrawerDurationMs; got != 0 {
		t.Errorf("a chosen 0 became %d", got)
	}

	older := filepath.Join(dir, "older.json")
	if err := os.WriteFile(older, []byte(`{"fontSizePx":16}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err = OpenSettings(older)
	if err != nil {
		t.Fatal(err)
	}
	if got := store.Get().DrawerDurationMs; got != DefaultSettings().DrawerDurationMs {
		t.Errorf("a file predating the setting got %d, want the default", got)
	}
}

// A theme id is a CSS selector on the other side, so an unknown one leaves the
// UI with no palette at all — a settings file from a newer build, or a typo in
// a hand-edited one, must land back on the default rather than on nothing.
func TestUnknownThemeFallsBack(t *testing.T) {
	for _, in := range []string{"", "solarized", "Gruvbox-Dark"} {
		s := DefaultSettings()
		s.Theme = in
		if got := s.clamp().Theme; got != DefaultSettings().Theme {
			t.Errorf("theme %q clamped to %q, want the default", in, got)
		}
	}
}

func TestKnownThemesSurviveTheClamp(t *testing.T) {
	for _, id := range ThemeIDs {
		s := DefaultSettings()
		s.Theme = id
		if got := s.clamp().Theme; got != id {
			t.Errorf("theme %q clamped to %q; it is in ThemeIDs and must be kept", id, got)
		}
	}
}

// The other half of the theme-id check; the TypeScript half is
// frontend/src/themes.test.ts. Every id the app will accept needs a palette to
// render, and a missing block is invisible at build time — the app just keeps
// whichever theme was already on screen.
func TestEveryThemeHasAPalette(t *testing.T) {
	css, err := os.ReadFile(filepath.Join("..", "..", "frontend", "src", "index.css"))
	if err != nil {
		t.Fatalf("reading index.css: %v", err)
	}
	for _, id := range ThemeIDs {
		// The default is the bare :root block, so it has no selector of its own.
		if id == ThemeIDs[0] {
			continue
		}
		want := fmt.Sprintf(":root[data-theme='%s']", id)
		if !strings.Contains(string(css), want) {
			t.Errorf("theme %q is offered but index.css has no %s block", id, want)
		}
	}
}
