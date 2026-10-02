package api

import (
	"context"
	"database/sql"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Cleancookie/ja-db/internal/activity"
	"github.com/Cleancookie/ja-db/internal/config"
	"github.com/Cleancookie/ja-db/internal/driver"
)

// Opt-in: proves, against a real server, that Cancel stops the statement on the
// server and not only in the client. The SQLite tests cannot show this, and for
// MySQL it is the whole point (see driver/session.go).
//
//	JADB_LIVE=mysql    JADB_LIVE_PORT=33306 JADB_LIVE_PASSWORD=jadb go test ./internal/api -run Live
//	JADB_LIVE=postgres JADB_LIVE_PORT=35432 JADB_LIVE_PASSWORD=jadb go test ./internal/api -run Live
//
// The user is root (mysql) or postgres, on 127.0.0.1.
func TestLiveCancelStopsTheServer(t *testing.T) {
	kind := driver.Kind(os.Getenv("JADB_LIVE"))
	if kind == "" {
		t.Skip("set JADB_LIVE=mysql|postgres to run against a live server")
	}
	port, _ := strconv.Atoi(os.Getenv("JADB_LIVE_PORT"))
	pw := os.Getenv("JADB_LIVE_PASSWORD")
	conn := config.Connection{Name: "live", Kind: kind, Host: "127.0.0.1", Port: port}
	var sleep, probe string
	switch kind {
	case driver.KindMySQL:
		conn.User, conn.Database, conn.SSLMode = "root", "shop", "false"
		sleep = "SELECT SLEEP(60)"
		probe = "SELECT COUNT(*) FROM information_schema.processlist WHERE info LIKE 'SELECT SLEEP(60)%' AND info NOT LIKE '%processlist%'"
	case driver.KindPostgres:
		conn.User, conn.Database, conn.SSLMode = "postgres", "postgres", "disable"
		sleep = "SELECT pg_sleep(60)"
		probe = "SELECT COUNT(*) FROM pg_stat_activity WHERE state = 'active' AND query LIKE 'SELECT pg_sleep(60)%'"
	default:
		t.Skip("only mysql and postgres need a live check")
	}

	svc := newService(t, t.TempDir())
	saved, err := svc.SaveConnection(SaveConnectionRequest{Connection: conn, Password: &pw})
	if err != nil {
		t.Fatal(err)
	}

	sess, err := svc.session(context.Background(), saved.ID, conn.Database)
	if err != nil {
		t.Fatal(err)
	}
	running := func() int {
		var n int
		if err := sess.DB.QueryRow(probe).Scan(&n); err != nil {
			t.Fatalf("probe: %v", err)
		}
		return n
	}

	errc := make(chan error, 1)
	go func() {
		_, err := svc.RunSQL(context.Background(), RunSQLRequest{ConnectionID: saved.ID, Database: conn.Database, SQL: sleep})
		errc <- err
	}()
	waitRunning(t, svc)
	deadline := time.Now().Add(5 * time.Second)
	for running() == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if running() != 1 {
		t.Fatal("the sleep never started on the server")
	}
	if id := svc.Activity().Queries[0].SessionID; id == 0 {
		t.Fatal("no session id recorded for the running statement")
	}

	svc.CancelSQL(saved.ID, conn.Database)
	select {
	case <-errc:
	case <-time.After(5 * time.Second):
		t.Fatal("RunSQL did not return after cancel")
	}
	if got := svc.Activity().Queries[0]; got.Phase != activity.PhaseCancelled {
		t.Fatalf("phase %q, want cancelled", got.Phase)
	}
	time.Sleep(time.Second)
	if n := running(); n != 0 {
		t.Fatalf("%d sleep statement(s) still running on the server after cancel", n)
	}
}

// The control: what the driver does on its own, with no kill. Documents why the
// kill exists. It reports rather than asserts, since it describes a driver.
func TestLiveContextCancelAloneControl(t *testing.T) {
	kind := driver.Kind(os.Getenv("JADB_LIVE"))
	if kind != driver.KindMySQL && kind != driver.KindPostgres {
		t.Skip("set JADB_LIVE=mysql|postgres")
	}
	port, _ := strconv.Atoi(os.Getenv("JADB_LIVE_PORT"))
	pw := os.Getenv("JADB_LIVE_PASSWORD")
	d, _ := driver.Get(kind)
	cfg := driver.ConnConfig{Kind: kind, Host: "127.0.0.1", Port: port, Password: pw}
	var q, probe string
	if kind == driver.KindMySQL {
		cfg.User, cfg.Database, cfg.SSLMode = "root", "shop", "false"
		q, probe = "SELECT SLEEP(61)", "SELECT COUNT(*) FROM information_schema.processlist WHERE info LIKE 'SELECT SLEEP(61)%'"
	} else {
		cfg.User, cfg.Database, cfg.SSLMode = "postgres", "postgres", "disable"
		q, probe = "SELECT pg_sleep(61)", "SELECT COUNT(*) FROM pg_stat_activity WHERE state = 'active' AND query LIKE 'SELECT pg_sleep(61)%'"
	}
	dsn, err := d.DSN(cfg, "")
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open(d.SQLDriverName(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(500 * time.Millisecond); cancel() }()
	start := time.Now()
	_, err = db.ExecContext(ctx, q)
	t.Logf("client returned after %v: %v", time.Since(start).Round(time.Millisecond), strings.TrimSpace(errString(err)))
	time.Sleep(2 * time.Second)
	var n int
	if err := db.QueryRow(probe).Scan(&n); err != nil {
		t.Fatal(err)
	}
	t.Logf("%s: statements still running on the server 2s after a bare context cancel: %d", kind, n)
}

func errString(err error) string {
	if err == nil {
		return "<nil>"
	}
	return err.Error()
}

// Every level the dialect offers must actually be in force inside the run, and
// a statement that cannot run in a transaction must say so.
func TestLiveIsolationLevelsApply(t *testing.T) {
	kind := driver.Kind(os.Getenv("JADB_LIVE"))
	port, _ := strconv.Atoi(os.Getenv("JADB_LIVE_PORT"))
	pw := os.Getenv("JADB_LIVE_PASSWORD")
	conn := config.Connection{Name: "live", Kind: kind, Host: "127.0.0.1", Port: port}
	var show string
	switch kind {
	case driver.KindMySQL:
		// @@transaction_isolation is the session setting and does not show the
		// one-off level of the transaction in progress; the performance schema
		// does. (information_schema.innodb_trx is cached per connection.)
		conn.User, conn.Database, conn.SSLMode = "root", "shop", "false"
		show = "SELECT ISOLATION_LEVEL FROM performance_schema.events_transactions_current WHERE THREAD_ID = (SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID = CONNECTION_ID())"
	case driver.KindPostgres:
		conn.User, conn.Database, conn.SSLMode, show = "postgres", "postgres", "disable", "SHOW transaction_isolation"
	default:
		t.Skip("set JADB_LIVE=mysql|postgres")
	}
	svc := newService(t, t.TempDir())
	saved, err := svc.SaveConnection(SaveConnectionRequest{Connection: conn, Password: &pw})
	if err != nil {
		t.Fatal(err)
	}
	d, _ := driver.Get(kind)
	run := func(level, text string) (*RunSQLResult, error) {
		return svc.RunSQL(context.Background(), RunSQLRequest{ConnectionID: saved.ID, Database: conn.Database, SQL: text, Isolation: level})
	}
	for _, level := range d.Caps().IsolationLevels {
		res, err := run(level, show)
		if err != nil {
			t.Fatalf("%s: %v", level, err)
		}
		last := res.Results[0]
		if len(last.Rows) == 0 {
			t.Fatalf("%s: the server shows no transaction in progress", level)
		}
		got := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(last.Rows[0][0].(string)), "-", " "))
		if got != level {
			t.Errorf("asked for %q, the server reports %q", level, got)
		}
	}
	// The default path must not have been left in a level by the runs above.
	session, want := "SHOW transaction_isolation", "read committed"
	if kind == driver.KindMySQL {
		session, want = "SELECT @@session.transaction_isolation", "REPEATABLE-READ"
	}
	res, err := run("", session)
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Results[0].Rows[0][0]; got != want {
		t.Errorf("default path after the runs above: level %v, want the server default %v", got, want)
	}

	if kind == driver.KindPostgres {
		if _, err := run("read committed", "VACUUM"); err == nil {
			t.Error("VACUUM inside a transaction should be refused by the server")
		}
		if _, err := run("", "VACUUM"); err != nil {
			t.Errorf("VACUUM on the default path should work: %v", err)
		}
	}
}
