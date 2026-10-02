package api

import (
	"context"

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
func runEditor(ctx context.Context, sess *engine.Session, stmt string, opts driver.QueryOptions, out *RunSQLResult) error {
	conn, err := sess.DB.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	if id, ok := driver.CaptureSessionID(ctx, sess.Driver, conn); ok {
		activity.SetSession(ctx, id, driver.KillFunc(sess.Driver, sess.DB, id))
		defer activity.ClearSession(ctx)
	}

	// Any statement in the batch that returns rows sends the whole batch down
	// the query path: Exec would run it all and throw those rows away, which is
	// what `use db; select …` used to do.
	if batchReturnsRows(stmt) {
		// The editor's SQL is the user's own text and must not be rewritten, so
		// the text cap here is applied while scanning. It keeps the grid
		// responsive; it cannot keep the bytes off the wire.
		sets, more, err := driver.RunQueryAll(ctx, conn, stmt, opts)
		out.Results, out.MoreResults = sets, more
		return err
	}
	rs, err := driver.Exec(ctx, conn, stmt)
	if err != nil {
		return err
	}
	out.Results = []*driver.ResultSet{rs}
	return nil
}
