package api

import (
	"testing"
	"time"

	"github.com/Cleancookie/ja-db/internal/driver"
)

// clock is a hand-wound time source, so the TTL can be tested without sleeping.
type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newTestCache(ttl time.Duration) (*columnCache, *clock) {
	c := &clock{t: time.Unix(1_700_000_000, 0)}
	return newColumnCache(ttl, c.now), c
}

var testRef = driver.ObjectRef{Database: "app", Name: "users"}

func someCols() []driver.Column {
	return []driver.Column{
		{Name: "id", DataType: "int", PrimaryKey: true, Ordinal: 1},
		{Name: "email", DataType: "varchar", Ordinal: 2},
	}
}

func TestColumnCacheMissThenHit(t *testing.T) {
	cache, _ := newTestCache(5 * time.Second)

	if _, ok := cache.get("c1", testRef); ok {
		t.Fatal("empty cache reported a hit")
	}
	cache.put("c1", testRef, someCols())

	got, ok := cache.get("c1", testRef)
	if !ok {
		t.Fatal("stored entry did not come back")
	}
	if len(got) != 2 || got[0].Name != "id" {
		t.Fatalf("got %+v, want the columns that were stored", got)
	}

	if h, m := cache.stats(); h != 1 || m != 1 {
		t.Fatalf("stats() = %d hits, %d misses; want 1 and 1", h, m)
	}
}

func TestColumnCacheExpiresAfterTTL(t *testing.T) {
	cache, clk := newTestCache(5 * time.Second)
	cache.put("c1", testRef, someCols())

	clk.advance(4990 * time.Millisecond)
	if _, ok := cache.get("c1", testRef); !ok {
		t.Fatal("entry expired inside the TTL")
	}

	clk.advance(20 * time.Millisecond)
	if _, ok := cache.get("c1", testRef); ok {
		t.Fatal("entry survived past the TTL")
	}
}

// The cache is keyed on the connection as well as the ref, so two connections
// showing the same database name — prod and a local copy — cannot bleed into
// each other.
func TestColumnCacheKeyedOnConnectionAndRef(t *testing.T) {
	cache, _ := newTestCache(5 * time.Second)
	cache.put("c1", testRef, someCols())

	if _, ok := cache.get("c2", testRef); ok {
		t.Fatal("a different connection hit c1's entry")
	}
	other := driver.ObjectRef{Database: "app", Name: "orders"}
	if _, ok := cache.get("c1", other); ok {
		t.Fatal("a different table hit users' entry")
	}
	sameNameOtherSchema := driver.ObjectRef{Database: "app", Schema: "audit", Name: "users"}
	if _, ok := cache.get("c1", sameNameOtherSchema); ok {
		t.Fatal("a different schema hit the unqualified entry")
	}
}

func TestColumnCacheInvalidate(t *testing.T) {
	cache, _ := newTestCache(5 * time.Second)
	cache.put("c1", testRef, someCols())

	cache.invalidate("c1", testRef)
	if _, ok := cache.get("c1", testRef); ok {
		t.Fatal("invalidated entry still hit")
	}
}

// A DDL statement we cannot attribute to one table — anything typed into the
// SQL editor — has to drop the whole connection's metadata, since it may have
// altered any table on it.
func TestColumnCacheInvalidateConnection(t *testing.T) {
	cache, _ := newTestCache(5 * time.Second)
	other := driver.ObjectRef{Database: "app", Name: "orders"}
	cache.put("c1", testRef, someCols())
	cache.put("c1", other, someCols())
	cache.put("c2", testRef, someCols())

	cache.invalidateConnection("c1")

	if _, ok := cache.get("c1", testRef); ok {
		t.Fatal("c1 users survived a connection-wide invalidate")
	}
	if _, ok := cache.get("c1", other); ok {
		t.Fatal("c1 orders survived a connection-wide invalidate")
	}
	if _, ok := cache.get("c2", testRef); !ok {
		t.Fatal("c2 was dropped by an invalidate aimed at c1")
	}
}

// Callers get a copy. The cached slice outlives any one request, so a caller
// sorting or truncating what it was handed must not corrupt later readers.
func TestColumnCacheHandsBackACopy(t *testing.T) {
	cache, _ := newTestCache(5 * time.Second)
	cache.put("c1", testRef, someCols())

	first, _ := cache.get("c1", testRef)
	first[0].Name = "clobbered"

	second, _ := cache.get("c1", testRef)
	if second[0].Name != "id" {
		t.Fatalf("cached entry was mutated through a returned slice: %+v", second)
	}
}

// put must copy too: the driver's slice may be reused or mutated after it is
// handed over.
func TestColumnCacheCopiesOnPut(t *testing.T) {
	cache, _ := newTestCache(5 * time.Second)
	cols := someCols()
	cache.put("c1", testRef, cols)

	cols[0].Name = "clobbered"

	got, _ := cache.get("c1", testRef)
	if got[0].Name != "id" {
		t.Fatalf("cache aliased the caller's slice: %+v", got)
	}
}

// A zero TTL turns the cache off rather than caching forever, so that a future
// setting of 0 means "no caching" — the reading nobody is surprised by.
func TestColumnCacheZeroTTLDisables(t *testing.T) {
	cache, _ := newTestCache(0)
	cache.put("c1", testRef, someCols())

	if _, ok := cache.get("c1", testRef); ok {
		t.Fatal("a zero TTL cached something")
	}
}
