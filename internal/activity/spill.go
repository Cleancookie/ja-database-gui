package activity

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The ring keeps a short preview of each statement in memory. When the full
// text is longer than that, it is written to a file in a per-process temp
// directory and read back only when the user asks to see it.
//
// Bounded by the ring: a file is removed when its slot is overwritten or the
// log is cleared, so there are never more than historySize of them. The
// directory goes when the app exits, and anything a crash leaves behind is
// swept by the next start.
//
// Only statement text and the error message are written. Bound arguments and
// row values are never logged, here or anywhere else in the app.
const (
	sqlPreviewRunes = 300
	spillCapBytes   = 1 << 20

	spillDirPrefix = "ja-db-activity-"
	staleAfter     = 7 * 24 * time.Hour
)

// spillFile is the on-disk shape of one entry.
type spillFile struct {
	SQL   string `json:"sql"`
	Error string `json:"error,omitempty"`
}

// preview returns the first n runes of s and whether anything was cut.
func preview(s string, n int) (string, bool) {
	count := 0
	for i := range s {
		if count == n {
			return s[:i] + "…", true
		}
		count++
	}
	return s, false
}

// capBytes cuts on a rune boundary, so a multi-byte character at the limit is
// not left half-written into the JSON.
func capBytes(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && !runeStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

func runeStart(b byte) bool { return b&0xC0 != 0x80 }

// spillDir returns the directory, creating it on first use, or "" when spilling
// is unavailable. Lazy, so a registry that never sees a long statement (every
// test, most sessions) touches no disk.
func (r *Registry) spillDir() string {
	r.dirOnce.Do(func() {
		dir, err := os.MkdirTemp("", spillDirPrefix+strconv.Itoa(os.Getpid())+"-")
		if err == nil {
			r.dir = dir
		}
	})
	return r.dir
}

// spill writes one entry's full text and returns the file's base name, or ""
// if it could not be written.
func (r *Registry) spill(id, sql, errText string) string {
	dir := r.spillDir()
	if dir == "" {
		return ""
	}
	data, err := json.Marshal(spillFile{
		SQL:   capBytes(sql, spillCapBytes),
		Error: capBytes(errText, spillCapBytes),
	})
	if err != nil {
		return ""
	}
	name := id + ".json"
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
		return ""
	}
	return name
}

func (r *Registry) readSpill(name string) (spillFile, bool) {
	dir := r.spillDir()
	if dir == "" || name == "" {
		return spillFile{}, false
	}
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return spillFile{}, false
	}
	var f spillFile
	if json.Unmarshal(data, &f) != nil {
		return spillFile{}, false
	}
	return f, true
}

// removeSpills deletes files whose ring slot has gone. Called after the
// registry lock is released.
func (r *Registry) removeSpills(names []string) {
	var dir string
	for _, n := range names {
		// A slot with no file is "", and joining that would name the
		// directory itself.
		if n == "" {
			continue
		}
		if dir == "" {
			if dir = r.spillDir(); dir == "" {
				return
			}
		}
		_ = os.Remove(filepath.Join(dir, n))
	}
}

// Close removes the spill directory. Safe to call more than once. After it,
// nothing new is spilled and full text of older entries is no longer kept.
func (r *Registry) Close() {
	// Claims the once, so a spill racing with Close cannot create a fresh
	// directory that nothing would remove.
	r.dirOnce.Do(func() {})
	if r.dir != "" {
		_ = os.RemoveAll(r.dir)
	}
}

var sweepOnce sync.Once

// sweepStaleOnce clears the spill directories that crashed or killed sessions
// left in the temp directory. Once per process, off the start-up path.
func sweepStaleOnce() {
	sweepOnce.Do(func() { go sweepStale(os.TempDir(), time.Now(), pidAlive) })
}

// sweepStale removes spill directories whose owner is gone. Errors are
// ignored: this is housekeeping, and the worst case is a directory that waits
// for the next start.
//
// alive reports whether a pid is running, and whether it can tell at all. Where
// it can, a live pid is never touched, whatever the age. Where it cannot
// (Windows), the directory's age is the only signal.
func sweepStale(tmp string, now time.Time, alive func(pid int) (running, known bool)) {
	entries, err := os.ReadDir(tmp)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), spillDirPrefix) {
			continue
		}
		pidStr, _, ok := strings.Cut(strings.TrimPrefix(e.Name(), spillDirPrefix), "-")
		pid, perr := strconv.Atoi(pidStr)
		if !ok || perr != nil {
			continue
		}
		running, known := alive(pid)
		stale := false
		if known {
			stale = !running
		} else if info, err := e.Info(); err == nil {
			stale = now.Sub(info.ModTime()) > staleAfter
		}
		if stale {
			_ = os.RemoveAll(filepath.Join(tmp, e.Name()))
		}
	}
}
