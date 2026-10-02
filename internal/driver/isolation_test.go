package driver

import (
	"database/sql"
	"strings"
	"testing"
)

func TestIsolationForAllowList(t *testing.T) {
	for _, k := range Kinds() {
		d, _ := Get(k)
		caps := d.Caps()

		if lvl, err := IsolationFor(caps, ""); err != nil || lvl != sql.LevelDefault {
			t.Errorf("%s: empty = (%v, %v), want the default and no error", k, lvl, err)
		}
		for _, name := range caps.IsolationLevels {
			if _, err := IsolationFor(caps, name); err != nil {
				t.Errorf("%s: advertised level %q rejected: %v", k, name, err)
			}
		}
		for _, bad := range []string{"READ COMMITTED", "serializable; drop table x", "chaos", "linearizable"} {
			if _, err := IsolationFor(caps, bad); err == nil {
				t.Errorf("%s: %q accepted", k, bad)
			}
		}
	}
}

func TestIsolationPerDialect(t *testing.T) {
	has := func(k Kind, name string) bool {
		d, _ := Get(k)
		_, err := IsolationFor(d.Caps(), name)
		return err == nil
	}
	if !has(KindMSSQL, "snapshot") {
		t.Error("mssql should offer snapshot")
	}
	for _, k := range []Kind{KindMySQL, KindPostgres, KindSQLite} {
		if has(k, "snapshot") {
			t.Errorf("%s must not offer snapshot", k)
		}
	}
	if len(mustCaps(t, KindSQLite).IsolationLevels) != 0 {
		t.Error("sqlite has nothing to choose, so the list must be empty")
	}
}

func mustCaps(t *testing.T, k Kind) Capabilities {
	t.Helper()
	d, err := Get(k)
	if err != nil {
		t.Fatal(err)
	}
	return d.Caps()
}

func TestKillStatementsAreBuiltFromAnInteger(t *testing.T) {
	want := map[Kind]string{
		KindMySQL:    "KILL QUERY 42",
		KindPostgres: "SELECT pg_cancel_backend(42)",
		KindMSSQL:    "",
		KindSQLite:   "",
	}
	for k, w := range want {
		d, _ := Get(k)
		if got := d.KillStatement(42); got != w {
			t.Errorf("%s: KillStatement = %q, want %q", k, got, w)
		}
		// A dialect with no kill must not capture an id either.
		if (w == "") != (d.SessionIDQuery() == "") {
			t.Errorf("%s: session id query %q does not match kill %q", k, d.SessionIDQuery(), w)
		}
		if strings.Contains(d.KillStatement(-1), "'") {
			t.Errorf("%s: kill statement contains a quote", k)
		}
	}
}
