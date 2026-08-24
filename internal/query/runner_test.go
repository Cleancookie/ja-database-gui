package query

import (
	"context"
	"errors"
	"testing"

	"github.com/Cleancookie/ja-db/internal/activity"
)

func TestMiddlewareRunsOutermostFirst(t *testing.T) {
	var order []string
	note := func(name string) Middleware {
		return func(op *Op, next Handler) Handler {
			return func(ctx context.Context) error {
				order = append(order, name+" in")
				err := next(ctx)
				order = append(order, name+" out")
				return err
			}
		}
	}

	r := New(note("first"), note("second"))
	err := r.Do(context.Background(), Op{}, func(context.Context) error {
		order = append(order, "handler")
		return nil
	})
	if err != nil {
		t.Fatalf("Do() = %v", err)
	}

	want := []string{"first in", "second in", "handler", "second out", "first out"}
	if len(order) != len(want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("order = %v, want %v", order, want)
		}
	}
}

// Middleware observes; it must never swallow a failure, or a broken query would
// look successful to the caller.
func TestHandlerErrorReachesTheCaller(t *testing.T) {
	boom := errors.New("boom")
	r := New(Tracking(activity.New()), Logging(func(Entry) {}))

	err := r.Do(context.Background(), Op{Kind: activity.KindQuery, SQL: "select 1"},
		func(context.Context) error { return boom })
	if !errors.Is(err, boom) {
		t.Fatalf("Do() = %v, want %v", err, boom)
	}
}

func TestTrackingRecordsTheOutcome(t *testing.T) {
	reg := activity.New()
	r := New(Tracking(reg))

	if err := r.Do(context.Background(), Op{
		ConnectionID: "c1",
		Database:     "app",
		Kind:         activity.KindIntrospect,
		SQL:          "describe auth.users",
	}, func(context.Context) error { return nil }); err != nil {
		t.Fatalf("Do() = %v", err)
	}

	got := reg.List()
	if len(got) != 1 {
		t.Fatalf("List() = %d entries, want 1", len(got))
	}
	if got[0].Phase != activity.PhaseDone {
		t.Fatalf("phase = %q, want done", got[0].Phase)
	}
	if got[0].SQL != "describe auth.users" || got[0].Database != "app" {
		t.Fatalf("got %+v, want the op's own details", got[0])
	}
}

func TestTrackingRecordsAFailure(t *testing.T) {
	reg := activity.New()
	r := New(Tracking(reg))

	_ = r.Do(context.Background(), Op{Kind: activity.KindQuery, SQL: "select nope"},
		func(context.Context) error { return errors.New("no such column") })

	got := reg.List()
	if len(got) != 1 || got[0].Phase != activity.PhaseFailed {
		t.Fatalf("got %+v, want one failed entry", got)
	}
	if got[0].Error == "" {
		t.Fatal("a failed entry should carry the database's message")
	}
}

// The handler must run under the tracked context, not the one passed to Do —
// otherwise cancelling from the tray would not reach the query.
func TestHandlerGetsTheCancellableContext(t *testing.T) {
	reg := activity.New()
	r := New(Tracking(reg))

	var seen string
	if err := r.Do(context.Background(), Op{Kind: activity.KindQuery, SQL: "select 1"},
		func(ctx context.Context) error {
			seen = activity.IDOf(ctx)
			return nil
		}); err != nil {
		t.Fatalf("Do() = %v", err)
	}
	if seen == "" {
		t.Fatal("handler context carried no query id, so it was not the tracked one")
	}
}

func TestLoggingSeesIDRowsAndError(t *testing.T) {
	reg := activity.New()
	var got Entry
	r := New(Tracking(reg), Logging(func(e Entry) { got = e }))

	boom := errors.New("boom")
	_ = r.Do(context.Background(), Op{Kind: activity.KindBrowse, SQL: "select 1"},
		func(ctx context.Context) error {
			activity.AddRows(ctx, 7)
			return boom
		})

	// The id is assigned by Tracking, which is outside Logging — this asserts
	// the ordering actually delivers it.
	if got.Op.ID == "" {
		t.Error("log entry had no query id")
	}
	if got.RowsRead != 7 {
		t.Errorf("RowsRead = %d, want 7", got.RowsRead)
	}
	if !errors.Is(got.Err, boom) {
		t.Errorf("Err = %v, want %v", got.Err, boom)
	}
}

// A logger must not be handed a pointer into live state it could read after the
// op has moved on.
func TestLoggingGetsACopyOfTheOp(t *testing.T) {
	var got Entry
	r := New(Logging(func(e Entry) { got = e }))
	op := Op{Kind: activity.KindQuery, SQL: "select 1"}

	_ = r.Do(context.Background(), op, func(context.Context) error { return nil })
	got.Op.SQL = "mutated"

	if op.SQL != "select 1" {
		t.Fatal("mutating the logged Entry reached the caller's Op")
	}
}
