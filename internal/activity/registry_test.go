package activity

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBeginListsThenFinishes(t *testing.T) {
	r := New()

	ctx, done := r.Begin(context.Background(), "c1", "shop", KindBrowse, "select 1")

	got := r.List()
	if len(got) != 1 {
		t.Fatalf("List() = %d entries, want 1", len(got))
	}
	if got[0].ConnectionID != "c1" || got[0].Kind != KindBrowse || got[0].SQL != "select 1" {
		t.Fatalf("unexpected entry: %+v", got[0])
	}
	if got[0].Phase != PhaseQueued {
		t.Fatalf("Phase = %q, want %q before anything reports in", got[0].Phase, PhaseQueued)
	}
	if err := ctx.Err(); err != nil {
		t.Fatalf("context cancelled before finish: %v", err)
	}

	done(nil)
	got = r.List()
	if len(got) != 1 || got[0].Phase != PhaseDone {
		t.Fatalf("List() = %+v, want one done entry", got)
	}
	// Always released, including on the success path, or the context leaks.
	if ctx.Err() == nil {
		t.Fatal("context still live after finish")
	}
}

func TestPhaseAndRowsComeFromTheContext(t *testing.T) {
	r := New()
	ctx, done := r.Begin(context.Background(), "c1", "", KindQuery, "select 1")

	SetPhase(ctx, PhaseExecuting)
	if p := r.List()[0].Phase; p != PhaseExecuting {
		t.Fatalf("Phase = %q, want %q", p, PhaseExecuting)
	}

	SetPhase(ctx, PhaseReading)
	AddRows(ctx, 512)
	AddRows(ctx, 8)
	got := r.List()[0]
	if got.Phase != PhaseReading || got.RowsRead != 520 {
		t.Fatalf("got phase %q rows %d, want %q 520", got.Phase, got.RowsRead, PhaseReading)
	}

	done(nil)
	if rows := r.List()[0].RowsRead; rows != 520 {
		t.Fatalf("RowsRead = %d after finish, want the final 520", rows)
	}
}

// Reporting through a context that carries no tracker has to be a no-op:
// "Test connection" and every test in this repo run queries that way.
func TestReportingWithoutATrackerIsANoOp(t *testing.T) {
	SetPhase(context.Background(), PhaseReading)
	AddRows(context.Background(), 5)
}

// The tray's timer counts forward from ElapsedMS while a query runs, and stops
// at the value recorded when it finished.
func TestElapsedIsMeasuredThenFrozen(t *testing.T) {
	r := New()
	_, done := r.Begin(context.Background(), "c1", "", KindQuery, "select 1")

	time.Sleep(15 * time.Millisecond)
	live := r.List()[0].ElapsedMS
	if live < 10 {
		t.Fatalf("ElapsedMS = %d while running, want at least 10", live)
	}

	done(nil)
	final := r.List()[0].ElapsedMS
	time.Sleep(15 * time.Millisecond)
	if again := r.List()[0].ElapsedMS; again != final {
		t.Fatalf("ElapsedMS moved after finish: %d then %d", final, again)
	}
}

func TestFailureIsRecordedWithItsMessage(t *testing.T) {
	r := New()
	_, done := r.Begin(context.Background(), "c1", "", KindQuery, "select boom")
	done(errors.New("near \"boom\": syntax error"))

	got := r.List()[0]
	if got.Phase != PhaseFailed || !strings.Contains(got.Error, "syntax error") {
		t.Fatalf("got %+v, want a failed entry carrying the message", got)
	}
}

func TestCancelMarksThenStops(t *testing.T) {
	r := New()
	ctx, done := r.Begin(context.Background(), "c1", "", KindQuery, "select sleep(30)")

	id := r.List()[0].ID
	r.Cancel(id)

	if ctx.Err() == nil {
		t.Fatal("cancelled query context is still live")
	}
	// It stays listed until it unwinds, flagged, so the row does not look stuck.
	if got := r.List(); len(got) != 1 || got[0].Phase != PhaseCancelling {
		t.Fatalf("List() = %+v, want one entry cancelling", got)
	}

	// The driver's own error is cancellation noise; the user's intent is what
	// the history should say.
	done(context.Canceled)
	if got := r.List(); got[0].Phase != PhaseCancelled {
		t.Fatalf("Phase = %q, want %q", got[0].Phase, PhaseCancelled)
	}

	// Cancelling something that has already gone is not an error: by the time a
	// click arrives the query may well be done.
	r.Cancel(id)
}

func TestCancelConnectionStopsOnlyThatConnection(t *testing.T) {
	r := New()
	mine, done1 := r.Begin(context.Background(), "c1", "", KindBrowse, "select 1")
	defer done1(nil)
	theirs, done2 := r.Begin(context.Background(), "c2", "", KindBrowse, "select 2")
	defer done2(nil)

	r.CancelConnection("c1")

	if mine.Err() == nil {
		t.Fatal("query on the disconnected connection is still live")
	}
	if theirs.Err() != nil {
		t.Fatalf("query on another connection was cancelled: %v", theirs.Err())
	}
}

func TestListPutsRunningAboveHistoryNewestFirst(t *testing.T) {
	r := New()
	for _, sql := range []string{"first", "second"} {
		_, done := r.Begin(context.Background(), "c1", "", KindQuery, sql)
		time.Sleep(2 * time.Millisecond)
		done(nil)
	}
	_, live := r.Begin(context.Background(), "c1", "", KindBrowse, "running")
	defer live(nil)

	got := r.List()
	want := []string{"running", "second", "first"}
	if len(got) != len(want) {
		t.Fatalf("List() = %d entries, want %d", len(got), len(want))
	}
	for i, sql := range want {
		if got[i].SQL != sql {
			t.Fatalf("entry %d = %q, want %q (order: running, then newest history)", i, got[i].SQL, sql)
		}
	}
}

func TestHistoryIsBoundedAndDropsTheOldest(t *testing.T) {
	r := New()
	for i := 0; i < historySize+20; i++ {
		_, done := r.Begin(context.Background(), "c1", "", KindQuery, "q")
		done(nil)
	}

	got := r.List()
	if len(got) != historySize {
		t.Fatalf("List() = %d entries, want the %d-entry bound", len(got), historySize)
	}
	// Newest first, and the first twenty ids are gone. Derived from
	// historySize rather than written out, so changing the bound does not mean
	// hand-editing two magic ids.
	newest := fmt.Sprintf("q%03d", historySize+20)
	oldest := fmt.Sprintf("q%03d", 21)
	if got[0].ID != newest || got[len(got)-1].ID != oldest {
		t.Fatalf("ring holds %s…%s, want %s…%s", got[0].ID, got[len(got)-1].ID, newest, oldest)
	}
}

// Catalogue reads are retained like anything else. They were dropped once, and
// the result was a log that could not be trusted: a describe was visible for
// the few milliseconds it ran and then vanished, so it looked as though it had
// never been recorded. The tray filters them out of the view instead, which the
// user can reverse.
func TestIntrospectionIsRetained(t *testing.T) {
	r := New()
	_, done := r.Begin(context.Background(), "c1", "", KindIntrospect, "describe auth.users")
	if len(r.List()) != 1 {
		t.Fatal("introspection should be visible while it runs")
	}
	done(nil)

	got := r.List()
	if len(got) != 1 {
		t.Fatalf("List() = %d entries, want the finished introspection kept", len(got))
	}
	if got[0].Kind != KindIntrospect || got[0].Phase != PhaseDone {
		t.Fatalf("got %+v, want a done introspect entry", got[0])
	}
	if got[0].SQL != "describe auth.users" {
		t.Fatalf("SQL = %q, want the label preserved", got[0].SQL)
	}
}

func TestClearHistoryKeepsRunningQueries(t *testing.T) {
	r := New()
	_, done := r.Begin(context.Background(), "c1", "", KindQuery, "finished")
	done(nil)
	_, live := r.Begin(context.Background(), "c1", "", KindQuery, "running")
	defer live(nil)

	r.ClearHistory()

	got := r.List()
	if len(got) != 1 || got[0].SQL != "running" {
		t.Fatalf("List() = %+v, want only the running query", got)
	}
}

// spillFiles lists what is in the registry's spill directory.
func spillFiles(t *testing.T, r *Registry) []string {
	t.Helper()
	if r.dir == "" {
		return nil
	}
	entries, err := os.ReadDir(r.dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// finishLong runs one statement too long for the preview to completion and
// returns its id.
func finishLong(r *Registry, n int, err error) string {
	ctx, done := r.Begin(context.Background(), "c1", "", KindQuery, strings.Repeat("x", n))
	id := IDOf(ctx)
	done(err)
	return id
}

func newRegistry(t *testing.T) *Registry {
	t.Helper()
	r := New()
	t.Cleanup(r.Close)
	return r
}

func TestPreviewIsShortAndFlagged(t *testing.T) {
	r := newRegistry(t)
	long := strings.Repeat("あ", sqlPreviewRunes*3)
	ctx, done := r.Begin(context.Background(), "c1", "", KindQuery, long)
	id := IDOf(ctx)

	// The poll gets the preview while running too, not the whole statement.
	got := r.List()[0]
	if !got.SQLTruncated || got.SQL != strings.Repeat("あ", sqlPreviewRunes)+"…" {
		t.Fatalf("running: truncated=%v, SQL has %d runes", got.SQLTruncated, len([]rune(got.SQL)))
	}
	if sql, _, ok := r.Full(id); !ok || sql != long {
		t.Fatalf("Full of a running query = ok %v, %d bytes, want all %d", ok, len(sql), len(long))
	}

	done(nil)
	got = r.List()[0]
	if !got.SQLTruncated || got.SQL != strings.Repeat("あ", sqlPreviewRunes)+"…" {
		t.Fatalf("finished: truncated=%v, SQL has %d runes", got.SQLTruncated, len([]rune(got.SQL)))
	}
	if sql, _, ok := r.Full(id); !ok || sql != long {
		t.Fatalf("Full after finish = ok %v, %d bytes, want all %d", ok, len(sql), len(long))
	}
}

func TestShortStatementsAreNotSpilled(t *testing.T) {
	r := newRegistry(t)
	_, done := r.Begin(context.Background(), "c1", "", KindQuery, "select 1")
	done(nil)
	got := r.List()[0]
	if got.SQLTruncated || got.ErrorTruncated {
		t.Fatalf("flags set on a short statement: %+v", got)
	}
	if r.dir != "" {
		t.Fatal("a spill directory was made for a statement that fits in memory")
	}
	if sql, _, ok := r.Full(got.ID); !ok || sql != "select 1" {
		t.Fatalf("Full = %q, %v", sql, ok)
	}
}

func TestLongErrorIsSpilledAndFlagged(t *testing.T) {
	r := newRegistry(t)
	msg := strings.Repeat("e", historyErrorLimit*3)
	ctx, done := r.Begin(context.Background(), "c1", "", KindQuery, "select 1")
	id := IDOf(ctx)
	done(errors.New(msg))

	got := r.List()[0]
	if !got.ErrorTruncated || got.SQLTruncated {
		t.Fatalf("flags = sql %v, error %v, want error only", got.SQLTruncated, got.ErrorTruncated)
	}
	sql, errText, ok := r.Full(id)
	if !ok || sql != "select 1" || errText != msg {
		t.Fatalf("Full = %q, %d-byte error, %v", sql, len(errText), ok)
	}
}

func TestSpillFileIsPrivate(t *testing.T) {
	r := newRegistry(t)
	finishLong(r, sqlPreviewRunes*2, nil)
	files := spillFiles(t, r)
	if len(files) != 1 {
		t.Fatalf("files = %v, want one", files)
	}
	info, err := os.Stat(filepath.Join(r.dir, files[0]))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 && os.PathSeparator == '/' {
		t.Fatalf("spill file mode %v is readable by others", perm)
	}
}

func TestSpillIsCapped(t *testing.T) {
	r := newRegistry(t)
	id := finishLong(r, spillCapBytes*2, nil)
	sql, _, ok := r.Full(id)
	if !ok || len(sql) > spillCapBytes+len("…") {
		t.Fatalf("Full = %d bytes, ok %v, want at most the %d-byte cap", len(sql), ok, spillCapBytes)
	}
}

func TestRingEvictionRemovesTheFile(t *testing.T) {
	r := newRegistry(t)
	first := finishLong(r, sqlPreviewRunes*2, nil)
	for i := 0; i < historySize; i++ {
		_, done := r.Begin(context.Background(), "c1", "", KindQuery, "q")
		done(nil)
	}
	if files := spillFiles(t, r); len(files) != 0 {
		t.Fatalf("files = %v, want the evicted entry's file gone", files)
	}
	if _, _, ok := r.Full(first); ok {
		t.Fatal("Full still finds an entry that left the ring")
	}
}

func TestSpillFilesAreBoundedByTheRing(t *testing.T) {
	r := newRegistry(t)
	for i := 0; i < historySize+25; i++ {
		finishLong(r, sqlPreviewRunes*2, nil)
	}
	if got := len(spillFiles(t, r)); got != historySize {
		t.Fatalf("%d files on disk, want exactly the %d in the ring", got, historySize)
	}
}

func TestClearHistoryRemovesTheFiles(t *testing.T) {
	r := newRegistry(t)
	id := finishLong(r, sqlPreviewRunes*2, nil)
	finishLong(r, sqlPreviewRunes*2, nil)
	r.ClearHistory()
	if files := spillFiles(t, r); len(files) != 0 {
		t.Fatalf("files = %v after ClearHistory", files)
	}
	if _, _, ok := r.Full(id); ok {
		t.Fatal("Full finds an entry after ClearHistory")
	}
}

// A temp cleaner, or the user, can delete the file. That is an answer, not a
// crash: the preview comes back and kept is false.
func TestMissingFileIsReportedNotFatal(t *testing.T) {
	r := newRegistry(t)
	id := finishLong(r, sqlPreviewRunes*2, nil)
	for _, name := range spillFiles(t, r) {
		if err := os.Remove(filepath.Join(r.dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	sql, _, ok := r.Full(id)
	if ok {
		t.Fatal("ok = true for a file that is gone")
	}
	if !strings.HasPrefix(sql, "xxx") || len(sql) > len(strings.Repeat("x", sqlPreviewRunes))+len("…") {
		t.Fatalf("want the preview back, got %d bytes", len(sql))
	}
	if _, _, ok := r.Full("q999999"); ok {
		t.Fatal("ok = true for an id that never existed")
	}
}

func TestCloseRemovesTheDirectory(t *testing.T) {
	r := New()
	finishLong(r, sqlPreviewRunes*2, nil)
	dir := r.dir
	if dir == "" {
		t.Fatal("no spill directory after a long statement")
	}
	r.Close()
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("directory still there after Close: %v", err)
	}
	r.Close() // idempotent

	// Finishing after Close must not recreate it or panic.
	finishLong(r, sqlPreviewRunes*2, nil)
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("directory came back after Close: %v", err)
	}
}

func TestCloseBeforeAnySpillIsANoOp(t *testing.T) {
	r := New()
	r.Close()
	if r.dir != "" {
		t.Fatal("Close made a directory")
	}
}

// When there is nowhere to write, the log behaves as it did before spilling:
// the longer in-memory cut, no crash.
func TestNoSpillFallsBackToTheMemoryCut(t *testing.T) {
	r := New()
	// A file where the temp dir should be makes MkdirTemp fail.
	blocker := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", blocker)
	t.Setenv("TMP", blocker)
	t.Setenv("TEMP", blocker)

	long := strings.Repeat("x", historySQLLimit*2)
	ctx, done := r.Begin(context.Background(), "c1", "", KindQuery, long)
	id := IDOf(ctx)
	done(nil)

	got := r.List()[0]
	if !got.SQLTruncated || len(got.SQL) != historySQLLimit+len("…") {
		t.Fatalf("SQL is %d bytes truncated=%v, want the %d-rune fallback", len(got.SQL), got.SQLTruncated, historySQLLimit)
	}
	if _, _, ok := r.Full(id); ok {
		t.Fatal("Full claims the whole text is kept with spilling disabled")
	}
	r.Close()
}

func TestPreviewCutsOnARuneBoundary(t *testing.T) {
	got, cut := preview(strings.Repeat("あ", 10), 4)
	if !cut || got != strings.Repeat("あ", 4)+"…" {
		t.Fatalf("preview = %q, %v", got, cut)
	}
	if got, cut := preview("abc", 3); cut || got != "abc" {
		t.Fatalf("exact fit = %q, %v", got, cut)
	}
}

func TestCapBytesCutsOnARuneBoundary(t *testing.T) {
	// Three-byte runes either side of the limit: a naive cut would leave half a
	// character and produce invalid UTF-8 in the JSON.
	got := capBytes(strings.Repeat("あ", 10), 10)
	if !strings.HasSuffix(got, "…") || len(got) != 9+len("…") {
		t.Fatalf("capBytes = %q (%d bytes), want a clean 9-byte cut", got, len(got))
	}
}

func TestSweepRemovesDeadAndAgedDirectoriesOnly(t *testing.T) {
	tmp := t.TempDir()
	mk := func(name string, age time.Duration) string {
		dir := filepath.Join(tmp, name)
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "q001.json"), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		when := time.Now().Add(-age)
		if err := os.Chtimes(dir, when, when); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	dead := mk(spillDirPrefix+"111-1", time.Hour)
	live := mk(spillDirPrefix+"222-1", 30*24*time.Hour) // old, but its owner runs
	other := mk("something-else", 30*24*time.Hour)
	malformed := mk(spillDirPrefix+"x-1", 30*24*time.Hour)

	byPid := func(pid int) (bool, bool) { return pid == 222, true }
	sweepStale(tmp, time.Now(), byPid)

	exists := func(p string) bool { _, err := os.Stat(p); return err == nil }
	if exists(dead) {
		t.Error("directory of a dead pid survived")
	}
	if !exists(live) {
		t.Error("directory of a live pid was removed")
	}
	if !exists(other) || !exists(malformed) {
		t.Error("a directory that is not ours was removed")
	}
}

// Where liveness cannot be told (Windows), only age counts.
func TestSweepFallsBackToAgeWhenPidsCannotBeChecked(t *testing.T) {
	tmp := t.TempDir()
	old := filepath.Join(tmp, spillDirPrefix+"1-1")
	fresh := filepath.Join(tmp, spillDirPrefix+"2-1")
	for _, d := range []string{old, fresh} {
		if err := os.Mkdir(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	when := time.Now().Add(-staleAfter - time.Hour)
	if err := os.Chtimes(old, when, when); err != nil {
		t.Fatal(err)
	}

	sweepStale(tmp, time.Now(), func(int) (bool, bool) { return false, false })

	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Error("a directory past the age limit survived")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("a fresh directory was removed")
	}
}

func TestOwnPidIsAlive(t *testing.T) {
	if running, known := pidAlive(os.Getpid()); known && !running {
		t.Fatal("pidAlive says this process is dead")
	}
}

func TestSpillDirectoryIsNamedForThisProcess(t *testing.T) {
	r := newRegistry(t)
	finishLong(r, sqlPreviewRunes*2, nil)
	want := fmt.Sprintf("%s%d-", spillDirPrefix, os.Getpid())
	if !strings.HasPrefix(filepath.Base(r.dir), want) {
		t.Fatalf("dir %q does not start %q", r.dir, want)
	}
	if info, err := os.Stat(r.dir); err != nil || (os.PathSeparator == '/' && info.Mode().Perm() != 0o700) {
		t.Fatalf("stat = %v, %v, want a 0700 directory", info, err)
	}
}
