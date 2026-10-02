// Package engine owns live database connections.
//
// Sessions are pooled per saved connection, and — for dialects that cannot
// switch database on an open connection — per database as well.
package engine

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/Cleancookie/ja-db/internal/driver"
)

// dialTimeout bounds the initial connect. Without it a wrong host hangs the UI
// until the OS gives up, which on some networks is minutes.
const dialTimeout = 15 * time.Second

// Session is one live connection to one database.
type Session struct {
	ConnID   string
	Database string
	Driver   driver.Driver
	DB       *sql.DB
}

// Engine holds the session pool.
type Engine struct {
	mu       sync.Mutex
	sessions map[string]*Session
}

func New() *Engine {
	return &Engine{sessions: map[string]*Session{}}
}

// key decides how finely sessions are pooled: one session per connection *and*
// database, for every dialect.
//
// Postgres has no choice — it cannot switch database on an open connection. The
// others could, in principle, with `USE`, and this used to pool them per
// connection alone on the grounds that they reach other databases through
// qualified names. That is true for browsing, where the driver qualifies every
// name it emits, and false for the SQL editor, where the statement is the
// user's own text and `select * from users` means whatever the connection's
// default database is.
//
// `USE` cannot fix that. A Session holds a *sql.DB, which is a pool: `USE`
// would run on whichever pooled connection served it and leave the others
// pointing at the old database, so the editor's target would depend on which
// socket it happened to get. Keying per database means the database is in the
// DSN, which every connection in that pool is opened with.
//
// The cost is more pools — one per database visited, rather than one per
// server. They are closed together on disconnect.
func key(connID, database string, _ driver.Capabilities) string {
	return connID + "\x00" + database
}

// Has reports whether a session is already open for this connection and
// database.
func (e *Engine) Has(connID, database string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	_, ok := e.sessions[key(connID, database, driver.Capabilities{})]
	return ok
}

// Acquire returns a live session, opening one if necessary. database may be
// empty, meaning the connection's configured default.
func (e *Engine) Acquire(ctx context.Context, connID string, cfg driver.ConnConfig, database string) (*Session, error) {
	d, err := driver.Get(cfg.Kind)
	if err != nil {
		return nil, err
	}
	caps := d.Caps()
	k := key(connID, database, caps)

	e.mu.Lock()
	if s, ok := e.sessions[k]; ok {
		e.mu.Unlock()
		return s, nil
	}
	e.mu.Unlock()

	// Opened outside the lock so a slow or hanging dial cannot block every
	// other connection in the app.
	s, err := open(ctx, connID, d, cfg, database)
	if err != nil {
		return nil, err
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	// Another caller may have won the race while we were dialling; keep
	// theirs and discard ours so the pool never holds two for one key.
	if existing, ok := e.sessions[k]; ok {
		s.DB.Close()
		return existing, nil
	}
	e.sessions[k] = s
	return s, nil
}

func open(ctx context.Context, connID string, d driver.Driver, cfg driver.ConnConfig, database string) (*Session, error) {
	dsn, err := d.DSN(cfg, database)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open(d.SQLDriverName(), dsn)
	if err != nil {
		return nil, fmt.Errorf("opening %s connection: %w", d.Caps().DisplayName, err)
	}

	// A GUI issues a handful of concurrent queries at most. Keeping the cap
	// low avoids surprising a shared server with a burst of connections.
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxIdleTime(5 * time.Minute)

	pingCtx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		db.Close()
		return nil, err
	}

	return &Session{ConnID: connID, Database: database, Driver: d, DB: db}, nil
}

// Test opens a connection, pings it and closes it again, without touching the
// pool. Used by the "Test connection" button before a connection is saved.
func (e *Engine) Test(ctx context.Context, cfg driver.ConnConfig) error {
	d, err := driver.Get(cfg.Kind)
	if err != nil {
		return err
	}
	s, err := open(ctx, "", d, cfg, cfg.Database)
	if err != nil {
		return err
	}
	return s.DB.Close()
}

// Disconnect closes every session belonging to a saved connection.
func (e *Engine) Disconnect(connID string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for k, s := range e.sessions {
		if s.ConnID == connID {
			s.DB.Close()
			delete(e.sessions, k)
		}
	}
}

// SessionInfo describes one open session and its pool state, for the
// activity page.
type SessionInfo struct {
	ConnectionID string
	Database     string
	OpenConns    int
	InUse        int
	Idle         int
}

// Sessions reports every open session. Pool counts come from database/sql,
// so they reflect real sockets rather than what the app believes it has.
func (e *Engine) Sessions() []SessionInfo {
	e.mu.Lock()
	defer e.mu.Unlock()

	out := make([]SessionInfo, 0, len(e.sessions))
	for _, s := range e.sessions {
		st := s.DB.Stats()
		out = append(out, SessionInfo{
			ConnectionID: s.ConnID,
			Database:     s.Database,
			OpenConns:    st.OpenConnections,
			InUse:        st.InUse,
			Idle:         st.Idle,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ConnectionID != out[j].ConnectionID {
			return out[i].ConnectionID < out[j].ConnectionID
		}
		return out[i].Database < out[j].Database
	})
	return out
}

// Connected reports which saved connections currently have a live session.
func (e *Engine) Connected() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	seen := map[string]bool{}
	var out []string
	for _, s := range e.sessions {
		if !seen[s.ConnID] {
			seen[s.ConnID] = true
			out = append(out, s.ConnID)
		}
	}
	return out
}

// Shutdown closes everything. Called when the app exits.
func (e *Engine) Shutdown() {
	e.mu.Lock()
	defer e.mu.Unlock()
	for k, s := range e.sessions {
		s.DB.Close()
		delete(e.sessions, k)
	}
}
