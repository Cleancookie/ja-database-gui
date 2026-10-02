package api

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"github.com/Cleancookie/ja-db/internal/activity"
	"github.com/Cleancookie/ja-db/internal/driver"
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

func TestRunSQLRefusesALevelTheDialectDoesNotOffer(t *testing.T) {
	svc, id := newTestService(t)
	for _, lvl := range []string{"serializable", "snapshot", "READ COMMITTED", "read committed; drop table x", "chaos"} {
		_, err := svc.RunSQL(context.Background(), RunSQLRequest{ConnectionID: id, SQL: "select 1", Isolation: lvl})
		if err == nil {
			t.Errorf("level %q accepted on sqlite", lvl)
		}
	}
	// A refused level never reaches the registry: nothing ran.
	for _, q := range svc.Activity().Queries {
		if q.Kind == activity.KindQuery {
			t.Fatalf("a refused run was tracked: %+v", q)
		}
	}
}

func TestRunSQLDefaultLevelStillWorksWithAnEmptyName(t *testing.T) {
	svc, id := newTestService(t)
	mustRun(t, svc, id, "create table t(n integer)")
	rs := runOne(t, svc, id, "select count(*) from t")
	if len(rs.Rows) != 1 {
		t.Fatalf("rows = %v", rs.Rows)
	}
}

func TestRunEditorInATransactionCommitsOnSuccessAndRollsBackOnError(t *testing.T) {
	svc, id := newTestService(t)
	mustRun(t, svc, id, "create table t(n integer primary key)")
	sess, err := svc.session(context.Background(), id, "")
	if err != nil {
		t.Fatal(err)
	}
	count := func() string {
		rs := runOne(t, svc, id, "select count(*) from t")
		return fmt.Sprint(rs.Rows[0][0])
	}
	run := func(sqlText string) error {
		return runEditor(context.Background(), sess, sqlText, sql.LevelSerializable, driver.QueryOptions{}, &RunSQLResult{})
	}

	if err := run("insert into t values (1)"); err != nil {
		t.Fatal(err)
	}
	if got := count(); got != "1" {
		t.Fatalf("after a successful run count = %v, want 1: the transaction was not committed", got)
	}

	// Second statement fails on the key; the first must not survive.
	if err := run("insert into t values (2); insert into t values (1)"); err == nil {
		t.Fatal("duplicate key not reported")
	}
	if got := count(); got != "1" {
		t.Fatalf("after a failed run count = %v, want 1: the transaction was not rolled back", got)
	}
}
