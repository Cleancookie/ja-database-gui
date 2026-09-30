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
	"unicode/utf8"
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

// historySQLLimit caps the SQL kept per history entry. A ring of 500
// statements is the one place in this app where retained strings could add up,
// and the pane only ever shows one line of it anyway.
const historySQLLimit = 2000

// historyErrorLimit caps the retained error text, for the same reason.
const historyErrorLimit = 500

// Info is one query, running or finished, as shown in the activity tray.
type Info struct {
	ID           string    `json:"id"`
	ConnectionID string    `json:"connectionId"`
	Database     string    `json:"database"`
	Kind         Kind      `json:"kind"`
	SQL          string    `json:"sql"`
	StartedAt    time.Time `json:"startedAt"`
	// ElapsedMS is measured when this snapshot is taken, and frozen once the
	// phase is terminal.
	ElapsedMS int64 `json:"elapsedMs"`
	Phase     Phase `json:"phase"`
	RowsRead  int64 `json:"rowsRead"`
	// Error is set on PhaseFailed, so the history row can say why.
	Error string `json:"error,omitempty"`
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

	// history is a fixed ring, oldest overwritten once full.
	history []Info
	histAt  int
	histLen int
}

func New() *Registry {
	return &Registry{
		running: map[string]*entry{},
		history: make([]Info, historySize),
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

	r.mu.Lock()
	r.running[id] = &entry{
		info: Info{
			ID:           id,
			ConnectionID: connID,
			Database:     database,
			Kind:         kind,
			SQL:          sql,
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
func (r *Registry) finish(id string, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	e, ok := r.running[id]
	if !ok {
		return
	}
	delete(r.running, id)

	info := e.info
	_, info.RowsRead = e.track.load()
	info.ElapsedMS = time.Since(info.StartedAt).Milliseconds()
	switch {
	case e.stopped:
		// The driver's error here is whatever cancellation surfaced as; the
		// fact the user asked is the more useful thing to record.
		info.Phase = PhaseCancelled
	case err != nil:
		info.Phase = PhaseFailed
		info.Error = truncate(err.Error(), historyErrorLimit)
	default:
		info.Phase = PhaseDone
	}

	info.SQL = truncate(info.SQL, historySQLLimit)
	r.history[r.histAt] = info
	r.histAt = (r.histAt + 1) % historySize
	if r.histLen < historySize {
		r.histLen++
	}
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
	defer r.mu.Unlock()
	r.histAt = 0
	r.histLen = 0
	// Release the retained SQL rather than just forgetting the length.
	r.history = make([]Info, historySize)
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

// truncate cuts on a rune boundary, so a multi-byte character at the limit is
// not left half-written into the JSON.
func truncate(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}
