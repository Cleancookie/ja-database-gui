package engine

import (
	"testing"

	"github.com/Cleancookie/ja-db/internal/driver"
)

// Sessions are pooled per database for every dialect, not just the one that has
// no choice. A pool keyed on the connection alone leaves the SQL editor running
// against whatever database the first session happened to open with — and `USE`
// cannot fix it, because a *sql.DB is a pool and `USE` would only reach one of
// its connections.
func TestSessionsArePooledPerDatabase(t *testing.T) {
	for _, tc := range []struct {
		name string
		caps driver.Capabilities
	}{
		{"switchable dialect", driver.Capabilities{DatabasePerConnection: false}},
		{"connection per database", driver.Capabilities{DatabasePerConnection: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			shop := key("c1", "shop", tc.caps)
			admin := key("c1", "admin", tc.caps)
			if shop == admin {
				t.Fatalf("key() = %q for both databases; the editor would run against the wrong one", shop)
			}
			if same := key("c1", "shop", tc.caps); same != shop {
				t.Fatalf("key() is not stable: %q then %q", shop, same)
			}
			if other := key("c2", "shop", tc.caps); other == shop {
				t.Fatal("two saved connections shared a session key")
			}
		})
	}
}
