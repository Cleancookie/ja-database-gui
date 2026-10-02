package api

import (
	"context"
	"testing"
	"time"

	"github.com/Cleancookie/ja-db/internal/activity"
)

// An unbounded recursive CTE: runs until something stops it.
const spin = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c`

func waitRunning(t *testing.T, svc *Service) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, q := range svc.Activity().Queries {
			if q.Kind == activity.KindQuery && !q.Phase.Terminal() {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the editor query never showed as running")
}

func TestCancelSQLStopsTheRunningEditorQuery(t *testing.T) {
	svc, id := newTestService(t)
	errc := make(chan error, 1)
	go func() {
		_, err := svc.RunSQL(context.Background(), RunSQLRequest{ConnectionID: id, SQL: spin})
		errc <- err
	}()
	waitRunning(t, svc)

	svc.CancelSQL(id, "")

	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("RunSQL returned no error after cancel")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RunSQL still running 5s after CancelSQL")
	}
	if got := svc.Activity().Queries[0]; got.Phase != activity.PhaseCancelled {
		t.Fatalf("phase = %q, want cancelled", got.Phase)
	}
	// The pinned connection went back to the pool: the next run works.
	mustRun(t, svc, id, "select 1")
}

func TestCancelSQLIgnoresOtherConnections(t *testing.T) {
	svc, id := newTestService(t)
	errc := make(chan error, 1)
	go func() {
		_, err := svc.RunSQL(context.Background(), RunSQLRequest{ConnectionID: id, SQL: spin})
		errc <- err
	}()
	waitRunning(t, svc)

	svc.CancelSQL("some-other-connection", "")
	select {
	case <-errc:
		t.Fatal("a cancel aimed at another connection stopped this query")
	case <-time.After(200 * time.Millisecond):
	}
	svc.CancelConnectionQueries(id)
	select {
	case <-errc:
	case <-time.After(5 * time.Second):
		t.Fatal("CancelConnectionQueries did not stop the query")
	}
}
