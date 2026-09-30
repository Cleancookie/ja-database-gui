package api

import (
	"sync"
	"time"

	"github.com/Cleancookie/ja-db/internal/driver"
)

// columnTTL is how long column metadata is trusted.
//
// ReadRows needs the column list before it can build a SELECT, so every page
// change, sort click and filter used to pay a second serial round trip to
// re-read a schema that had not changed — around 45ms in front of every grid
// update on a remote MariaDB. Caching it removes that.
//
// Short on purpose. The tables here are actively migrated, so the question is
// not "can this be cached" but "for how long is stale acceptable": long enough
// to cover a burst of clicks on one table, short enough that a column added by
// a migration appears without anyone reaching for a refresh. Five seconds
// covers the burst — the logs show clicks arriving seconds apart — and bounds
// the staleness at something nobody will notice.
const columnTTL = 5 * time.Second

// columnKey identifies one table on one connection. ObjectRef is all strings,
// so the struct is comparable and usable as a map key directly; building a
// string would only invent a delimiter that a table name could contain.
type columnKey struct {
	connID string
	ref    driver.ObjectRef
}

type columnEntry struct {
	cols []driver.Column
	at   time.Time

	// facts is the edit metadata for the same table, kept beside the columns so
	// that one invalidate — DDL, RunSQL, disconnect — drops both. It ages on its
	// own clock because the two are read and stored independently.
	facts   *driver.EditFacts
	factsAt time.Time
}

// columnCache is a short-lived memo of column metadata.
//
// It caches metadata only — never rows. Row data is re-read on every browse
// regardless, so a table whose contents change constantly is unaffected by
// this; only DDL can make an entry wrong, and the TTL plus the invalidation
// hooks bound that.
type columnCache struct {
	mu      sync.Mutex
	ttl     time.Duration
	now     func() time.Time
	entries map[columnKey]columnEntry

	// Counted so that "are we still missing?" is answerable from the log
	// rather than estimated. See Service.logColumnCache.
	hits, misses int
}

func newColumnCache(ttl time.Duration, now func() time.Time) *columnCache {
	return &columnCache{
		ttl:     ttl,
		now:     now,
		entries: map[columnKey]columnEntry{},
	}
}

// get returns a copy of the cached columns, or false if there is no live entry.
func (c *columnCache) get(connID string, ref driver.ObjectRef) ([]driver.Column, bool) {
	if c.ttl <= 0 {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	e, ok := c.entries[columnKey{connID, ref}]
	if !ok || c.now().Sub(e.at) >= c.ttl {
		c.misses++
		return nil, false
	}
	c.hits++
	return append([]driver.Column(nil), e.cols...), true
}

// put stores a copy of cols. Copying both ways keeps the cached slice private:
// nothing a caller does to what it passed in or was handed back can corrupt a
// later reader.
func (c *columnCache) put(connID string, ref driver.ObjectRef, cols []driver.Column) {
	if c.ttl <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	k := columnKey{connID, ref}
	e := c.entries[k]
	e.cols, e.at = append([]driver.Column(nil), cols...), c.now()
	c.entries[k] = e
}

// getFacts returns a copy of the cached edit facts, or false if there is no live
// entry. It does not count toward the hit rate, which describes column reads.
func (c *columnCache) getFacts(connID string, ref driver.ObjectRef) (driver.EditFacts, bool) {
	if c.ttl <= 0 {
		return driver.EditFacts{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	e, ok := c.entries[columnKey{connID, ref}]
	if !ok || e.facts == nil || c.now().Sub(e.factsAt) >= c.ttl {
		return driver.EditFacts{}, false
	}
	return e.facts.Clone(), true
}

func (c *columnCache) putFacts(connID string, ref driver.ObjectRef, f driver.EditFacts) {
	if c.ttl <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	k := columnKey{connID, ref}
	e := c.entries[k]
	clone := f.Clone()
	e.facts, e.factsAt = &clone, c.now()
	c.entries[k] = e
}

// invalidate drops one table, for a change we know the target of.
func (c *columnCache) invalidate(connID string, ref driver.ObjectRef) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, columnKey{connID, ref})
}

// invalidateConnection drops everything for one connection: for arbitrary SQL,
// which may have altered any table, and for disconnect, after which no entry
// describes anything still open.
func (c *columnCache) invalidateConnection(connID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k := range c.entries {
		if k.connID == connID {
			delete(c.entries, k)
		}
	}
}

func (c *columnCache) stats() (hits, misses int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hits, c.misses
}
