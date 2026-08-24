// Package query is the single door every database call goes through.
//
// Before this existed, each api.Service method assembled its own tracking by
// hand: register with the activity registry, set a phase, remember to pass the
// error to the release function. Eight call sites, each a chance to get it
// wrong — and one of them did, silently recording every failed editor
// statement as a success until a merge exposed it.
//
// Now there is one call:
//
//	err := runner.Do(ctx, query.Op{...}, func(ctx context.Context) error { ... })
//
// and the cross-cutting behaviour lives in middleware wrapped around it, in
// one place, applying to everything. Tracking and logging are the two that
// exist; a slow-query warning, a retry, or per-connection rate limiting would
// be a Middleware and nothing else would change.
package query

import (
	"context"
	"time"

	"github.com/Cleancookie/ja-db/internal/activity"
)

// Op describes one unit of database work, before it runs.
type Op struct {
	ConnectionID string
	Database     string
	Kind         activity.Kind
	// SQL is the statement being run.
	//
	// For introspection there is no single statement — the drivers assemble
	// their own catalogue queries internally and each dialect asks a different
	// question — so this carries a label instead ("describe public.users").
	// That is why the activity log shows a phrase rather than SQL for those
	// rows, and it is the one place the log is not literally what was sent.
	SQL string

	// ID is assigned by the tracking middleware, so later middleware and the
	// logs can refer to the same identifier the user sees in the tray.
	ID string
}

// Handler runs the work. The context it receives is the tracked, cancellable
// one — not the context passed to Do — so anything it starts is cancellable
// from the tray.
type Handler func(ctx context.Context) error

// Middleware wraps a Handler. The first Middleware given to New is the
// outermost, so it sees the whole of what the ones after it do.
type Middleware func(op *Op, next Handler) Handler

// Runner executes Ops through a fixed middleware chain.
type Runner struct {
	mw []Middleware
}

func New(mw ...Middleware) *Runner {
	return &Runner{mw: mw}
}

// Do runs h wrapped in the chain. The returned error is h's, unchanged:
// middleware observes and annotates, but must not swallow a failure.
func (r *Runner) Do(ctx context.Context, op Op, h Handler) error {
	wrapped := h
	// Applied back to front so that mw[0] ends up outermost.
	for i := len(r.mw) - 1; i >= 0; i-- {
		wrapped = r.mw[i](&op, wrapped)
	}
	return wrapped(ctx)
}

// Tracking registers the op with the activity registry, so it appears in the
// tray, can be cancelled, and lands in the history with a terminal phase.
//
// This is the middleware that supplies the cancellable context; anything
// wrapped inside it runs under a context the user can stop.
func Tracking(reg *activity.Registry) Middleware {
	return func(op *Op, next Handler) Handler {
		return func(ctx context.Context) error {
			qctx, done := reg.Begin(ctx, op.ConnectionID, op.Database, op.Kind, op.SQL)
			op.ID = activity.IDOf(qctx)

			// Introspection has no instrumentation deeper down — the drivers
			// return []Column, not rows, so there is no scan loop to report
			// from. Marking it executing here means those rows do not sit on
			// "queued" for their whole life. A row query overwrites this
			// immediately with its own, more precise, transitions.
			activity.SetPhase(qctx, activity.PhaseExecuting)

			var err error
			// Deferred with the error rather than called inline, so a panic
			// cannot leave the query listed as running forever.
			defer func() { done(err) }()
			err = next(qctx)
			return err
		}
	}
}

// Entry is one completed op, as handed to a Logger.
type Entry struct {
	Op       Op
	Elapsed  time.Duration
	RowsRead int64
	Err      error
}

// Logger receives every op after it finishes.
type Logger func(Entry)

// Logging reports every op once it has finished, whatever the outcome.
//
// Wrapped inside Tracking so the op already has its id, and so the duration
// measured is the query rather than the bookkeeping around it.
func Logging(log Logger) Middleware {
	return func(op *Op, next Handler) Handler {
		return func(ctx context.Context) error {
			start := time.Now()
			err := next(ctx)
			_, rows := activity.Progress(ctx)
			log(Entry{Op: *op, Elapsed: time.Since(start), RowsRead: rows, Err: err})
			return err
		}
	}
}
