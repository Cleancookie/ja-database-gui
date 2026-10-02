package api

import (
	"context"
	"database/sql"

	"github.com/Cleancookie/ja-db/internal/activity"
	"github.com/Cleancookie/ja-db/internal/driver"
	"github.com/Cleancookie/ja-db/internal/engine"
)

// runEditor runs the user's SQL on one connection pinned out of the pool.
//
// Pinning is what makes cancel dependable. The server's id for the session is
// read on the connection before the statement starts and registered with the
// activity entry, so Cancel can stop the statement from a second connection
// where cancelling the context alone would leave the server running it (MySQL;
// see driver/session.go). The id is dropped again before the connection goes
// back to the pool, so a kill never reaches another statement's session.
func runEditor(ctx context.Context, sess *engine.Session, stmt string, level sql.IsolationLevel, opts driver.QueryOptions, out *RunSQLResult) error {
	conn, err := sess.DB.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	if id, ok := driver.CaptureSessionID(ctx, sess.Driver, conn); ok {
		activity.SetSession(ctx, id, driver.KillFunc(sess.Driver, sess.DB, id))
		defer activity.ClearSession(ctx)
	}

	// The driver default runs the text as it is. Any other level wraps the run
	// in a transaction at that level, committed when the run ends and rolled
	// back if it fails: `SET SESSION` would only reach whichever pooled
	// connection served it, and this connection is released straight after.
	var q driver.Queryer = conn
	var tx *sql.Tx
	if level != sql.LevelDefault {
		if tx, err = conn.BeginTx(ctx, &sql.TxOptions{Isolation: level}); err != nil {
			return err
		}
		q = tx
	}

	err = runBatch(ctx, q, stmt, opts, out)
	if tx == nil {
		return err
	}
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		out.Results, out.MoreResults = nil, false
		return err
	}
	return nil
}

func runBatch(ctx context.Context, q driver.Queryer, stmt string, opts driver.QueryOptions, out *RunSQLResult) error {
	// Any statement in the batch that returns rows sends the whole batch down
	// the query path: Exec would run it all and throw those rows away, which is
	// what `use db; select …` used to do.
	if batchReturnsRows(stmt) {
		// The editor's SQL is the user's own text and must not be rewritten, so
		// the text cap here is applied while scanning. It keeps the grid
		// responsive; it cannot keep the bytes off the wire.
		sets, more, err := driver.RunQueryAll(ctx, q, stmt, opts)
		out.Results, out.MoreResults = sets, more
		return err
	}
	rs, err := driver.Exec(ctx, q, stmt)
	if err != nil {
		return err
	}
	out.Results = []*driver.ResultSet{rs}
	return nil
}
