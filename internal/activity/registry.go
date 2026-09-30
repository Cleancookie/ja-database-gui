// Package activity tracks database work — in flight and recently finished — so
// the user can see what the app is doing and cancel anything taking too long.
//
// Every query the app issues is wrapped by Begin, which returns a derived
// context. Cancelling that context is what actually stops the query: Go's
// database/sql propagates cancellation to the driver, which sends the
// dialect's own kill/cancel signal to the server.
//
// The context also carries a tracker, which is how code deep in
// internal/driver reports which phase a query has reached without importing
// this package's registry. See SetPhase.
package activity

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

type Kind string

const (
	KindBrowse     Kind = "browse"     // paging through a table or view
	KindCount      Kind = "count"      // the background COUNT(*)
	KindQuery      Kind = "query"      // the SQL editor
	KindIntrospect Kind = "introspect" // catalogue reads for the tree
	KindDDL        Kind = "ddl"        // create, truncate, drop from the object menu
	KindWrite      Kind = "write"      // row edits applied from the grid
)

// Phase is where a query has got to. These are the app's own lifecycle states,
// instrumented at the points that actually exist in the code — not the
// server's opinion of the query. Real engine state (MySQL's "writing to net",
// pg_stat_activity, dm_exec_requests) needs each query pinned to its own
// connection so its thread id can be captured; that is deliberately not done
// here, and is written up in docs/WISHLIST.md.
type Phase string

const (
	// PhaseQueued is registered but not yet handed to database/sql.
	PhaseQueued Phase = "queued"
	// PhaseExecuting is the statement sent, nothing back yet. This is where a
	// slow server sits, and it includes any wait for a free pooled connection.
	PhaseExecuting Phase = "executing"
	// PhaseReading is rows streaming in and being normalised. RowsRead is what
	// moves while this is showing.
	PhaseReading Phase = "reading rows"
	// PhaseCancelling is the user having asked to stop, before the driver has
	// unwound. Without it the row would appear stuck and invite a second,
	// equally ineffective, click.
	PhaseCancelling Phase = "cancelling"

	// The three terminal phases. An entry carrying one of these is history: its
	// ElapsedMS is final and will not move again.
	PhaseDone      Phase = "done"
	PhaseFailed    Phase = "failed"
	PhaseCancelled Phase = "cancelled"
)

// Terminal reports whether a phase means the query has stopped.
func (p Phase) Terminal() bool {
	return p == PhaseDone || p == PhaseFailed || p == PhaseCancelled
}

// historySize bounds the retained log of finished queries. The pane is a
// session's scrollback, not an audit trail, and it is a hard bound so a
// long-running app cannot grow it.
//
// Sized for the fact that *every* kind is retained and shown, catalogue reads
// included. Those were dropped originally, then kept but hidden from the view;
// both made the log untrustworthy ("I can see it running, it never appears").
// The log now shows everything the app executed, so its only bound is this
// ring.
const historySize = 500

// historySQLLimit caps the SQL kept in memory per history entry when the full
// text cannot be spilled to disk (see spill.go). Normally only sqlPreviewRunes
// are kept. A ring of 500 statements is the one place in this app where
// retained strings could add up.
const historySQLLimit = 2000

// historyErrorLimit caps the retained error text, in runes, for the same
// reason. The full message is spilled alongside the SQL.
const historyErrorLimit = 500

// Info is one query, running or finished, as shown in the activity tray.
type Info struct {
	ID           string `json:"id"`
	ConnectionID string `json:"connectionId"`
	Database     string `json:"database"`
	Kind         Kind   `json:"kind"`
	// SQL is a preview of at most sqlPreviewRunes runes. The whole statement is
	// Registry.Full, while it is still kept.
	SQL          string    `json:"sql"`
	SQLTruncated bool      `json:"sqlTruncated,omitempty"`
	StartedAt    time.Time `json:"startedAt"`
	// ElapsedMS is measured when this snapshot is taken, and frozen once the
	// phase is terminal.
	ElapsedMS int64 `json:"elapsedMs"`
	Phase     Phase `json:"phase"`
	RowsRead  int64 `json:"rowsRead"`
	// Error is set on PhaseFailed, so the history row can say why.
	Error          string `json:"error,omitempty"`
	ErrorTruncated bool   `json:"errorTruncated,omitempty"`
}

// tracker holds the parts of an Info that a running query updates from its own
// goroutine. Atomics rather than the registry mutex: the row-reading loop
// touches this once per row and must not contend with the poll.
type tracker struct {
	phase atomic.Pointer[Phase]
	rows  atomic.Int64
}

func (t *tracker) setPhase(p Phase) { t.phase.Store(&p) }

func (t *tracker) load() (Phase, int64) {
	p := t.phase.Load()
	if p == nil {
		return PhaseQueued, 0
	}
	return *p, t.rows.Load()
}

type trackerKey struct{}

// SetPhase records what a tracked query is now doing. A context with no
// tracker — a test, or "Test connection", which is not a tracked query — is a
// no-op, so callers never have to check.
func SetPhase(ctx context.Context, p Phase) {
	if t, ok := ctx.Value(trackerKey{}).(*tracker); ok {
		t.setPhase(p)
	}
}

// AddRows adds to the count of rows read so far.
func AddRows(ctx context.Context, n int64) {
	if t, ok := ctx.Value(trackerKey{}).(*tracker); ok {
		t.rows.Add(n)
	}
}

// Progress reads back what a tracked query has reached. Used by the logging
// middleware, which wants the row count a query ended on without going through
// the registry lock. An untracked context reports the zero state.
func Progress(ctx context.Context) (Phase, int64) {
	if t, ok := ctx.Value(trackerKey{}).(*tracker); ok {
		return t.load()
	}
	return PhaseQueued, 0
}

type idKey struct{}

// IDOf returns the id Begin assigned to this context's query, so a log line
// and the tray row can be matched up. Empty for an untracked context.
func IDOf(ctx context.Context) string {
	id, _ := ctx.Value(idKey{}).(string)
	return id
}

type entry struct {
	info    Info
	fullSQL string // what was run; info.SQL is only the preview
	track   *tracker
	cancel  context.CancelFunc
	stopped bool // the user asked for this one to stop
}

// Registry holds running queries and a bounded history of finished ones. Safe
// for concurrent use.
type Registry struct {
	mu      sync.Mutex
	seq     atomic.Uint64
	running map[string]*entry

	// history is a fixed ring, oldest overwritten once full. histFile is
	// parallel to it: the spill file holding an entry's full text, or "".
	history  []Info
	histFile []string
	histAt   int
	histLen  int

	dirOnce sync.Once
	dir     string // "" when spilling is unavailable
}

func New() *Registry {
	sweepStaleOnce()
	return &Registry{
		running:  map[string]*entry{},
		history:  make([]Info, historySize),
		histFile: make([]string, historySize),
	}
}

// Begin registers a query and returns a context to run it with, plus a
// function that must be called to finish it. Pass the query's error to that
// function, or nil: it is what decides the terminal phase the history keeps.
func (r *Registry) Begin(parent context.Context, connID, database string, kind Kind, sql string) (context.Context, func(error)) {
	ctx, cancel := context.WithCancel(parent)
	// Zero-padded so the column does not change width as the counter grows,
	// and short enough to read out loud: "q014".
	id := fmt.Sprintf("q%03d", r.seq.Add(1))

	track := &tracker{}
	track.setPhase(PhaseQueued)
	ctx = context.WithValue(ctx, trackerKey{}, track)
	ctx = context.WithValue(ctx, idKey{}, id)

	shown, cut := preview(sql, sqlPreviewRunes)
	r.mu.Lock()
	r.running[id] = &entry{
		fullSQL: sql,
		info: Info{
			ID:           id,
			ConnectionID: connID,
			Database:     database,
			Kind:         kind,
			SQL:          shown,
			SQLTruncated: cut,
			StartedAt:    time.Now().UTC(),
		},
		track:  track,
		cancel: cancel,
	}
	r.mu.Unlock()

	return ctx, func(err error) {
		r.finish(id, err)
		// Always released, including on the success path, so the context does
		// not leak. Cancelling an already-finished query is a no-op.
		cancel()
	}
}

// finish moves a query out of the running set and into the history ring.
//
// The spill file is written before the entry leaves the running set, and with
// the lock released, so Full never finds an entry whose text is not yet
// readable and the poll never waits on the disk.
func (r *Registry) finish(id string, err error) {
	r.mu.Lock()
	e, ok := r.running[id]
	if !ok {
		r.mu.Unlock()
		return
	}
	stopped := e.stopped
	r.mu.Unlock()

	info := e.info
	_, info.RowsRead = e.track.load()
	info.ElapsedMS = time.Since(info.StartedAt).Milliseconds()
	var errText string
	switch {
	case stopped:
		// The driver's error here is whatever cancellation surfaced as; the
		// fact the user asked is the more useful thing to record.
		info.Phase = PhaseCancelled
	case err != nil:
		info.Phase = PhaseFailed
		errText = err.Error()
		info.Error, info.ErrorTruncated = preview(errText, historyErrorLimit)
	default:
		info.Phase = PhaseDone
	}

	var file string
	if info.SQLTruncated || info.ErrorTruncated {
		file = r.spill(id, e.fullSQL, errText)
		if file == "" {
			// Nowhere to put it, so keep what fits in memory, as before spilling
			// existed.
			info.SQL, info.SQLTruncated = preview(e.fullSQL, historySQLLimit)
		}
	}

	r.mu.Lock()
	if _, still := r.running[id]; !still {
		r.mu.Unlock()
		r.removeSpills([]string{file})
		return
	}
	delete(r.running, id)
	evicted := r.histFile[r.histAt]
	r.history[r.histAt] = info
	r.histFile[r.histAt] = file
	r.histAt = (r.histAt + 1) % historySize
	if r.histLen < historySize {
		r.histLen++
	}
	r.mu.Unlock()

	r.removeSpills([]string{evicted})
}

// List returns running queries newest-first, followed by the history
// newest-first. One list, because that is how the tray shows it: what is
// happening now above what just happened.
func (r *Registry) List() []Info {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now().UTC()
	out := make([]Info, 0, len(r.running)+r.histLen)
	for _, e := range r.running {
		info := e.info
		info.Phase, info.RowsRead = e.track.load()
		info.ElapsedMS = now.Sub(info.StartedAt).Milliseconds()
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.After(out[j].StartedAt) })

	// Walk the ring backwards from the most recent write.
	for i := 0; i < r.histLen; i++ {
		idx := (r.histAt - 1 - i + historySize) % historySize
		out = append(out, r.history[idx])
	}
	return out
}

// ClearHistory drops the finished entries, leaving anything still running.
func (r *Registry) ClearHistory() {
	r.mu.Lock()
	files := r.histFile
	r.histAt = 0
	r.histLen = 0
	// Release the retained SQL rather than just forgetting the length.
	r.history = make([]Info, historySize)
	r.histFile = make([]string, historySize)
	r.mu.Unlock()

	r.removeSpills(files)
}

// Full returns the whole statement and error of one query, running or
// finished. ok is false when the text is no longer kept — the entry has left
// the ring, or its file is gone — in which case sql and err hold whatever
// preview survives, and both are empty if the entry itself is unknown.
func (r *Registry) Full(id string) (sql, err string, ok bool) {
	r.mu.Lock()
	if e, found := r.running[id]; found {
		sql = e.fullSQL
		r.mu.Unlock()
		return sql, "", true
	}
	var info Info
	var file string
	found := false
	for i := 0; i < r.histLen; i++ {
		idx := (r.histAt - 1 - i + historySize) % historySize
		if r.history[idx].ID == id {
			info, file, found = r.history[idx], r.histFile[idx], true
			break
		}
	}
	r.mu.Unlock()

	switch {
	case !found:
		return "", "", false
	case !info.SQLTruncated && !info.ErrorTruncated:
		return info.SQL, info.Error, true
	}
	if f, read := r.readSpill(file); read {
		return f.SQL, f.Error, true
	}
	return info.SQL, info.Error, false
}

// Cancel stops a running query. It is not an error to cancel one that has
// already finished — by the time a click arrives the query may well be done,
// and reporting that as a failure would be noise.
func (r *Registry) Cancel(id string) {
	r.mu.Lock()
	e, ok := r.running[id]
	if ok {
		e.stopped = true
		e.track.setPhase(PhaseCancelling)
	}
	r.mu.Unlock()

	if ok {
		e.cancel()
	}
}

// CancelConnection stops everything running against one saved connection,
// which is what disconnecting has to do before closing the pool.
func (r *Registry) CancelConnection(connID string) {
	r.mu.Lock()
	var cancels []context.CancelFunc
	for _, e := range r.running {
		if e.info.ConnectionID == connID {
			e.stopped = true
			e.track.setPhase(PhaseCancelling)
			cancels = append(cancels, e.cancel)
		}
	}
	r.mu.Unlock()

	for _, c := range cancels {
		c()
	}
}
